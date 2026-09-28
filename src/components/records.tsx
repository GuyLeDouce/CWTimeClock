'use client';
import { FormEvent, useState } from 'react';
import { DateTime } from 'luxon';
import { correctionTimestamp } from '@/lib/time';
import { Check, Download, Filter, Pencil, Send } from 'lucide-react';
import { api, useApi, time, date, duration } from '@/lib/client';
import type { Options, RecordRow } from '@/lib/client-types';
import { Loading, ErrorBox, Success, Badge, Modal, Empty, ActionButton } from './ui';
// Map.groupBy is ES2024 and throws at runtime on Safari <18 / iOS 17, which this
// phone-first PWA must support. This helper provides the same grouping on ES2022.
function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
export function RecordsScreen({ kind, owner }: { kind: 'verify' | 'send'; owner: boolean }) {
  const { data: options, error } = useApi<Options>('options');
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">{kind === 'verify' ? 'PROJECT MANAGER' : 'ACCOUNTING'}</span>
        <h1>{kind === 'verify' ? 'A week well accounted for.' : 'Ready for the next step.'}</h1>
        <p>
          {kind === 'verify'
            ? 'Review, correct, and approve completed weeks.'
            : 'Send approved time to accounting with a clear paper trail.'}
        </p>
      </div>
      <ErrorBox message={error} />
      {options ? <RecordWorkspace options={options} kind={kind} owner={owner} /> : <Loading />}
    </>
  );
}
function RecordWorkspace({
  options,
  kind,
  owner,
}: {
  options: Options;
  kind: 'verify' | 'send';
  owner: boolean;
}) {
  const zone = options.timezone;
  const [filters, setFilters] = useState({
    from: DateTime.fromISO(options.previousWeek.start).setZone(zone).toISODate()!,
    to: DateTime.fromISO(options.previousWeek.end).setZone(zone).minus({ days: 1 }).toISODate()!,
    employee: '',
    jobsite: '',
    task: '',
    code: '',
    status: kind === 'send' ? 'PM_APPROVED' : '',
    pm: '',
    type: '',
  });
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
  const { data, error, refresh } = useApi<{ records: RecordRow[] }>(`records?${query}`);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [editing, setEditing] = useState<RecordRow | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(''),
    [message, setMessage] = useState(''),
    [batchId, setBatchId] = useState(''),
    [override, setOverride] = useState(false),
    [reason, setReason] = useState('');
  const [sort, setSort] = useState('employee');
  const [descending, setDescending] = useState(false);
  function sortValue(r: RecordRow) {
    return sort === 'jobsite'
      ? r.jobsite.name
      : sort === 'date'
        ? r.effectiveStart
        : sort === 'code'
          ? (r.accountingCode?.code ?? 'TRAVEL')
          : `${r.user.lastName} ${r.user.firstName}`;
  }
  const records = [...(data?.records ?? [])].sort(
      (a, b) =>
        (descending ? -1 : 1) *
        (sortValue(a).localeCompare(sortValue(b)) ||
          a.effectiveStart.localeCompare(b.effectiveStart)),
    ),
    rows = records.filter((r) => selected.has(r.id)),
    total = records.reduce(
      (s, r) =>
        s + Math.max(0, +(r.end ? new Date(r.end) : new Date()) - +new Date(r.effectiveStart)),
      0,
    );
  function change(name: keyof typeof filters, value: string) {
    setFilters((f) => ({ ...f, [name]: value }));
    setSelected(new Set());
  }
  function toggle(ids: string[]) {
    setSelected((previous) => {
      const next = new Set(previous);
      const all = ids.every((id) => next.has(id));
      ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
      return next;
    });
  }
  function eligible(r: RecordRow) {
    return (
      !!r.end &&
      (kind === 'verify'
        ? ['RECORDED', 'PENDING_PM_APPROVAL'].includes(r.status)
        : r.status === 'PM_APPROVED' || (override && r.status !== 'EXPORTED'))
    );
  }
  async function submit() {
    setBusy(true);
    setActionError('');
    setMessage('');
    try {
      const chosen = rows.filter(eligible).map((r) => ({ id: r.id, version: r.version }));
      if (kind === 'verify') {
        const result = await api<{ count: number }>('records/approve', { records: chosen });
        setMessage(`${result.count} records approved.`);
      } else {
        const result = await api<{ id: string; count: number }>('exports/create', {
          records: chosen,
          ...(override ? { overrideReason: reason } : {}),
        });
        setBatchId(result.id);
        setMessage(`${result.count} records finalized. Download your CSV below.`);
      }
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const grouped =
    kind === 'send'
      ? new Map([['Accounting records', records]])
      : groupBy(records, (r) => `${r.user.firstName} ${r.user.lastName} · ${r.userId}`);
  return (
    <>
      <section className="card filter-card">
        <div className="filters">
          <label>
            From
            <input
              type="date"
              value={filters.from}
              onChange={(e) => change('from', e.target.value)}
            />
          </label>
          <label>
            To
            <input type="date" value={filters.to} onChange={(e) => change('to', e.target.value)} />
          </label>
          <label>
            Employee
            <select
              aria-label="Employee"
              value={filters.employee}
              onChange={(e) => change('employee', e.target.value)}
            >
              <option value="">All employees</option>
              {options.employees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jobsite
            <select value={filters.jobsite} onChange={(e) => change('jobsite', e.target.value)}>
              <option value="">All jobsites</option>
              {options.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details>
          <summary>
            <Filter size={15} /> More filters
          </summary>
          <div className="filters">
            <label>
              Task
              <select value={filters.task} onChange={(e) => change('task', e.target.value)}>
                <option value="">All tasks</option>
                {options.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Accounting code
              <select value={filters.code} onChange={(e) => change('code', e.target.value)}>
                <option value="">All codes</option>
                {options.codes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.description}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={filters.status} onChange={(e) => change('status', e.target.value)}>
                <option value="">All statuses</option>
                {['RECORDED', 'PENDING_PM_APPROVAL', 'PM_APPROVED', 'EXPORTED'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Work type
              <select value={filters.type} onChange={(e) => change('type', e.target.value)}>
                <option value="">All work</option>
                {['SHOP', 'SITE', 'OFFICE', 'TRAVEL'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              PM approver
              <select value={filters.pm} onChange={(e) => change('pm', e.target.value)}>
                <option value="">All approvers</option>
                {options.pms.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.firstName} {u.lastName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      </section>
      <ErrorBox message={error || actionError} />
      <Success message={message} />
      <div className="records-toolbar">
        <div>
          <strong>{records.length}</strong> records ·{' '}
          <strong>{(total / 3600000).toFixed(2)}</strong> hrs
        </div>
        <div className="button-row">
          {kind === 'send' && (
            <>
              <select
                aria-label="Sort accounting records"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="employee">Sort: employee</option>
                <option value="jobsite">Sort: jobsite</option>
                <option value="date">Sort: date</option>
                <option value="code">Sort: accounting code</option>
              </select>
              <button onClick={() => setDescending(!descending)}>
                {descending ? 'Descending' : 'Ascending'}
              </button>
            </>
          )}
          <button onClick={() => toggle(records.filter(eligible).map((r) => r.id))}>
            Select all eligible
          </button>
          <button
            className="primary"
            disabled={
              busy || rows.filter(eligible).length === 0 || (override && reason.length < 10)
            }
            onClick={submit}
          >
            {kind === 'verify' ? <Check size={18} /> : <Download size={18} />}{' '}
            {busy
              ? 'Saving…'
              : kind === 'verify'
                ? `Approve ${rows.filter(eligible).length} selected`
                : `Finalize ${rows.filter(eligible).length} & create CSV`}
          </button>
        </div>
      </div>
      {kind === 'send' && owner && (
        <details className="override">
          <summary>Owner override</summary>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />{' '}
            Allow unapproved records in this export
          </label>
          {override && (
            <label>
              Required reason (audited)
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={10}
                placeholder="Why is an approval override needed?"
              />
            </label>
          )}
        </details>
      )}
      {batchId && (
        <a className="button primary" href={`/api/export/download?id=${batchId}`}>
          <Download size={18} /> Download finalized CSV
        </a>
      )}
      {!data ? (
        <Loading />
      ) : !records.length ? (
        <Empty title="Nothing to review here">
          Try a different date range or check your assignments.
        </Empty>
      ) : (
        [...grouped].map(([key, employeeRows]) => (
          <section className="record-group" key={key}>
            <div className="group-heading">
              <h2>
                {kind === 'send'
                  ? 'Accounting records'
                  : `${employeeRows[0].user.firstName} ${employeeRows[0].user.lastName}`}
              </h2>
              <button
                className="small-button"
                onClick={() => toggle(employeeRows.filter(eligible).map((r) => r.id))}
              >
                {kind === 'send' ? 'Select report' : 'Select employee week'}
              </button>
            </div>
            {[
              ...(kind === 'send'
                ? new Map([['report', employeeRows]])
                : groupBy(employeeRows, (r) =>
                    DateTime.fromISO(r.effectiveStart).setZone(zone).toISODate(),
                  )),
            ].map(([day, dayRows]) => (
              <div key={day}>
                {kind === 'verify' && (
                  <div className="day-heading">
                    <span>{date(dayRows[0].effectiveStart, zone)}</span>
                    <button
                      className="text-button"
                      onClick={() => toggle(dayRows.filter(eligible).map((r) => r.id))}
                    >
                      Select day
                    </button>
                  </div>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <span className="sr-only">Select</span>
                        </th>
                        <th>Project / task</th>
                        {kind === 'send' && <th>Employee / date</th>}
                        <th>Start – end</th>
                        <th>Labour</th>
                        <th>Travel</th>
                        <th>Code</th>
                        <th>Status</th>
                        <th>Notes / approval</th>
                        {kind === 'verify' && <th>Edit</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {dayRows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              aria-label={`Select ${r.jobsite.name} ${time(r.effectiveStart, zone)}`}
                              type="checkbox"
                              disabled={!eligible(r)}
                              checked={selected.has(r.id)}
                              onChange={() => toggle([r.id])}
                            />
                          </td>
                          <td>
                            <strong>{r.jobsite.name}</strong>
                            <small>
                              {r.type === 'TRAVEL' ? 'TRAVEL' : (r.task?.name ?? r.type)}
                            </small>
                          </td>
                          <td className="nowrap">
                            {kind === 'send' && (
                              <>
                                <strong>
                                  {r.user.firstName} {r.user.lastName}
                                </strong>
                                <small>{date(r.effectiveStart, zone)}</small>
                              </>
                            )}
                            {kind === 'verify' && (
                              <>
                                {time(r.effectiveStart, zone)} – {time(r.end, zone)}
                              </>
                            )}
                          </td>
                          {kind === 'send' && (
                            <td className="nowrap">
                              {time(r.effectiveStart, zone)} – {time(r.end, zone)}
                            </td>
                          )}
                          <td>{r.type !== 'TRAVEL' ? duration(r.effectiveStart, r.end) : '—'}</td>
                          <td>{r.type === 'TRAVEL' ? duration(r.effectiveStart, r.end) : '—'}</td>
                          <td>
                            {r.accountingCode?.code ??
                              (r.type === 'TRAVEL' ? (
                                'TRAVEL'
                              ) : (
                                <span className="needs-code">Required</span>
                              ))}
                          </td>
                          <td>
                            <Badge value={r.status} />
                          </td>
                          <td>
                            <span className="small">{r.notes || '—'}</span>
                            {r.approvals.find((a) => a.segmentVersion === r.version) && (
                              <small>
                                {r.approvals[0].approver.firstName} ·{' '}
                                {date(r.approvals[0].createdAt, zone)}
                              </small>
                            )}
                          </td>
                          {kind === 'verify' && (
                            <td>
                              <button
                                className="icon-button"
                                aria-label="Edit record"
                                disabled={r.status === 'EXPORTED'}
                                onClick={() => setEditing(r)}
                              >
                                <Pencil size={17} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        ))
      )}
      {editing &&
        (editing.end ? (
          <EditRecord
            record={editing}
            options={options}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await refresh();
            }}
          />
        ) : (
          <CloseShift
            record={editing}
            zone={zone}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await refresh();
            }}
          />
        ))}
      {kind === 'send' && <ExportHistory key={batchId} zone={zone} />}
    </>
  );
}
function EditRecord({
  record: r,
  options,
  onClose,
  onSaved,
}: {
  record: RecordRow;
  options: Options;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const start = correctionTimestamp(String(f.get('start')), r.effectiveStart, options.timezone),
        end = correctionTimestamp(String(f.get('end')), r.end!, options.timezone);
      await api('records/edit', {
        id: r.id,
        version: r.version,
        userId: f.get('userId'),
        jobsiteId: f.get('jobsiteId'),
        taskId: f.get('taskId') || null,
        effectiveStart: start,
        end,
        accountingCodeId: f.get('code') || null,
        notes: f.get('notes'),
        reason: f.get('reason'),
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Correct a time record" onClose={onClose}>
      <p className="muted small">
        Original scan: {date(r.originalStart, options.timezone)} at{' '}
        {time(r.originalStart, options.timezone)}. Corrections are audited and require reapproval.
        Times below use {options.timezone}.
      </p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Employee
            <select name="userId" defaultValue={r.userId}>
              {options.employees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jobsite
            <select name="jobsiteId" defaultValue={r.jobsiteId}>
              {options.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Task
            <select
              name="taskId"
              defaultValue={r.taskId ?? ''}
              disabled={r.type === 'TRAVEL' || r.type === 'OFFICE'}
            >
              <option value="">None</option>
              {options.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Accounting code
            <select name="code" defaultValue={r.accountingCodeId ?? ''}>
              <option value="">{r.type === 'TRAVEL' ? 'Travel' : 'Select code'}</option>
              {options.codes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.description}
                </option>
              ))}
            </select>
          </label>
          <label>
            Paid start
            <input
              type="datetime-local"
              step="1"
              name="start"
              required
              defaultValue={DateTime.fromISO(r.effectiveStart)
                .setZone(options.timezone)
                .toFormat("yyyy-MM-dd'T'HH:mm:ss")}
            />
          </label>
          <label>
            End
            <input
              type="datetime-local"
              step="1"
              name="end"
              required
              defaultValue={DateTime.fromISO(r.end!)
                .setZone(options.timezone)
                .toFormat("yyyy-MM-dd'T'HH:mm:ss")}
            />
          </label>
        </div>
        <label>
          Notes
          <textarea name="notes" defaultValue={r.notes} />
        </label>
        <label>
          Reason for correction
          <input
            name="reason"
            minLength={5}
            maxLength={1000}
            required
            placeholder="Explain the change"
          />
        </label>
        <ErrorBox message={error} />
        <button className="primary full" disabled={busy}>
          {busy ? 'Saving…' : 'Save correction'}
        </button>
      </form>
    </Modal>
  );
}
function ExportHistory({ zone }: { zone: string }) {
  const { data, error } = useApi<{
    batches: { id: string; createdAt: string; reason: string | null; _count: { items: number } }[];
  }>('exports');
  return (
    <section className="export-history">
      <div className="section-title">
        <h2>Finalized exports</h2>
        <span>Saved snapshots</span>
      </div>
      <ErrorBox message={error} />
      {data?.batches.map((b) => (
        <div className="card export-row" key={b.id}>
          <div>
            <strong>{date(b.createdAt, zone)}</strong>
            <p>
              {b._count.items} records · {b.id.slice(-8)}
            </p>
          </div>
          <a className="button" href={`/api/export/download?id=${b.id}`}>
            <Download size={16} /> CSV
          </a>
          <ActionButton action={() => api('exports/email', { id: b.id })}>
            <Send size={16} /> Email report
          </ActionButton>
        </div>
      ))}
    </section>
  );
}

function CloseShift({
  record,
  zone,
  onClose,
  onSaved,
}: {
  record: RecordRow;
  zone: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Close a forgotten shift" onClose={onClose}>
      <p>
        The employee’s active shift will close at the time you enter. Their original scan is
        preserved; no end scan is invented. The correction requires PM approval before export.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const f = new FormData(e.currentTarget);
          try {
            const end = DateTime.fromISO(String(f.get('end')), { zone });
            if (!end.isValid) throw new Error('Enter a valid end time.');
            await api('records/close-day', {
              id: record.id,
              version: record.version,
              end: end.toISO(),
              reason: f.get('reason'),
            });
            await onSaved();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to close shift.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Actual work end ({zone})<input name="end" type="datetime-local" required />
        </label>
        <label>
          Reason and source of the corrected time
          <textarea name="reason" minLength={10} maxLength={1000} required />
        </label>
        <ErrorBox message={error} />
        <button className="primary full" disabled={busy}>
          {busy ? 'Saving…' : 'Close shift with audit record'}
        </button>
      </form>
    </Modal>
  );
}

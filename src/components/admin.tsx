'use client';
import { FormEvent, useState } from 'react';
import { Plus, Pencil, QrCode, Printer, Upload, Download } from 'lucide-react';
import { api, useApi, date, time, pretty } from '@/lib/client';
import type { AdminData } from '@/lib/client-types';
import { ErrorBox, Success, Loading, Modal, ActionButton, Empty } from './ui';
type Tab =
  | 'employees'
  | 'jobsites'
  | 'tasks'
  | 'codes'
  | 'trucks'
  | 'mappings'
  | 'qrs'
  | 'settings'
  | 'audit'
  | 'import';
type Item = Record<string, unknown>;
const labels: Record<Tab, string> = {
  employees: 'Employees & permissions',
  jobsites: 'Jobsites',
  tasks: 'Tasks',
  codes: 'Accounting codes',
  trucks: 'Trucks',
  mappings: 'Code mappings',
  qrs: 'QR codes',
  settings: 'Time & report settings',
  audit: 'Audit log',
  import: 'CSV import',
};
export function AdminScreen({ zone }: { zone: string }) {
  const { data, error, refresh } = useApi<AdminData>('admin');
  const [tab, setTab] = useState<Tab>('employees'),
    [editing, setEditing] = useState<Item | undefined | null>(null);
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">ADMINISTRATION</span>
        <h1>A well-organized workday.</h1>
        <p>Set up your team, projects, and the details that keep things moving.</p>
      </div>
      <div className="admin-layout">
        <nav className="admin-tabs" aria-label="Admin sections">
          {(Object.keys(labels) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {labels[t]}
            </button>
          ))}
        </nav>
        <div className="admin-content">
          <ErrorBox message={error} />
          {!data ? (
            <Loading />
          ) : (
            <>
              <div className="section-title">
                <h2>{labels[tab]}</h2>
                {['employees', 'jobsites', 'tasks', 'codes', 'trucks', 'mappings'].includes(
                  tab,
                ) && (
                  <button className="primary" onClick={() => setEditing(undefined)}>
                    <Plus size={18} /> Add new
                  </button>
                )}
              </div>
              {tab === 'qrs' ? (
                <QrAdmin data={data} refresh={refresh} />
              ) : tab === 'settings' ? (
                <Settings data={data} refresh={refresh} />
              ) : tab === 'import' ? (
                <CsvImport refresh={refresh} />
              ) : tab === 'audit' ? (
                <Audit data={data} zone={zone} />
              ) : (
                <>
                  <p className="muted small">
                    {tab === 'employees'
                      ? 'Work modes can be combined. PM access requires both assigned employees and assigned projects.'
                      : 'Deactivate completed items to preserve their history.'}
                  </p>
                  <div className="card table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{tab === 'employees' ? 'Employee' : 'Name / code'}</th>
                          <th>Details</th>
                          <th>Status</th>
                          <th>Edit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data[tab] as unknown as Item[]).map((item) => (
                          <tr key={String(item.id)}>
                            <td>
                              <strong>
                                {String(
                                  item.firstName
                                    ? `${item.firstName} ${item.lastName}`
                                    : (item.name ??
                                        item.code ??
                                        (item.accountingCode as Item)?.code),
                                )}
                              </strong>
                              {item.email ? <small>{String(item.email)}</small> : null}
                            </td>
                            <td>
                              {tab === 'employees'
                                ? (item.roles as string[]).join(', ')
                                : String(
                                    item.number ??
                                      item.description ??
                                      (item.jobsite as Item)?.name ??
                                      '',
                                  )}
                              {tab === 'mappings' && (
                                <small>{String((item.task as Item)?.name ?? 'All tasks')}</small>
                              )}
                            </td>
                            <td>{item.active === false ? 'Inactive' : 'Active'}</td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label="Edit"
                                onClick={() => setEditing(item)}
                              >
                                <Pencil size={18} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!(data[tab] as unknown[]).length && <Empty title="Ready for your first entry" />}
                </>
              )}
              {editing !== null && (
                <EntityEditor
                  tab={tab}
                  item={editing}
                  data={data}
                  onClose={() => setEditing(null)}
                  onSaved={async () => {
                    setEditing(null);
                    await refresh();
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
function selections(item: Item | undefined, field: string, key: string) {
  return ((item?.[field] ?? []) as Item[]).map((v) => String(v[key]));
}
function CheckList({
  label,
  name,
  options,
  selected = [],
}: {
  label: string;
  name: string;
  options: { id: string; label: string }[];
  selected?: string[];
}) {
  return (
    <fieldset className="check-list">
      <legend>{label}</legend>
      {options.map((o) => (
        <label className="checkbox" key={o.id}>
          <input
            name={name}
            value={o.id}
            type="checkbox"
            defaultChecked={selected.includes(o.id)}
          />
          {o.label}
        </label>
      ))}
      {!options.length && <p className="muted small">Add entries in Admin first.</p>}
    </fieldset>
  );
}
function EntityEditor({
  tab,
  item,
  data,
  onClose,
  onSaved,
}: {
  tab: Tab;
  item?: Item;
  data: AdminData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const v = (name: string, fallback = '') => String(item?.[name] ?? fallback);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    let fields: Item = {};
    if (tab === 'employees')
      fields = {
        firstName: f.get('firstName'),
        lastName: f.get('lastName'),
        email: f.get('email'),
        earliestStart: f.get('earliestStart'),
        timezone: f.get('timezone') || null,
        roles: f.getAll('roles'),
        jobsiteIds: f.getAll('jobsiteIds'),
        taskIds: f.getAll('taskIds'),
        employeeIds: f.getAll('employeeIds'),
        managedJobsiteIds: f.getAll('managedJobsiteIds'),
        active: f.has('active'),
      };
    if (tab === 'jobsites')
      fields = {
        name: f.get('name'),
        number: f.get('number'),
        address: f.get('address'),
        overhead: f.has('overhead'),
        active: f.has('active'),
        taskIds: f.getAll('taskIds'),
      };
    if (tab === 'tasks' || tab === 'trucks')
      fields = { name: f.get('name'), active: f.has('active') };
    if (tab === 'codes')
      fields = { code: f.get('code'), description: f.get('description'), active: f.has('active') };
    if (tab === 'mappings')
      fields = {
        jobsiteId: f.get('jobsiteId') || null,
        taskId: f.get('taskId') || null,
        accountingCodeId: f.get('accountingCodeId'),
      };
    try {
      await api('admin/save', { entity: tab, ...(item?.id ? { id: item.id } : {}), data: fields });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`${item ? 'Edit' : 'Add'} ${labels[tab].toLowerCase()}`} onClose={onClose}>
      <form onSubmit={submit}>
        {tab === 'employees' ? (
          <>
            <div className="form-grid">
              <label>
                First name
                <input name="firstName" defaultValue={v('firstName')} required />
              </label>
              <label>
                Last name
                <input name="lastName" defaultValue={v('lastName')} required />
              </label>
              <label>
                Email
                <input type="email" name="email" defaultValue={v('email')} required />
              </label>
              <label>
                Earliest paid start
                <input
                  type="time"
                  name="earliestStart"
                  defaultValue={v('earliestStart', '07:00')}
                  required
                />
              </label>
            </div>
            <label>
              Timezone <span className="optional">Blank = company default</span>
              <input name="timezone" defaultValue={v('timezone')} placeholder="America/Toronto" />
            </label>
            <CheckList
              label="Work modes & permissions"
              name="roles"
              options={['SHOP', 'SITE', 'OFFICE', 'PM', 'CONTROLLER', 'OWNER', 'ADMIN'].map(
                (id) => ({ id, label: pretty(id) }),
              )}
              selected={(item?.roles ?? []) as string[]}
            />
            <CheckList
              label="Available jobsites / cost centres"
              name="jobsiteIds"
              options={data.jobsites.map((j) => ({ id: j.id, label: j.name }))}
              selected={selections(item, 'jobs', 'jobsiteId')}
            />
            <CheckList
              label="Available tasks"
              name="taskIds"
              options={data.tasks.map((t) => ({ id: t.id, label: t.name }))}
              selected={selections(item, 'tasks', 'taskId')}
            />
            <details>
              <summary>PM approval assignments</summary>
              <p className="small muted">
                Select both the employees and the projects this PM may review.
              </p>
              <CheckList
                label="Assigned employees"
                name="employeeIds"
                options={data.employees.map((u) => ({
                  id: u.id,
                  label: `${u.firstName} ${u.lastName}`,
                }))}
                selected={selections(item, 'managedEmployees', 'employeeId')}
              />
              <CheckList
                label="Assigned projects"
                name="managedJobsiteIds"
                options={data.jobsites.map((j) => ({ id: j.id, label: j.name }))}
                selected={selections(item, 'managedJobs', 'jobsiteId')}
              />
            </details>
          </>
        ) : tab === 'mappings' ? (
          <>
            <p className="muted small">
              Project + task is most specific, followed by project-only, then task-only.
            </p>
            <label>
              Jobsite
              <select name="jobsiteId" defaultValue={v('jobsiteId')}>
                <option value="">Any jobsite</option>
                {data.jobsites.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Task
              <select name="taskId" defaultValue={v('taskId')}>
                <option value="">Any task</option>
                {data.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Accounting code
              <select name="accountingCodeId" defaultValue={v('accountingCodeId')} required>
                <option value="">Select code</option>
                {data.codes
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.description}
                    </option>
                  ))}
              </select>
            </label>
          </>
        ) : tab === 'codes' ? (
          <>
            <label>
              Code
              <input name="code" defaultValue={v('code')} required />
            </label>
            <label>
              Description
              <input name="description" defaultValue={v('description')} required />
            </label>
          </>
        ) : (
          <>
            <label>
              Name
              <input name="name" defaultValue={v('name')} required />
            </label>
            {tab === 'jobsites' && (
              <>
                <label>
                  Project number
                  <input name="number" defaultValue={v('number')} required />
                </label>
                <label>
                  Address
                  <input name="address" defaultValue={v('address')} />
                </label>
                <label className="checkbox">
                  <input type="checkbox" name="overhead" defaultChecked={!!item?.overhead} />{' '}
                  Overhead cost centre
                </label>
                <CheckList
                  label="Available tasks"
                  name="taskIds"
                  options={data.tasks.map((t) => ({ id: t.id, label: t.name }))}
                  selected={selections(item, 'tasks', 'taskId')}
                />
              </>
            )}
          </>
        )}
        {tab !== 'mappings' && (
          <label className="checkbox">
            <input type="checkbox" name="active" defaultChecked={item?.active !== false} /> Active
          </label>
        )}
        <ErrorBox message={error} />
        <button className="primary full" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </form>
      {tab === 'employees' && item?.id ? (
        <div className="reset-account">
          <h3>Account access</h3>
          <p className="small muted">Email a setup/reset link and revoke existing sessions.</p>
          <ActionButton action={() => api('admin/password-reset', { id: item.id })}>
            Send password setup / reset
          </ActionButton>
        </div>
      ) : tab === 'employees' ? (
        <p className="muted small">
          Save the employee, then reopen this record to send a password setup email.
        </p>
      ) : null}
    </Modal>
  );
}
function Settings({ data, refresh }: { data: AdminData; refresh: () => Promise<void> }) {
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const f = new FormData(e.currentTarget);
        try {
          await api('admin/save', {
            entity: 'settings',
            data: {
              timezone: f.get('timezone'),
              reportRecipient: f.get('reportRecipient'),
            },
          });
          setMessage('Settings saved.');
          await refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Unable to save.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Company timezone
        <input
          name="timezone"
          defaultValue={data.settings?.timezone ?? 'America/Toronto'}
          required
        />
      </label>
      <p className="small muted">
        Payroll weeks run Monday through Sunday. Individual start times are set on employee
        profiles. A timezone change affects future reporting boundaries; confirm with accounting
        before changing it.
      </p>
      <label>
        Accounting report email
        <input
          type="email"
          name="reportRecipient"
          defaultValue={data.settings?.reportRecipient ?? ''}
        />
      </label>
      <ErrorBox message={error} />
      <Success message={message} />
      <button className="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
function QrAdmin({ data, refresh }: { data: AdminData; refresh: () => Promise<void> }) {
  const [create, setCreate] = useState(false),
    [qrType, setQrType] = useState('SHOP'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [print, setPrint] = useState<string | null>(null),
    [confirm, setConfirm] = useState<{ id: string; action: 'REVOKE' | 'REGENERATE' } | null>(null);
  return (
    <>
      <button className="primary" onClick={() => setCreate(true)}>
        <Plus size={18} /> Create QR code
      </button>
      <div className="qr-grid">
        {data.qrs
          .filter((q) => q.active)
          .map((q) => (
            <section className="card qr-card" key={q.id}>
              <img
                src={`/api/admin/qr-image?id=${q.id}`}
                alt={`${q.label} QR code`}
                width={200}
                height={200}
              />
              <h3>{q.label}</h3>
              <p className="small muted">{q.type}</p>
              <div className="button-row">
                <button onClick={() => setPrint(q.id)}>
                  <Printer size={16} /> Print
                </button>
                <button onClick={() => setConfirm({ id: q.id, action: 'REGENERATE' })}>
                  Regenerate
                </button>
                <button
                  className="text-button danger"
                  onClick={() => setConfirm({ id: q.id, action: 'REVOKE' })}
                >
                  Revoke
                </button>
              </div>
              <a className="small" href={`/scan/${q.token}`}>
                Open clock screen
              </a>
            </section>
          ))}
      </div>
      {!data.qrs.some((q) => q.active) && <Empty title="Create the shop QR to get started" />}
      {create && (
        <Modal title="Create a QR code" onClose={() => setCreate(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const f = new FormData(e.currentTarget);
              try {
                await api('admin/qr', {
                  action: 'CREATE',
                  type: qrType,
                  label: f.get('label'),
                  ...(qrType === 'TRUCK' ? { truckId: f.get('truckId') } : {}),
                });
                setCreate(false);
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Unable to create QR.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Type
              <select value={qrType} onChange={(e) => setQrType(e.target.value)}>
                <option>SHOP</option>
                <option>TRUCK</option>
              </select>
            </label>
            <label>
              Label
              <input name="label" placeholder="Shop entrance" required />
            </label>
            {qrType === 'TRUCK' && (
              <label>
                Truck
                <select name="truckId" required>
                  <option value="">Select truck</option>
                  {data.trucks
                    .filter((t) => t.active)
                    .map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <ErrorBox message={error} />
            <button className="primary" disabled={busy}>
              <QrCode size={18} />
              {busy ? 'Creating…' : 'Create QR'}
            </button>
          </form>
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm.action === 'REVOKE' ? 'Revoke this QR?' : 'Regenerate this QR?'}
          onClose={() => setConfirm(null)}
        >
          <p>
            The existing printed QR will stop working immediately.
            {confirm.action === 'REGENERATE'
              ? ' Print the replacement before employees use it.'
              : ''}
          </p>
          <ActionButton
            className="primary"
            action={() => api('admin/qr', confirm)}
            onDone={() => {
              setConfirm(null);
              void refresh();
            }}
          >
            Confirm {confirm.action.toLowerCase()}
          </ActionButton>
        </Modal>
      )}
      {print && (
        <Modal title="Print QR code" onClose={() => setPrint(null)}>
          <div className="print-qr">
            <small>CEDAR WINDS DESIGN~BUILD</small>
            <h1>{data.qrs.find((q) => q.id === print)?.label}</h1>
            <img
              src={`/api/admin/qr-image?id=${print}`}
              alt="Timeclock QR code"
              width={320}
              height={320}
            />
            <h2>Scan to record your time.</h2>
            <p>Open your phone camera and point it at the code.</p>
          </div>
          <button className="primary no-print" onClick={() => window.print()}>
            <Printer size={18} /> Print
          </button>
        </Modal>
      )}
    </>
  );
}
function Audit({ data, zone }: { data: AdminData; zone: string }) {
  return (
    <>
      <p className="small muted">Latest 200 events. Original and changed values are retained.</p>
      <div className="audit-list">
        {data.logs.map((log) => (
          <details className="card" key={log.id}>
            <summary>
              <strong>{log.action.replaceAll('_', ' ')}</strong>
              <span>
                {date(log.createdAt, zone)} · {time(log.createdAt, zone)}
              </span>
            </summary>
            <p>
              {log.actor ? `${log.actor.firstName} ${log.actor.lastName}` : 'System'} · {log.entity}{' '}
              · {log.entityId}
            </p>
            {log.reason && (
              <p>
                <strong>Reason:</strong> {log.reason}
              </p>
            )}
            <div className="form-grid">
              <div>
                <h4>Before</h4>
                <pre>{JSON.stringify(log.before, null, 2)}</pre>
              </div>
              <div>
                <h4>After</h4>
                <pre>{JSON.stringify(log.after, null, 2)}</pre>
              </div>
            </div>
          </details>
        ))}
      </div>
    </>
  );
}
function CsvImport({ refresh }: { refresh: () => Promise<void> }) {
  const [entity, setEntity] = useState('employees'),
    [content, setContent] = useState(''),
    [preview, setPreview] = useState<{
      rows: Item[];
      errors: { row: number; message: string }[];
      previewToken: string;
      count: number;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function run(commit: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await api<typeof preview & { count: number }>('admin/import', {
        entity,
        csv: content,
        commit,
        ...(commit ? { previewToken: preview?.previewToken } : {}),
      });
      if (commit) {
        setMessage(`${result?.count} records imported.`);
        setContent('');
        setPreview(null);
        await refresh();
      } else setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to import.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card import-card">
      <p>
        Download a template, fill it in, and preview before importing. Existing records and
        duplicate rows are reported as errors. Nothing is imported until every row passes.
      </p>
      <label>
        Import type
        <select
          value={entity}
          onChange={(e) => {
            setEntity(e.target.value);
            setPreview(null);
          }}
        >
          {['employees', 'jobsites', 'tasks', 'codes'].map((t) => (
            <option key={t} value={t}>
              {labels[t as Tab]}
            </option>
          ))}
        </select>
      </label>
      <a className="button" href={`/api/admin/template?entity=${entity}`}>
        <Download size={17} /> Download template
      </a>
      <label className="file-upload">
        <Upload size={22} /> Choose CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) {
              if (file.size > 200000) {
                setError('Maximum file size is 200 KB.');
                return;
              }
              setContent(await file.text());
              setPreview(null);
              setMessage('');
            }
          }}
        />
      </label>
      <textarea
        aria-label="CSV contents"
        rows={6}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setPreview(null);
        }}
        placeholder="Or paste your CSV here"
      />
      <ErrorBox message={error} />
      <Success message={message} />
      <button disabled={busy || !content} onClick={() => run(false)}>
        {busy ? 'Checking…' : 'Preview & validate'}
      </button>
      {preview && (
        <>
          <h3>
            {preview.count} rows · {preview.errors.length} errors
          </h3>
          {preview.errors.map((e, i) => (
            <ErrorBox key={i} message={`Row ${e.row}: ${e.message}`} />
          ))}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{String(r.row)}</td>
                    <td>
                      {Object.entries(r)
                        .filter(([k]) => k !== 'row')
                        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' | ') : String(v)}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="primary"
            disabled={busy || preview.errors.length > 0}
            onClick={() => run(true)}
          >
            Confirm import of {preview.count} records
          </button>
        </>
      )}
    </section>
  );
}

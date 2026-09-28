'use client';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Clock3,
  Coffee,
  LogOut,
  MapPin,
  QrCode,
  Truck,
} from 'lucide-react';
import { time, duration, pretty, dayHeading } from '@/lib/client';
import { submitPunch, queueCount, type PunchAction } from '@/lib/offline';
import { validZone } from '@/lib/time';
import type { State } from '@/lib/client-types';
import { ErrorBox, Success, Badge } from './ui';
export function ClockScreen({
  data,
  token,
  refresh,
}: {
  data: State;
  token?: string;
  refresh: () => Promise<void>;
}) {
  const current = data.current;
  const [mode, setMode] = useState<string>(
      current
        ? current.type === 'TRAVEL'
          ? 'SITE'
          : current.type
        : data.modes.length === 1
          ? data.modes[0]
          : '',
    ),
    [job, setJob] = useState(current?.jobsiteId ?? ''),
    [task, setTask] = useState(current?.taskId ?? ''),
    [notes, setNotes] = useState(''),
    [switching, setSwitching] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [offline, setOffline] = useState(false);
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    const syncQueue = () => setQueued(queueCount());
    syncQueue();
    window.addEventListener('cw:queue-changed', syncQueue);
    return () => window.removeEventListener('cw:queue-changed', syncQueue);
  }, []);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    const online = () => setOffline(!navigator.onLine);
    online();
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
    };
  }, []);
  useEffect(() => {
    setJob(current?.jobsiteId ?? '');
    setTask(current?.taskId ?? '');
    setSwitching(false);
    if (current?.type) setMode(current.type === 'TRAVEL' ? 'SITE' : current.type);
  }, [current?.id, current?.jobsiteId, current?.taskId, current?.type]);
  const arrival = current?.type === 'TRAVEL';
  const availableTasks = data.tasks.filter((t) => t.jobs.some((j) => j.jobsiteId === job));
  const switchingMode = switching && data.qr?.type === 'SHOP' && mode !== current?.type;
  const travelSwitch =
    !!current &&
    (switchingMode ? mode === 'SITE' : current.type === 'SITE' && job !== current.jobsiteId);
  const effectiveMode = switchingMode ? mode : (current?.type ?? mode);
  const needsTask = current
    ? arrival || effectiveMode === 'SHOP' || (effectiveMode === 'SITE' && !travelSwitch)
    : mode === 'SHOP';
  const timezoneValid = validZone(data.timezone) && validZone(data.companyTimezone);
  // Offline punches are queued and replayed, so the buttons stay enabled.
  const punchLabel = (live: string) =>
    busy ? 'Recording…' : offline ? `Queue ${live.toLowerCase()}` : live;
  const canSubmit =
    timezoneValid &&
    !!job &&
    (!needsTask || !!task) &&
    !!token &&
    !(switching && current?.type === 'SITE' && data.qr?.type === 'SHOP' && !switchingMode);
  async function submit(action: PunchAction) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await submitPunch({
        qrToken: token!,
        action,
        expectedSegmentId: current?.id ?? null,
        ...(mode ? { mode } : {}),
        jobsiteId: job,
        taskId: needsTask ? task : null,
        notes,
      });
      if (result.status === 'queued') {
        setSuccess(result.message);
      } else {
        setSuccess(result.message);
        setNotes('');
        setSwitching(false);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  function selections() {
    return (
      <>
        <label>
          {current?.type === 'OFFICE' || mode === 'OFFICE' ? 'Project / cost centre' : 'Jobsite'}
          <select
            aria-label={
              current?.type === 'OFFICE' || mode === 'OFFICE' ? 'Project / cost centre' : 'Jobsite'
            }
            value={job}
            onChange={(e) => {
              setJob(e.target.value);
              setTask('');
            }}
          >
            <option value="">Select a jobsite</option>
            {data.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>
        {needsTask && (
          <label>
            Task
            <select
              aria-label="Task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={!job}
            >
              <option value="">Select your task</option>
              {availableTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {travelSwitch && (
          <div className="notice">
            <Truck size={20} />
            <span>
              Changing jobsites starts travel time. Scan the truck QR again when you arrive.
            </span>
          </div>
        )}
        <label>
          Notes <span className="optional">Optional</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the team should know?"
            rows={2}
            maxLength={2000}
          />
        </label>
      </>
    );
  }
  return (
    <div className="clock-wrap">
      <div className="page-heading">
        <span className="eyebrow">{dayHeading(data.serverNow, data.timezone)}</span>
        <h1>{current ? 'Your day is underway.' : `Good morning, ${data.user.firstName}.`}</h1>
        <p>{current ? 'Keep it simple. One job at a time.' : 'Let’s get your day started.'}</p>
      </div>
      <ErrorBox message={error} />
      <ErrorBox
        message={
          timezoneValid
            ? ''
            : 'A timezone setting needs attention. Ask an administrator to correct the employee or company timezone in Admin.'
        }
      />
      <Success message={success} />
      {current && (
        <section className="current-card">
          <div className="row-between">
            <Badge value={current.type} />
            <span className="live-dot">Clocked in</span>
          </div>
          <h2>{current.jobsite.name}</h2>
          <p>
            {current.task?.name ??
              (current.type === 'TRAVEL'
                ? `Travelling from ${current.travelOrigin ?? 'the shop'}`
                : pretty(current.type) + ' work')}
          </p>
          <div className="current-time">
            <Clock3 size={19} />
            <span>Started {time(current.effectiveStart, data.timezone)}</span>
            <strong>
              {duration(current.effectiveStart)} <small>hrs</small>
            </strong>
          </div>
          {new Date(current.effectiveStart) > new Date(data.serverNow) && (
            <p className="small">
              Paid time starts at {time(current.effectiveStart, data.timezone)}.
            </p>
          )}
        </section>
      )}
      {!token ? (
        <section className="card scan-prompt">
          <span className="large-icon">
            <QrCode size={36} />
          </span>
          <h2>{current ? 'Ready for your next move?' : 'Scan the shop QR.'}</h2>
          <p>
            {current
              ? current.type === 'SITE' || current.type === 'TRAVEL'
                ? 'Scan a truck QR to record arrival, switch work, or clock out.'
                : 'Scan the shop QR to switch work or clock out.'
              : 'Use your phone’s camera to scan the QR code at the shop. Your work options will appear here.'}
          </p>
          <div className="quiet-note">
            <CheckCircle2 size={17} /> Signed in and ready to go
          </div>
        </section>
      ) : !current && data.qr?.type === 'TRUCK' ? (
        <section className="card scan-prompt">
          <Coffee size={36} />
          <h2>Start at the shop.</h2>
          <p>Scan the shop QR to begin your day before using a truck QR.</p>
        </section>
      ) : !current ? (
        <section className="card clock-form">
          <div className="section-caption">
            <MapPin size={18} />
            {data.qr?.label}
          </div>
          {data.modes.length > 1 && (
            <>
              <h2>Where are you working?</h2>
              <div className="mode-picker">
                {data.modes.map((m) => (
                  <button
                    type="button"
                    key={m}
                    onClick={() => {
                      setMode(m);
                      setTask('');
                    }}
                    className={mode === m ? 'selected' : ''}
                  >
                    {pretty(m)}
                  </button>
                ))}
              </div>
            </>
          )}
          {data.modes.length === 0 ? (
            <p>
              No clock-in work mode is assigned. Ask your administrator if you need to record time.
            </p>
          ) : (
            mode && (
              <>
                {selections()}
                <button
                  className="primary punch"
                  disabled={busy || !canSubmit}
                  onClick={() => submit('CLOCK_IN')}
                >
                  {punchLabel('CLOCK IN')}
                  <ArrowRight size={22} />
                </button>
              </>
            )
          )}
        </section>
      ) : arrival && data.qr?.type === 'TRUCK' ? (
        <section className="card clock-form">
          <div className="section-caption">
            <Truck size={20} />
            {data.qr.label}
          </div>
          <h2>Made it to the jobsite?</h2>
          <p className="muted">Select your task to finish travel and start site work.</p>
          {selections()}
          <button
            className="primary punch"
            disabled={busy || !canSubmit}
            onClick={() => submit('ARRIVED')}
          >
            {punchLabel('ARRIVED')}
            <CheckCircle2 size={22} />
          </button>
          <button className="text-button" disabled={busy} onClick={() => submit('CLOCK_OUT')}>
            Clock out instead
          </button>
        </section>
      ) : switching ? (
        <section className="card clock-form">
          <h2>What’s next?</h2>
          {data.qr?.type === 'SHOP' && data.modes.length > 1 && (
            <div className="mode-picker">
              {data.modes.map((m) => (
                <button
                  type="button"
                  key={m}
                  className={mode === m ? 'selected' : ''}
                  onClick={() => {
                    setMode(m);
                    setTask('');
                  }}
                >
                  {pretty(m)}
                </button>
              ))}
            </div>
          )}
          {selections()}
          <button
            className="primary punch"
            disabled={busy || !canSubmit}
            onClick={() => submit('SWITCH')}
          >
            {punchLabel('SWITCH')}
            <ArrowRightLeft size={22} />
          </button>
          <button className="text-button" onClick={() => setSwitching(false)}>
            Cancel
          </button>
        </section>
      ) : (
        <section className="clock-actions">
          {!arrival &&
            (current.type !== 'SITE' ||
              data.qr?.type === 'TRUCK' ||
              data.modes.some((m) => m !== 'SITE')) && (
              <button
                className="primary punch"
                disabled={busy}
                onClick={() => setSwitching(true)}
              >
                SWITCH
                <ArrowRightLeft size={23} />
              </button>
            )}
          {(arrival || current.type === 'SITE') && data.qr?.type === 'SHOP' && (
            <p className="notice">Use the truck QR to record arrival or switch site work.</p>
          )}
          <button
            className="secondary punch"
            disabled={busy}
            onClick={() => submit('CLOCK_OUT')}
          >
            {punchLabel('CLOCK OUT')}
            <LogOut size={23} />
          </button>
        </section>
      )}
      {queued > 0 && (
        <p className="notice" role="status">
          {queued} queued punch{queued === 1 ? '' : 'es'} will send automatically when you are back
          online.
        </p>
      )}
      <p className="clock-foot">
        {offline
          ? 'Offline: punches are queued with the tap time and sent when you reconnect.'
          : 'Time is recorded only after confirmation.'}
        <br />
        Employee selections and QR scans. No GPS.
      </p>
    </div>
  );
}

'use client';
// Offline punch queue. Punches tapped without connectivity are stored in
// localStorage with their idempotency key and replayed in order when the
// connection returns. The server dedupes by key, so a replayed punch can never
// create a duplicate shift, and each punch carries the client tap time so the
// recorded hours reflect the real shift.
export type PunchAction = 'CLOCK_IN' | 'SWITCH' | 'ARRIVED' | 'CLOCK_OUT';
export type PunchInput = {
  qrToken: string;
  action: PunchAction;
  expectedSegmentId: string | null;
  mode?: string;
  jobsiteId?: string;
  taskId?: string | null;
  notes: string;
};
// Only queued (offline) punches carry clientAt: the tap time, so replayed
// punches record the real shift. Live punches omit it and use server time.
export type QueuedPunch = PunchInput & { key: string; clientAt: string; queuedAt: string };
const STORAGE_KEY = 'cw:queued-punches';
const MAX_QUEUE = 50;
// Notify UI listeners; safe in non-DOM environments (tests, SSR).
function emitQueueChanged() {
  try {
    globalThis.dispatchEvent?.(new Event('cw:queue-changed'));
  } catch {
    // No event system available: listeners simply poll queueCount().
  }
}
function valid(item: unknown): item is QueuedPunch {
  const q = item as QueuedPunch;
  return (
    !!q &&
    typeof q.key === 'string' &&
    typeof q.qrToken === 'string' &&
    typeof q.action === 'string' &&
    typeof q.clientAt === 'string'
  );
}
export function loadQueue(): QueuedPunch[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX_QUEUE) : [];
  } catch {
    return [];
  }
}
function saveQueue(queue: QueuedPunch[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.slice(0, MAX_QUEUE)));
  } catch {
    // Storage full or unavailable: the punch is lost locally, but nothing was
    // sent, so the employee can simply retry. Never throw from here.
  }
}
export function queueCount(): number {
  return loadQueue().length;
}
export function enqueuePunch(input: PunchInput): QueuedPunch {
  const punch: QueuedPunch = {
    ...input,
    key: crypto.randomUUID(),
    clientAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  };
  const queue = loadQueue();
  queue.push(punch);
  saveQueue(queue);
  emitQueueChanged();
  return punch;
}
export class NetworkError extends Error {}
type OutgoingPunch = PunchInput & { key: string; clientAt?: string };
async function postPunch(punch: OutgoingPunch): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/punch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(punch),
      cache: 'no-store',
    });
  } catch {
    throw new NetworkError('No connection.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? 'Request failed.');
  return result.message ?? 'Punch recorded.';
}
// Sends one punch: live when possible, queued when the network is down.
// Server rejections (4xx) are thrown so the UI can show them; network failures
// queue the punch and report it as queued.
export async function submitPunch(
  input: PunchInput,
): Promise<{ status: 'sent' | 'queued'; message: string }> {
  const queuedMessage =
    'No connection. Your punch is queued and will be sent automatically when you are back online.';
  if (!navigator.onLine) {
    enqueuePunch(input);
    return { status: 'queued', message: queuedMessage };
  }
  try {
    const message = await postPunch({ ...input, key: crypto.randomUUID() });
    return { status: 'sent', message };
  } catch (e) {
    if (e instanceof NetworkError) {
      enqueuePunch(input);
      return { status: 'queued', message: queuedMessage };
    }
    throw e;
  }
}
// Replays queued punches in order. Stops at the first failure so a conflict
// never causes later punches to apply out of order; remaining items stay queued.
export async function flushQueue(): Promise<{ sent: number; error: string | null }> {
  let sent = 0;
  for (;;) {
    const queue = loadQueue();
    const next = queue[0];
    if (!next) break;
    try {
      await postPunch(next);
    } catch (e) {
      if (e instanceof NetworkError) return { sent, error: null };
      return { sent, error: e instanceof Error ? e.message : 'Could not send queued punches.' };
    }
    sent++;
    saveQueue(loadQueue().filter((q) => q.key !== next.key));
    emitQueueChanged();
  }
  return { sent, error: null };
}
export function discardQueue() {
  saveQueue([]);
  emitQueueChanged();
}

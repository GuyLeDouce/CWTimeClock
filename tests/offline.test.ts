import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emailSchema } from '../src/lib/validation';
describe('emailSchema', () => {
  it('trims and lowercases before validating', () => {
    expect(emailSchema.parse('  Crew@Example.com  ')).toBe('crew@example.com');
  });
  it('rejects invalid addresses', () => {
    for (const value of ['not-an-email', '@example.com', 'a@', '']) {
      expect(() => emailSchema.parse(value)).toThrow();
    }
  });
  it('rejects non-strings', () => {
    expect(() => emailSchema.parse(null)).toThrow();
    expect(() => emailSchema.parse(42)).toThrow();
  });
});
describe('offline punch queue', () => {
  const store = new Map<string, string>();
  const online = { value: true };
  beforeEach(() => {
    store.clear();
    online.value = true;
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    vi.stubGlobal('navigator', {
      get onLine() {
        return online.value;
      },
    });
    vi.stubGlobal('dispatchEvent', () => {});
  });
  // Import fresh after stubbing globals.
  const lib = () => import('../src/lib/offline');
  const punch = (action: 'CLOCK_IN' | 'CLOCK_OUT' = 'CLOCK_IN') => ({
    qrToken: 'qr-1',
    action,
    expectedSegmentId: null,
    jobsiteId: 'job-1',
    taskId: null,
    notes: '',
  });
  it('queues when the browser reports offline', async () => {
    const { submitPunch, loadQueue } = await lib();
    online.value = false;
    const result = await submitPunch(punch());
    expect(result.status).toBe('queued');
    const queue = loadQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].action).toBe('CLOCK_IN');
    expect(queue[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(queue[0].clientAt).getTime()).not.toBeNaN();
  });
  it('queues when the live request fails at the network layer', async () => {
    const { submitPunch, loadQueue } = await lib();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const result = await submitPunch(punch());
    expect(result.status).toBe('queued');
    expect(loadQueue()).toHaveLength(1);
  });
  it('sends live punches without a client timestamp', async () => {
    const { submitPunch, loadQueue } = await lib();
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return { ok: true, json: async () => ({ message: 'Clocked in.' }) };
      }),
    );
    const result = await submitPunch(punch());
    expect(result.status).toBe('sent');
    expect(result.message).toBe('Clocked in.');
    expect(loadQueue()).toHaveLength(0);
    const sent = JSON.parse(bodies[0]);
    expect(sent.key).toBeDefined();
    expect(sent.clientAt).toBeUndefined();
  });
  it('rethrows server rejections instead of queueing them', async () => {
    const { submitPunch, loadQueue } = await lib();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Already clocked in.' }),
      })),
    );
    await expect(submitPunch(punch())).rejects.toThrow('Already clocked in.');
    expect(loadQueue()).toHaveLength(0);
  });
  it('replays queued punches in order and stops at the first conflict', async () => {
    const { enqueuePunch, flushQueue, loadQueue } = await lib();
    enqueuePunch(punch('CLOCK_IN'));
    enqueuePunch(punch('CLOCK_OUT'));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        calls.push(body.action);
        // Queued punches carry the tap time for honest backdating.
        expect(body.clientAt).toBeDefined();
        if (body.action === 'CLOCK_OUT')
          return { ok: false, json: async () => ({ error: 'Shift already closed.' }) };
        return { ok: true, json: async () => ({ message: 'ok' }) };
      }),
    );
    const result = await flushQueue();
    expect(result).toEqual({ sent: 1, error: 'Shift already closed.' });
    expect(calls).toEqual(['CLOCK_IN', 'CLOCK_OUT']);
    // The conflicted punch stays queued; the sent one is removed.
    expect(loadQueue()).toHaveLength(1);
    expect(loadQueue()[0].action).toBe('CLOCK_OUT');
  });
  it('keeps the queue when the network drops mid-flush', async () => {
    const { enqueuePunch, flushQueue, loadQueue } = await lib();
    enqueuePunch(punch('CLOCK_IN'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const result = await flushQueue();
    expect(result).toEqual({ sent: 0, error: null });
    expect(loadQueue()).toHaveLength(1);
  });
  it('ignores corrupt queue storage', async () => {
    const { loadQueue } = await lib();
    store.set('cw:queued-punches', 'not json{{{');
    expect(loadQueue()).toEqual([]);
  });
});

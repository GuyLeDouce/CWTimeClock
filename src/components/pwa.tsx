'use client';
import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { flushQueue, queueCount } from '@/lib/offline';
export function Pwa() {
  const [offline, setOffline] = useState(false);
  const [queued, setQueued] = useState(0);
  const [flushError, setFlushError] = useState('');
  useEffect(() => {
    const syncQueue = () => setQueued(queueCount());
    const tryFlush = async () => {
      if (!navigator.onLine) return;
      const { sent, error } = await flushQueue();
      if (error) setFlushError(error);
      else {
        if (sent > 0) setFlushError('');
        syncQueue();
      }
    };
    const update = () => {
      const isOffline = !navigator.onLine;
      setOffline(isOffline);
      if (!isOffline) void tryFlush();
    };
    update();
    syncQueue();
    void tryFlush();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener('cw:queue-changed', syncQueue);
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production')
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('cw:queue-changed', syncQueue);
    };
  }, []);
  if (flushError)
    return (
      <div className="offline" role="alert">
        Queued punches could not be sent: {flushError}
      </div>
    );
  if (offline)
    return (
      <div className="offline" role="alert">
        <WifiOff size={19} />{' '}
        {queued > 0
          ? `Offline. ${queued} queued punch${queued === 1 ? '' : 'es'} will send on reconnect.`
          : 'Offline. Punches will be queued and sent on reconnect.'}
      </div>
    );
  return null;
}

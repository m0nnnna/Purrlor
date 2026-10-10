import { useEffect, useState } from 'react';
import { useMatrixClient } from '../matrix/MatrixClientContext';
import { handleFor } from '../matrix/roles';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 12-hour time: `9:41:07 PM`, or `9:41 PM` without seconds. Midnight and noon are 12, not 0. */
export function formatClock12(d: Date, withSeconds = true): string {
  const h = d.getHours() % 12 || 12;
  const seconds = withSeconds ? `:${pad(d.getSeconds())}` : '';
  return `${h}:${pad(d.getMinutes())}${seconds} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** The status block's date line: `2026.10.10 SAT`. */
export function formatClockDate(d: Date): string {
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${DAYS[d.getDay()]}`;
}

function useNow(stepMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs]);
  return now;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * The clock and status lines over the wallpaper's top right, above the member list (the Ultimit
 * desktop's status block). Decorative to a screen reader, which has its own clock: the time is
 * `aria-hidden`, so it doesn't announce itself every second.
 */
export function StatusClock() {
  const mx = useMatrixClient();
  const now = useNow(1000);
  const online = useOnline();
  return (
    <div className="nu-status-clock" data-nu-role="status-clock" aria-hidden="true">
      <div className="nu-status-clock__time">{formatClock12(now)}</div>
      <div className="nu-status-clock__date">{formatClockDate(now)}</div>
      <div className="nu-status-clock__sys">
        <span>
          {online ? 'ONLINE' : 'OFFLINE'}{' '}
          <b className={online ? 'nu-status-clock__dot' : 'nu-status-clock__dot nu-status-clock__dot--off'}>●</b>
        </span>
        <span className="nu-status-clock__user">{handleFor(mx.getUserId() ?? '').toUpperCase()}</span>
      </div>
    </div>
  );
}

/** The same clock, small, at the foot of the server rail: shown when there's no member list to sit above. */
export function RailClock() {
  const now = useNow(10_000);
  const [hm, ampm] = formatClock12(now, false).split(' ');
  return (
    <div className="nu-rail-clock" data-nu-role="rail-clock" aria-hidden="true">
      <span className="nu-rail-clock__time">{hm}</span>
      <span className="nu-rail-clock__ampm">{ampm}</span>
    </div>
  );
}

import type { CalendarEvent } from './calendar';

/** A day as a key that sorts and compares (local time): YYYY-MM-DD. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type MonthCell = {
  /** Local midnight of this day. */
  date: Date;
  key: string;
  day: number;
  /** Whether it's in the month shown, rather than a neighbour filling out its first or last week. */
  inMonth: boolean;
  /** The events that start on it, in order. */
  events: CalendarEvent[];
};

/**
 * The month's weeks, for a grid: whole weeks (so a month starts and ends mid-row), beginning on
 * `weekStart` (0 = Sunday … 6 = Saturday). An event sits on the day it starts. Pure.
 */
export function monthGrid(year: number, month: number, events: CalendarEvent[], weekStart = 0): MonthCell[][] {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of [...events].sort((a, b) => a.start - b.start)) {
    const key = localDayKey(event.start);
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  const rows: MonthCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const row: MonthCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(year, month, 1 - lead + w * 7 + d);
      const key = localDayKey(date.getTime());
      row.push({ date, key, day: date.getDate(), inMonth: date.getMonth() === month, events: byDay.get(key) ?? [] });
    }
    rows.push(row);
  }
  return rows;
}

/** The day a week starts on in the reader's locale (0 = Sunday), Sunday where the browser can't say. */
export function localeWeekStart(locale = typeof navigator === 'undefined' ? undefined : navigator.language): number {
  try {
    const info = (new Intl.Locale(locale ?? 'en-US') as unknown as { weekInfo?: { firstDay?: number }; getWeekInfo?: () => { firstDay?: number } });
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    return typeof firstDay === 'number' ? firstDay % 7 : 0; // Intl: 1 = Monday … 7 = Sunday
  } catch {
    return 0;
  }
}

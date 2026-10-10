import { describe, expect, it } from 'vitest';
import { formatClock12, formatClockDate } from './StatusClock';

describe('formatClock12', () => {
  it('shows afternoon hours on a 12-hour clock', () => {
    expect(formatClock12(new Date(2026, 9, 10, 21, 41, 7))).toBe('9:41:07 PM');
  });

  it('calls midnight 12 AM and noon 12 PM', () => {
    expect(formatClock12(new Date(2026, 9, 10, 0, 5, 0))).toBe('12:05:00 AM');
    expect(formatClock12(new Date(2026, 9, 10, 12, 0, 30))).toBe('12:00:30 PM');
  });

  it('leaves the seconds off when asked', () => {
    expect(formatClock12(new Date(2026, 9, 10, 9, 3, 59), false)).toBe('9:03 AM');
  });
});

describe('formatClockDate', () => {
  it('writes the date the way the status block does', () => {
    expect(formatClockDate(new Date(2026, 9, 10))).toBe('2026.10.10 SAT');
  });
});

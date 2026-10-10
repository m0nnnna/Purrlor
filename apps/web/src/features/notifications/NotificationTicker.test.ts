import { describe, expect, it } from 'vitest';
import { tickerTime } from './NotificationTicker';

describe('tickerTime', () => {
  const now = new Date(2026, 9, 10, 21, 0, 0);

  it('shows today as a 12-hour time', () => {
    expect(tickerTime(new Date(2026, 9, 10, 13, 5).getTime(), now)).toBe('1:05 PM');
  });

  it('shows an earlier day as its date', () => {
    expect(tickerTime(new Date(2026, 9, 7, 9, 0).getTime(), now)).toBe('OCT 07');
  });
});

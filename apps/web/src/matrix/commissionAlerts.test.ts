import { describe, expect, it } from 'vitest';
import { parseAlertList, shouldAlertOpening, withAlert } from './commissionAlerts';

describe('the alert list', () => {
  it('toggles an artist without duplicating them', () => {
    expect(withAlert([], '@a:s', true)).toEqual(['@a:s']);
    expect(withAlert(['@a:s'], '@a:s', true)).toEqual(['@a:s']);
    expect(withAlert(['@a:s', '@b:s'], '@a:s', false)).toEqual(['@b:s']);
  });

  it('reads only user IDs out of account data', () => {
    expect(parseAlertList({ users: ['@a:s', 5, '', null] })).toEqual(['@a:s']);
    expect(parseAlertList(undefined)).toEqual([]);
    expect(parseAlertList({ users: 'x' })).toEqual([]);
  });
});

describe('shouldAlertOpening', () => {
  const now = 1_000_000;
  const change = { sender: '@artist:s', status: 'open', previousStatus: 'closed', ts: now - 5000 };

  it('tells you when an artist you asked about goes from closed to open', () => {
    expect(shouldAlertOpening(change, ['@artist:s'], '@me:s', now)).toBe(true);
    expect(shouldAlertOpening({ ...change, previousStatus: 'waitlist' }, ['@artist:s'], '@me:s', now)).toBe(true);
  });

  it('stays quiet for everything else', () => {
    expect(shouldAlertOpening(change, [], '@me:s', now)).toBe(false);
    expect(shouldAlertOpening({ ...change, status: 'closed' }, ['@artist:s'], '@me:s', now)).toBe(false);
    expect(shouldAlertOpening({ ...change, previousStatus: 'open' }, ['@artist:s'], '@me:s', now)).toBe(false);
    // The first state event after start-up has nothing before it: not news.
    expect(shouldAlertOpening({ ...change, previousStatus: undefined }, ['@artist:s'], '@me:s', now)).toBe(false);
    expect(shouldAlertOpening({ ...change, ts: now - 10 * 60_000 }, ['@artist:s'], '@me:s', now)).toBe(false);
    expect(shouldAlertOpening(change, ['@artist:s'], '@artist:s', now)).toBe(false);
  });
});

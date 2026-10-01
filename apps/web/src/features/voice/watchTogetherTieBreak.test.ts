import { describe, expect, it } from 'vitest';
import { shouldAcceptState, SIMULTANEOUS_START_MS, type WatchTogetherState } from './watchTogether';

const session = (startedBy: string, startedAt: number, extra: Partial<WatchTogetherState> = {}): WatchTogetherState => ({
  kind: 'youtube',
  url: 'https://youtu.be/x',
  videoId: 'x',
  playing: true,
  positionSeconds: 0,
  updatedAt: startedAt,
  startedBy,
  startedAt,
  ...extra,
});

describe('shouldAcceptState', () => {
  it('takes any state when nothing is playing', () => {
    expect(shouldAcceptState(null, session('@a:s', 1000))).toBe(true);
  });

  it('takes updates to the session already playing: play, pause, seek', () => {
    const playing = session('@a:s', 1000);
    expect(shouldAcceptState(playing, { ...playing, playing: false, positionSeconds: 30, updatedAt: 40_000 })).toBe(true);
  });

  it('of two sessions started at the same moment, keeps the earlier', () => {
    const early = session('@b:s', 1000);
    const late = session('@a:s', 1000 + 500);
    expect(shouldAcceptState(early, late)).toBe(false);
    expect(shouldAcceptState(late, early)).toBe(true);
  });

  it('breaks an exact tie with the lower user ID', () => {
    const a = session('@a:s', 1000);
    const b = session('@b:s', 1000);
    expect(shouldAcceptState(a, b)).toBe(false);
    expect(shouldAcceptState(b, a)).toBe(true);
  });

  it('lets every client land on the same session whichever arrives first', () => {
    const sessions = [session('@c:s', 1200), session('@a:s', 1000), session('@b:s', 1000)];
    // Each client sees them in a different order; all end on the same one.
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ];
    const outcomes = orders.map((order) => {
      let shown: WatchTogetherState | null = null;
      for (const index of order) if (shouldAcceptState(shown, sessions[index])) shown = sessions[index];
      return shown?.startedBy;
    });
    expect(new Set(outcomes)).toEqual(new Set(['@a:s']));
  });

  it('lets a clearly later start replace the session, and drops a stale message from an older one', () => {
    const old = session('@a:s', 1000);
    const next = session('@b:s', 1000 + SIMULTANEOUS_START_MS + 1);
    expect(shouldAcceptState(old, next)).toBe(true);
    expect(shouldAcceptState(next, { ...old, positionSeconds: 99, updatedAt: 99_000 })).toBe(false);
  });

  it('keeps the old rule, the last message wins, with an older client that sends no start time', () => {
    const modern = session('@a:s', 1000);
    const legacy = session('@b:s', 0, { startedAt: undefined });
    expect(shouldAcceptState(modern, legacy)).toBe(true);
    expect(shouldAcceptState(legacy, modern)).toBe(true);
  });
});

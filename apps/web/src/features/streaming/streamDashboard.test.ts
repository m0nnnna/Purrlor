import { describe, expect, it } from 'vitest';
import { bitrateKbps, coverRect, describeHealth, maskKey, readVideoStats, runningTimeouts, timeoutLabel, titleOk } from './streamDashboard';

describe('titles', () => {
  it('takes 1 to 120 characters once trimmed', () => {
    expect(titleOk('  ')).toBe(false);
    expect(titleOk(' Drawing ')).toBe(true);
    expect(titleOk('x'.repeat(120))).toBe(true);
    expect(titleOk('x'.repeat(121))).toBe(false);
  });
});

describe('the stream key', () => {
  it('is hidden as dots of a bounded length', () => {
    expect(maskKey('pk_abc')).toBe('••••••••');
    expect(maskKey('x'.repeat(100))).toHaveLength(32);
  });
});

describe('thumbnails', () => {
  it('crops a wide picture at the sides and a tall one top and bottom, centred', () => {
    expect(coverRect(1920, 360, 640, 360)).toEqual({ sx: 640, sy: 0, sWidth: 640, sHeight: 360 });
    expect(coverRect(640, 1280, 640, 360)).toEqual({ sx: 0, sy: 460, sWidth: 640, sHeight: 360 });
    expect(coverRect(1280, 720, 640, 360)).toEqual({ sx: 0, sy: 0, sWidth: 1280, sHeight: 720 });
  });
});

describe('WebRTC stats', () => {
  const out = (frameWidth: number, bytesSent: number, timestamp = 1000) => ({
    type: 'outbound-rtp',
    kind: 'video',
    frameWidth,
    frameHeight: (frameWidth * 9) / 16,
    framesPerSecond: 30,
    bytesSent,
    timestamp,
  });

  it('takes the biggest layer’s size and adds up the bytes of all', () => {
    const stats = readVideoStats([out(320, 100), out(1280, 900), { type: 'outbound-rtp', kind: 'audio', bytesSent: 5 }, { type: 'codec' }]);
    expect(stats).toEqual({ width: 1280, height: 720, fps: 30, bytes: 1000, at: 1000 });
  });

  it('reads a received picture, and nothing when there is none', () => {
    expect(readVideoStats([{ type: 'inbound-rtp', mediaType: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 29.97, bytesReceived: 50, timestamp: 5 }])).toMatchObject({
      width: 1920,
      bytes: 50,
    });
    expect(readVideoStats([{ type: 'transport' }])).toBeUndefined();
  });

  it('works out kilobits a second between two readings', () => {
    const a = readVideoStats([out(1280, 0, 1000)])!;
    const b = readVideoStats([out(1280, 300_000, 2000)])!;
    expect(bitrateKbps(a, b)).toBe(2400);
    expect(bitrateKbps(undefined, b)).toBeUndefined();
    expect(bitrateKbps(b, a)).toBeUndefined();
  });

  it('describes the picture', () => {
    expect(describeHealth({ width: 1280, height: 720, fps: 29.6, kbps: 2400 })).toBe('1280×720 · 30 fps · 2.4 Mbps');
    expect(describeHealth({ width: 1280, height: 720, fps: 30, kbps: 800 })).toBe('1280×720 · 30 fps · 800 kbps');
    expect(describeHealth({ width: 1280, height: 720, fps: 30 })).toBe('1280×720 · 30 fps');
    expect(describeHealth(undefined)).toBe('No picture yet');
  });
});

describe('timeouts', () => {
  it('lists those still running, soonest first, rounded up to a minute', () => {
    const now = 1_000_000;
    const list = runningTimeouts({ '@a:x': now + 5 * 60_000, '@b:x': now - 1, '@c:x': now + 30_000 }, now);
    expect(list.map((t) => [t.user, t.minutesLeft])).toEqual([
      ['@c:x', 1],
      ['@a:x', 5],
    ]);
    expect([1, 5, 60].map(timeoutLabel)).toEqual(['1 minute', '5 minutes', '1 hour']);
  });
});

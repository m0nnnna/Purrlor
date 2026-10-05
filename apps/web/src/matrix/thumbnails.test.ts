import { describe, expect, it } from 'vitest';
import { serverThumbnail } from './thumbnails';

// What the e2e homeserver (Continuwuity) answered for a 1600×1200 image: 56, 80 and 96 all got
// 96×96; 112 and 176 got 320×240; 480×480 got 640×480; 720×640 and 1200×1200 got the original.
describe('serverThumbnail', () => {
  it('gives the server thumbnail a request would get, so each has one URL', () => {
    expect(serverThumbnail(56, 56)).toEqual({ width: 96, height: 96, method: 'crop' });
    expect(serverThumbnail(80, 80)).toEqual({ width: 96, height: 96, method: 'crop' });
    expect(serverThumbnail(28, 28)).toEqual({ width: 32, height: 32, method: 'crop' });
    expect(serverThumbnail(112, 112)).toEqual({ width: 320, height: 240, method: 'scale' });
    expect(serverThumbnail(176, 176)).toEqual({ width: 320, height: 240, method: 'scale' });
    expect(serverThumbnail(480, 480)).toEqual({ width: 640, height: 480, method: 'scale' });
    expect(serverThumbnail(600, 180)).toEqual({ width: 640, height: 480, method: 'scale' });
  });

  it('gives none past the largest, which is the whole file, unless capped', () => {
    expect(serverThumbnail(720, 640)).toBeUndefined();
    expect(serverThumbnail(1200, 360)).toBeUndefined();
    expect(serverThumbnail(720, 640, { capped: true })).toEqual({ width: 800, height: 600, method: 'scale' });
  });
});

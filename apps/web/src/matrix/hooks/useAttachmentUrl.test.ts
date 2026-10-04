import { describe, expect, it } from 'vitest';
import { inlineThumbnailSize } from './useAttachmentUrl';

describe('inlineThumbnailSize', () => {
  it('asks for twice the box for a large photo', () => {
    expect(inlineThumbnailSize('image/jpeg', 4000, 3000, 360, 320)).toEqual({ width: 720, height: 640 });
  });

  it('asks for one when the size is unknown', () => {
    expect(inlineThumbnailSize('image/png', undefined, undefined, 360, 320)).toEqual({ width: 720, height: 640 });
  });

  it('loads a small image whole', () => {
    expect(inlineThumbnailSize('image/png', 600, 400, 360, 320)).toBeUndefined();
  });

  it('keeps types a thumbnail would flatten whole', () => {
    expect(inlineThumbnailSize('image/gif', 4000, 3000, 360, 320)).toBeUndefined();
    expect(inlineThumbnailSize('image/webp', 4000, 3000, 360, 320)).toBeUndefined();
    expect(inlineThumbnailSize('image/svg+xml', 4000, 3000, 360, 320)).toBeUndefined();
    expect(inlineThumbnailSize(undefined, 4000, 3000, 360, 320)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { formatElapsed, pickRecordingMimeType } from './voiceRecording';

describe('pickRecordingMimeType', () => {
  it('prefers audio/ogg;codecs=opus when supported', () => {
    const isSupported = (t: string) => t === 'audio/ogg;codecs=opus' || t === 'audio/webm;codecs=opus';
    expect(pickRecordingMimeType(isSupported)).toBe('audio/ogg;codecs=opus');
  });

  it('falls back to audio/webm;codecs=opus when ogg is unsupported', () => {
    const isSupported = (t: string) => t === 'audio/webm;codecs=opus';
    expect(pickRecordingMimeType(isSupported)).toBe('audio/webm;codecs=opus');
  });

  it('falls further back through the candidate list', () => {
    const isSupported = (t: string) => t === 'audio/mp4';
    expect(pickRecordingMimeType(isSupported)).toBe('audio/mp4');
  });

  it('returns undefined when nothing in the candidate list is supported', () => {
    expect(pickRecordingMimeType(() => false)).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  it('formats zero as 0:00', () => {
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('zero-pads seconds under ten', () => {
    expect(formatElapsed(7000)).toBe('0:07');
  });

  it('formats minutes and seconds without a leading zero on minutes', () => {
    expect(formatElapsed(65_000)).toBe('1:05');
  });

  it('truncates partial seconds rather than rounding', () => {
    expect(formatElapsed(1999)).toBe('0:01');
  });

  it('formats a long recording past ten minutes', () => {
    expect(formatElapsed(12 * 60_000 + 3000)).toBe('12:03');
  });
});

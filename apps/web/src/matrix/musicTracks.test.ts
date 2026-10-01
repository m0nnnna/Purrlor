import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { audioTypeOf, formatTime, PUBLIC_FILE_MAX_BYTES, titleFromFileName, uploadTrack } from './musicTracks';
import { MUSIC_AUDIO_TYPES } from './profilePage';

describe('audioTypeOf', () => {
  it('takes a declared type from the allowlist, without parameters', () => {
    expect(audioTypeOf({ type: 'audio/mpeg', name: 'a.mp3' })).toBe('audio/mpeg');
    expect(audioTypeOf({ type: 'audio/ogg; codecs=opus', name: 'a.ogg' })).toBe('audio/ogg');
  });

  it('falls back to the extension when the browser says nothing, or something like audio/mp3', () => {
    expect(audioTypeOf({ type: '', name: 'song.FLAC' })).toBe('audio/flac');
    expect(audioTypeOf({ type: 'audio/mp3', name: 'song.mp3' })).toBe('audio/mpeg');
    expect(audioTypeOf({ type: 'audio/x-whatever', name: 'song.m4a' })).toBe('audio/mp4');
  });

  it('refuses anything else, whatever it is called', () => {
    expect(audioTypeOf({ type: 'text/html', name: 'song.mp3' })).toBeUndefined();
    expect(audioTypeOf({ type: 'video/mp4', name: 'clip.m4a' })).toBeUndefined();
    expect(audioTypeOf({ type: 'image/png', name: 'x.wav' })).toBeUndefined();
    expect(audioTypeOf({ type: '', name: 'song.exe' })).toBeUndefined();
    expect(audioTypeOf({ type: '', name: 'mp3' })).toBeUndefined();
    expect(audioTypeOf({ type: '', name: 'song.mp4' })).toBeUndefined();
  });

  it('only ever answers with an allowed type', () => {
    for (const ext of ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'webm', 'flac', 'wav']) {
      expect(MUSIC_AUDIO_TYPES as readonly string[]).toContain(audioTypeOf({ type: '', name: `x.${ext}` }));
    }
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and tidies the rest', () => {
    expect(titleFromFileName('my_cool__song.mp3')).toBe('my cool song');
    expect(titleFromFileName('Artist - Title.final.flac')).toBe('Artist - Title.final');
  });

  it('is one line of at most 100 characters, and never empty', () => {
    expect(titleFromFileName(`${'a'.repeat(300)}.mp3`)).toHaveLength(100);
    expect(titleFromFileName('.mp3')).toBe('Untitled');
    expect(titleFromFileName('   .wav')).toBe('Untitled');
  });
});

describe('formatTime', () => {
  it('shows minutes and seconds, and hours when there are some', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
  });

  it('shows nothing odd for what is not a time', () => {
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
  });
});

describe('uploadTrack', () => {
  const client = (limit: number | undefined) =>
    ({
      getMediaConfig: vi.fn().mockResolvedValue(limit === undefined ? {} : { 'm.upload.size': limit }),
      uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://purr.example/abc' }),
    }) as unknown as MatrixClient & { uploadContent: ReturnType<typeof vi.fn> };
  const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

  it('refuses a file that is not sound before uploading anything', async () => {
    const mx = client(undefined);
    await expect(uploadTrack(mx, file('x.html', 'text/html'))).rejects.toThrow(/isn’t a sound/);
    expect(mx.uploadContent).not.toHaveBeenCalled();
  });

  it('refuses a file over the homeserver limit, or over the public route limit', async () => {
    const small = client(5);
    await expect(uploadTrack(small, file('a.mp3', 'audio/mpeg', 10))).rejects.toThrow(/up to/);
    expect(small.uploadContent).not.toHaveBeenCalled();
    expect(PUBLIC_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  afterEach(() => vi.unstubAllGlobals());

  // jsdom can't read a sound file's header or make object URLs, so a stand-in plays the browser.
  const stubBrowser = (duration: number) => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'Audio',
      class {
        preload = '';
        duration = duration;
        onloadedmetadata?: () => void;
        onerror?: () => void;
        set src(_value: string) {
          queueMicrotask(() => this.onloadedmetadata?.());
        }
        removeAttribute() {}
      }
    );
  };

  it('uploads as the allowed type and returns the track, with the length its header gives', async () => {
    stubBrowser(186.6);
    const mx = client(1_000_000);
    const track = await uploadTrack(mx, file('my_song.mp3', ''));
    expect(mx.uploadContent).toHaveBeenCalledWith(expect.any(File), { type: 'audio/mpeg', name: 'my_song.mp3' });
    expect(track).toEqual({ url: 'mxc://purr.example/abc', mimetype: 'audio/mpeg', title: 'my song', size: 10, duration: 187 });
  });

  it('claims no length when the header gives none', async () => {
    stubBrowser(Number.NaN);
    const track = await uploadTrack(client(undefined), file('a.ogg', 'audio/ogg'));
    expect(track).not.toHaveProperty('duration');
  });
});

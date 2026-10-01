import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalParticipant } from 'livekit-client';
import {
  APP_AUDIO_HINTS,
  readAppAudioOnly,
  saveAppAudioOnly,
  SCREEN_SHARE_CODEC,
  screenShareCaptureOptions,
  startScreenShare,
  voiceChannelRoomOptions,
  withDisplayMediaHints,
} from './voiceChannelRoomOptions';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('what a screen share publishes', () => {
  it('uses H.264, which GPUs encode and decode, at up to 60 fps and 8 Mbps', () => {
    expect(SCREEN_SHARE_CODEC).toBe('h264');
    expect(voiceChannelRoomOptions.publishDefaults?.videoCodec).toBe('h264');
    expect(voiceChannelRoomOptions.publishDefaults?.screenShareEncoding).toMatchObject({ maxBitrate: 8_000_000, maxFramerate: 60 });
  });
});

describe('what a screen share captures', () => {
  it('asks for 1080p at 60 fps (LiveKit would otherwise ask for 30) and for motion over sharpness', () => {
    for (const appAudioOnly of [false, true]) {
      const options = screenShareCaptureOptions(appAudioOnly);
      expect(options.resolution).toEqual({ width: 1920, height: 1080, frameRate: 60 });
      expect(options.contentHint).toBe('motion');
      expect(options.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    }
  });

  it('lets the browser offer system sound normally', () => {
    expect(screenShareCaptureOptions(false).systemAudio).toBe('include');
  });

  it('never offers system sound when only the shared window’s is wanted, and opens the picker on windows', () => {
    const options = screenShareCaptureOptions(true);
    expect(options.systemAudio).toBe('exclude');
    expect(options.video).toEqual({ displaySurface: 'window' });
  });
});

describe('withDisplayMediaHints', () => {
  const fakeDevices = () => {
    const calls: unknown[] = [];
    const getDisplayMedia = vi.fn(async (constraints?: unknown) => {
      calls.push(constraints);
      return {} as MediaStream;
    });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
    return { calls, getDisplayMedia };
  };

  it('adds the hints to a capture request made while it runs, and puts the real function back', async () => {
    const { calls, getDisplayMedia } = fakeDevices();
    await withDisplayMediaHints(APP_AUDIO_HINTS, () => navigator.mediaDevices.getDisplayMedia({ video: true, systemAudio: 'exclude' } as DisplayMediaStreamOptions));
    expect(calls).toEqual([{ video: true, systemAudio: 'exclude', windowAudio: 'window' }]);
    expect(navigator.mediaDevices.getDisplayMedia).toBe(getDisplayMedia);
  });

  it('puts it back when the share fails or the picker is cancelled', async () => {
    const { getDisplayMedia } = fakeDevices();
    await expect(
      withDisplayMediaHints({ windowAudio: 'window' }, async () => {
        throw new Error('NotAllowedError');
      })
    ).rejects.toThrow('NotAllowedError');
    expect(navigator.mediaDevices.getDisplayMedia).toBe(getDisplayMedia);
  });

  it('just runs when the browser has no screen capture', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    await expect(withDisplayMediaHints({}, async () => 'ran')).resolves.toBe('ran');
  });
});

describe('startScreenShare', () => {
  const participant = () => {
    const setScreenShareEnabled = vi.fn(async () => undefined);
    return { setScreenShareEnabled, participant: { setScreenShareEnabled } as unknown as LocalParticipant };
  };

  it('starts a share with the capture options', async () => {
    const { setScreenShareEnabled, participant: p } = participant();
    await startScreenShare(p, false);
    expect(setScreenShareEnabled).toHaveBeenCalledWith(true, screenShareCaptureOptions(false));
  });

  it('asks the browser for window audio when only the app’s sound is wanted', async () => {
    const seen: unknown[] = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getDisplayMedia: async (constraints: unknown) => {
          seen.push(constraints);
          return {} as MediaStream;
        },
      },
      configurable: true,
    });
    const p = {
      setScreenShareEnabled: async () => {
        await navigator.mediaDevices.getDisplayMedia({ systemAudio: 'exclude' } as DisplayMediaStreamOptions);
      },
    } as unknown as LocalParticipant;
    await startScreenShare(p, true);
    expect(seen).toEqual([{ systemAudio: 'exclude', windowAudio: 'window' }]);
  });
});

describe('the app-audio-only setting', () => {
  it('is off until chosen, then remembered', () => {
    expect(readAppAudioOnly()).toBe(false);
    saveAppAudioOnly(true);
    expect(readAppAudioOnly()).toBe(true);
    saveAppAudioOnly(false);
    expect(readAppAudioOnly()).toBe(false);
  });
});

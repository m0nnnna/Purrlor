import { describe, expect, it } from 'vitest';
import { MsgType } from 'matrix-js-sdk';
import { buildVoiceMessageContent } from './voiceMessage';

describe('buildVoiceMessageContent', () => {
  it('builds a plain (unencrypted) m.audio event with the MSC1767/MSC3245 voice blocks', () => {
    const content = buildVoiceMessageContent({
      location: { url: 'mxc://example.org/abc' },
      mimetype: 'audio/ogg',
      size: 4321,
      durationMs: 6000,
      waveform: [0, 512, 1024],
    });

    expect(content).toEqual({
      msgtype: MsgType.Audio,
      body: 'Voice message',
      url: 'mxc://example.org/abc',
      info: { mimetype: 'audio/ogg', size: 4321, duration: 6000 },
      'org.matrix.msc1767.audio': { duration: 6000, waveform: [0, 512, 1024] },
      'org.matrix.msc3245.voice': {},
    });
  });

  it('spreads an encrypted-attachment `file` location instead of `url`', () => {
    const file = {
      url: 'mxc://example.org/enc',
      key: { alg: 'A256CTR', key_ops: ['encrypt', 'decrypt'], kty: 'oct', k: 'key', ext: true },
      iv: 'iv',
      hashes: { sha256: 'hash' },
      v: 'v2',
    };
    const content = buildVoiceMessageContent({
      location: { file },
      mimetype: 'audio/webm',
      size: 100,
      durationMs: 1000,
      waveform: [],
    });

    expect(content.file).toBe(file);
    expect(content.url).toBeUndefined();
  });

  it('always marks the message as a voice message via org.matrix.msc3245.voice', () => {
    const content = buildVoiceMessageContent({
      location: { url: 'mxc://example.org/x' },
      mimetype: 'audio/ogg',
      size: 1,
      durationMs: 1,
      waveform: [],
    });
    expect(content['org.matrix.msc3245.voice']).toEqual({});
  });
});

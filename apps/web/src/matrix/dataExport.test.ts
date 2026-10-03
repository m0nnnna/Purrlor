import { describe, expect, it } from 'vitest';
import { MatrixEvent } from 'matrix-js-sdk';
import { collectMedia, exportedEvent, safeName, uniqueName } from './dataExport';

const event = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  new MatrixEvent({ event_id: '$e', type: 'm.room.message', sender: '@me:x', origin_server_ts: Date.UTC(2026, 9, 3, 12), content, ...extra });

describe('exportedEvent', () => {
  it('keeps a message with its text, time and content', () => {
    expect(exportedEvent(event({ msgtype: 'm.text', body: 'hello' }))).toEqual({
      id: '$e',
      sentAt: '2026-10-03T12:00:00.000Z',
      type: 'm.room.message',
      text: 'hello',
      content: { msgtype: 'm.text', body: 'hello' },
    });
  });

  it('takes an edit at its new text and says what it edits', () => {
    const edit = exportedEvent(
      event({
        msgtype: 'm.text',
        body: '* hello there',
        'm.new_content': { msgtype: 'm.text', body: 'hello there' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$original' },
      })
    );
    expect(edit).toMatchObject({ text: 'hello there', edits: '$original' });
  });

  it('leaves out a deleted message', () => {
    expect(exportedEvent(event({}, { unsigned: { redacted_because: { type: 'm.room.redaction' } } }))).toBeUndefined();
  });
});

describe('collectMedia', () => {
  it('finds plain links anywhere, with a message’s file name and type', () => {
    const found = collectMedia({
      msgtype: 'm.image',
      body: 'cat.png',
      url: 'mxc://x/abc',
      info: { mimetype: 'image/png', thumbnail_url: 'mxc://x/thumb' },
      blocks: [{ background: 'mxc://x/bg' }, 'not a link', 'mxc://x/../escape'],
    });
    expect(found).toEqual([
      { mxc: 'mxc://x/abc', name: 'cat.png', mimetype: 'image/png' },
      { mxc: 'mxc://x/thumb' },
      { mxc: 'mxc://x/bg' },
    ]);
  });

  it('keeps an encrypted file with its key, to be decrypted rather than saved as ciphertext', () => {
    const file = { url: 'mxc://x/enc', key: { k: 'secret' }, iv: 'iv', hashes: { sha256: 'h' }, v: 'v2' };
    const [found] = collectMedia({ msgtype: 'm.file', body: 'notes.pdf', file, info: { mimetype: 'application/pdf' } });
    expect(found).toMatchObject({ mxc: 'mxc://x/enc', name: 'notes.pdf', mimetype: 'application/pdf' });
    expect(found.encrypted).toBe(file);
  });
});

describe('file names', () => {
  it('makes a name any computer accepts', () => {
    expect(safeName('Studio - #general')).toBe('Studio - #general');
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeName('..hidden')).toBe('hidden');
    expect(safeName('   ', 'fallback')).toBe('fallback');
    expect(safeName('x'.repeat(200)).length).toBe(80);
  });

  it('numbers repeats before the extension, ignoring case', () => {
    const taken = new Set<string>();
    expect(uniqueName('chat.json', taken)).toBe('chat.json');
    expect(uniqueName('Chat.json', taken)).toBe('Chat (2).json');
    expect(uniqueName('chat.json', taken)).toBe('chat (3).json');
    expect(uniqueName('README', taken)).toBe('README');
  });
});

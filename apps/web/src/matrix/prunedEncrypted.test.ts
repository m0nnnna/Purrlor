import { describe, expect, it, vi } from 'vitest';
import { MatrixEvent, type MatrixClient } from 'matrix-js-sdk';
import { installPrunedEncryptedGuard, isPrunedEncryptedEvent } from './prunedEncrypted';

function encrypted(content: Record<string, unknown>, unsigned: Record<string, unknown> = {}) {
  return new MatrixEvent({
    type: 'm.room.encrypted',
    event_id: '$deleted',
    room_id: '!room:remote.example',
    sender: '@bot:remote.example',
    origin_server_ts: 1_000,
    content,
    unsigned,
  });
}

const megolm = { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'abc', session_id: 's', sender_key: 'k', device_id: 'D' };

describe('isPrunedEncryptedEvent', () => {
  it('is an encrypted event whose server pruned it without saying so', () => {
    expect(isPrunedEncryptedEvent(encrypted({}))).toBe(true);
  });

  it('is not a live encrypted message', () => {
    expect(isPrunedEncryptedEvent(encrypted(megolm))).toBe(false);
  });

  it('is not one the server already marked deleted', () => {
    expect(isPrunedEncryptedEvent(encrypted({}, { redacted_because: { type: 'm.room.redaction' } }))).toBe(false);
  });

  it('is not another type with empty content', () => {
    const event = new MatrixEvent({ type: 'm.room.message', event_id: '$x', room_id: '!r', sender: '@a:b', content: {} });
    expect(isPrunedEncryptedEvent(event)).toBe(false);
  });
});

describe('installPrunedEncryptedGuard', () => {
  function setup() {
    const decrypt = vi.fn(async () => undefined);
    const client = { decryptEventIfNeeded: decrypt } as unknown as MatrixClient;
    installPrunedEncryptedGuard(client);
    return { client, decrypt };
  }

  it('marks a pruned event deleted before the SDK tries it, so it is never decrypted', async () => {
    const { client, decrypt } = setup();
    const event = encrypted({});
    expect(event.shouldAttemptDecryption()).toBe(true);
    await client.decryptEventIfNeeded(event);
    expect(event.isRedacted()).toBe(true);
    expect(event.shouldAttemptDecryption()).toBe(false);
    expect(event.getUnsigned().redacted_because).toMatchObject({ type: 'm.room.redaction', redacts: '$deleted' });
    expect(decrypt).toHaveBeenCalledWith(event, undefined);
  });

  it('leaves a live encrypted message to be decrypted', async () => {
    const { client, decrypt } = setup();
    const event = encrypted(megolm, { age: 5 });
    await client.decryptEventIfNeeded(event, { isRetry: true });
    expect(event.isRedacted()).toBe(false);
    expect(event.getUnsigned()).toEqual({ age: 5 });
    expect(decrypt).toHaveBeenCalledWith(event, { isRetry: true });
  });
});

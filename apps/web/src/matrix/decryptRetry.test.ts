import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MatrixEventEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';
import { installDecryptionRetry, RETRY_DELAYS_MS } from './decryptRetry';

function fakeEvent(reason: string | null, ts = Date.now()) {
  const event = {
    decryptionFailureReason: reason,
    isDecryptionFailure: () => event.decryptionFailureReason !== null,
    getTs: () => ts,
    attemptDecryption: vi.fn(async () => undefined),
  };
  return event;
}

function setup() {
  const client = new EventEmitter() as EventEmitter & { cryptoBackend: object };
  client.cryptoBackend = {};
  const stop = installDecryptionRetry(client as unknown as MatrixClient);
  const fail = (event: ReturnType<typeof fakeEvent>) => client.emit(MatrixEventEvent.Decrypted, event as unknown as MatrixEvent);
  return { client, stop, fail };
}

describe('installDecryptionRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a missing key with backoff, then gives up', () => {
    const { fail } = setup();
    const event = fakeEvent(DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID);
    for (const delay of RETRY_DELAYS_MS) {
      fail(event);
      vi.advanceTimersByTime(delay - 1);
      const before = event.attemptDecryption.mock.calls.length;
      vi.advanceTimersByTime(1);
      expect(event.attemptDecryption).toHaveBeenCalledTimes(before + 1);
      expect(event.attemptDecryption).toHaveBeenLastCalledWith({}, { isRetry: true });
    }
    fail(event);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(event.attemptDecryption).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length);
  });

  it("leaves failures a later key can't fix, and old messages, alone", () => {
    const { fail } = setup();
    const withheld = fakeEvent(DecryptionFailureCode.MEGOLM_KEY_WITHHELD);
    const old = fakeEvent(DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID, Date.now() - 2 * 60 * 60 * 1000);
    fail(withheld);
    fail(old);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(withheld.attemptDecryption).not.toHaveBeenCalled();
    expect(old.attemptDecryption).not.toHaveBeenCalled();
  });

  it('skips the retry once the message decrypted some other way, and stops on cleanup', () => {
    const { fail, stop } = setup();
    const decryptedMeanwhile = fakeEvent(DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX);
    fail(decryptedMeanwhile);
    decryptedMeanwhile.decryptionFailureReason = null;
    const pending = fakeEvent(DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX);
    fail(pending);
    stop();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(decryptedMeanwhile.attemptDecryption).not.toHaveBeenCalled();
    expect(pending.attemptDecryption).not.toHaveBeenCalled();
  });
});

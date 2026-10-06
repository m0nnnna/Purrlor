import { MatrixEventEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';

/**
 * Tries again to decrypt a message that came in as "[unable to decrypt]" while its key may still be
 * on the way.
 *
 * When a message's room key is missing, matrix-js-sdk asks the key backup for it once. If the sender
 * hasn't uploaded it there yet (they back keys up a moment after sending, and a key whose to-device
 * message never reached this session only ever arrives that way), the answer is "not found" and the
 * SDK doesn't ask again. The message stays undecryptable until a refresh, or until a later message
 * from the same session happens to fetch the key. Here a fresh failure is retried a few times over
 * the next minutes, and each retry makes the SDK check the backup again.
 */

/** Failures a key arriving later can fix. Withheld keys, or messages from before this account joined, can't be. */
const RETRYABLE = new Set<string>([
  DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
  DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX,
  DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP,
  DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
]);

/** After the first failure, then after each retry that fails again. The SDK checks a session's
 *  backup at most every 5 seconds, so the first retry waits longer than that. */
export const RETRY_DELAYS_MS = [6_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** Only recent messages: an older one's key, if it exists anywhere, was in the backup already. */
const RECENT_MS = 60 * 60 * 1000;

export function shouldRetryDecryption(event: MatrixEvent, now = Date.now()): boolean {
  const reason = event.decryptionFailureReason;
  return reason !== null && RETRYABLE.has(reason) && now - event.getTs() < RECENT_MS;
}

type CryptoBackend = Parameters<MatrixEvent['attemptDecryption']>[0];

/** Starts retrying for every client event that fails to decrypt. Returns a function that stops it. */
export function installDecryptionRetry(mx: MatrixClient): () => void {
  const attempts = new WeakMap<MatrixEvent, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const onDecrypted = (event: MatrixEvent) => {
    if (!event.isDecryptionFailure() || !shouldRetryDecryption(event)) return;
    const attempt = attempts.get(event) ?? 0;
    if (attempt >= RETRY_DELAYS_MS.length) return;
    attempts.set(event, attempt + 1);
    const timer = setTimeout(() => {
      timers.delete(timer);
      // The SDK's own decryptEventIfNeeded skips an event that already failed (it holds the failure
      // placeholder as its clear content), so the retry goes through attemptDecryption, as the SDK
      // does itself when a key arrives. Its result is another Decrypted event, which lands back here.
      const backend = (mx as unknown as { cryptoBackend?: CryptoBackend }).cryptoBackend;
      if (!backend || !event.isDecryptionFailure()) return;
      event.attemptDecryption(backend, { isRetry: true }).catch(() => undefined);
    }, RETRY_DELAYS_MS[attempt]);
    timers.add(timer);
  };

  mx.on(MatrixEventEvent.Decrypted, onDecrypted);
  return () => {
    mx.removeListener(MatrixEventEvent.Decrypted, onDecrypted);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}

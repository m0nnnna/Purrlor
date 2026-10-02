import {
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
  type CryptoApi,
  type KeyBackupRestoreResult,
} from 'matrix-js-sdk/lib/crypto-api';
import { SecretStorage, type MatrixClient } from 'matrix-js-sdk';
import { withSecretStorageKeyAttempt } from './secretStorageCallbacks';

export class RecoveryKeyError extends Error {}

/**
 * Decodes whatever the user typed into the actual secret storage private key. Matrix accounts
 * can set up secret storage two ways: a randomly-generated base58 recovery key (the "4-5
 * characters then a space" format), or a user-chosen recovery passphrase run through PBKDF2
 * (arbitrary text — however long or "custom" the user picked). Which one applies is recorded
 * on the key's own metadata (`passphrase` present = passphrase-derived), not something to guess
 * or make the user pick between.
 */
async function decodeUserInput(
  input: string,
  keyInfo: SecretStorage.SecretStorageKeyDescriptionAesV1
): Promise<Uint8Array> {
  if (keyInfo.passphrase) {
    const { salt, iterations, bits } = keyInfo.passphrase;
    return deriveRecoveryKeyFromPassphrase(input, salt, iterations, bits);
  }
  try {
    return decodeRecoveryKey(input);
  } catch {
    throw new RecoveryKeyError("That recovery key doesn't look right — check for typos.");
  }
}

/**
 * Signs this session with the account's cross-signing keys, read from secret storage — what makes
 * other Matrix apps (Element, FluffyChat) show it as verified rather than as an unknown session.
 * Unlocking the key backup alone gives this session the history but proves nothing to anyone else.
 *
 * Only when the keys are actually in secret storage: given none, bootstrapCrossSigning makes
 * brand-new ones, which would leave every other session of the account unverified instead.
 * Returns whether this session is now signed.
 */
async function signThisSession(crypto: CryptoApi, deviceId: string | null): Promise<boolean> {
  const status = await crypto.getCrossSigningStatus();
  if (!status.privateKeysInSecretStorage || !deviceId) return false;
  // Reads the keys from secret storage into this session and signs it.
  await crypto.bootstrapCrossSigning({});
  // Signed again in case the keys were already here (bootstrap then does nothing); harmless twice.
  await crypto.crossSignDevice(deviceId);
  return true;
}

export type RecoveryResult = {
  /** The key backup restored, when the account has one. */
  restored?: KeyBackupRestoreResult;
  /** This session is now signed with the account's cross-signing keys. */
  verified: boolean;
};

/**
 * Verifies this session with a Matrix recovery key or passphrase, through the spec's Secure Secret
 * Storage: signs it with the account's cross-signing keys (so other apps trust it), and restores
 * the key backup (so past encrypted messages decrypt). Non-interactive: it works without another
 * logged-in device. Verifying from another device (RecoveryKeyPrompt) is the other way in.
 */
export async function restoreFromRecoveryKey(mx: MatrixClient, input: string): Promise<RecoveryResult> {
  const crypto = mx.getCrypto();
  if (!crypto) {
    throw new RecoveryKeyError('Encryption is not available on this session.');
  }

  const keyTuple = await mx.secretStorage.getKey();
  if (!keyTuple) {
    throw new RecoveryKeyError('This account has no recovery key set up.');
  }
  const [keyId, keyInfo] = keyTuple;

  const privateKey = await decodeUserInput(input.trim(), keyInfo);

  const isCorrect = await mx.secretStorage.checkKey(privateKey, keyInfo);
  if (!isCorrect) {
    throw new RecoveryKeyError(
      keyInfo.passphrase
        ? "That recovery passphrase doesn't match — double-check it and try again."
        : "That recovery key doesn't match — double-check it and try again."
    );
  }

  return withSecretStorageKeyAttempt(keyId, privateKey, async () => {
    await crypto.bootstrapSecretStorage({});
    let verified: boolean;
    try {
      verified = await signThisSession(crypto, mx.getDeviceId());
    } catch {
      throw new RecoveryKeyError('The key is right, but verifying this session failed. Try again.');
    }
    if (!(await crypto.getKeyBackupInfo())) return { verified };
    try {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      return { restored: await crypto.restoreKeyBackup(), verified };
    } catch {
      throw new RecoveryKeyError(
        verified
          ? 'This session is verified, but restoring message history failed. Try again.'
          : 'Unlocked secret storage, but restoring message history failed. Try again.'
      );
    }
  });
}

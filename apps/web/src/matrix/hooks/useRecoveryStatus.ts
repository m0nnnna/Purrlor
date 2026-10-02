import { useEffect, useState } from 'react';
import { useMatrixClient } from '../MatrixClientContext';

export type RecoveryStatus = 'checking' | 'not-needed' | 'needed';

/**
 * Whether this session should ask for the recovery key: it isn't signed with the account's
 * cross-signing keys yet (so other Matrix apps show it as unverified), or there's a server-side
 * key backup this session doesn't hold the key for (`matchesDecryptionKey`; old messages would
 * show "[unable to decrypt]"). A session unlocked before verifying was added only had its
 * history restored, so it's asked once more, to be signed.
 */
export function useRecoveryStatus(): RecoveryStatus {
  const mx = useMatrixClient();
  const [status, setStatus] = useState<RecoveryStatus>('checking');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const crypto = mx.getCrypto();
      if (!crypto) {
        if (!cancelled) setStatus('not-needed');
        return;
      }
      try {
        const userId = mx.getUserId();
        const deviceId = mx.getDeviceId();
        if (userId && deviceId && (await crypto.userHasCrossSigningKeys(userId))) {
          const device = await crypto.getDeviceVerificationStatus(userId, deviceId);
          if (device && !device.crossSigningVerified) {
            if (!cancelled) setStatus('needed');
            return;
          }
        }
        const backupInfo = await crypto.getKeyBackupInfo();
        if (!backupInfo) {
          if (!cancelled) setStatus('not-needed');
          return;
        }
        const trust = await crypto.isKeyBackupTrusted(backupInfo);
        if (!cancelled) setStatus(trust.matchesDecryptionKey ? 'not-needed' : 'needed');
      } catch {
        if (!cancelled) setStatus('not-needed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mx]);

  return status;
}

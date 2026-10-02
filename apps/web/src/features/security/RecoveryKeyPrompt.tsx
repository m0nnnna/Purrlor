import { useState, type FormEvent } from 'react';
import type { VerificationRequest } from 'matrix-js-sdk/lib/crypto-api';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { RecoveryKeyError, restoreFromRecoveryKey } from '../../matrix/recovery';
import { requestOwnDeviceVerification } from '../../matrix/verification';
import { VerificationSasModal } from './VerificationSasModal';
import './RecoveryKeyPrompt.css';

/**
 * Backup-code-based decryption recovery — see docs on `restoreFromRecoveryKey` — plus the
 * interactive (SAS emoji) device-verification alternative recovery.ts's own comment flagged as
 * a follow-up: verifying against another already-trusted device of yours lets matrix-js-sdk's
 * Rust crypto gossip the backup key over automatically, without typing anything.
 */
export function RecoveryKeyPrompt({ onResolved }: { onResolved: () => void }) {
  const mx = useMatrixClient();
  const [dismissed, setDismissed] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [verificationRequest, setVerificationRequest] = useState<VerificationRequest>();
  const [verificationError, setVerificationError] = useState<string>();

  if (dismissed) return null;

  const handleStartDeviceVerification = async () => {
    setVerificationError(undefined);
    try {
      setVerificationRequest(await requestOwnDeviceVerification(mx));
    } catch (err) {
      setVerificationError(err instanceof Error ? err.message : 'Failed to start verification');
    }
  };

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    setRestoring(true);
    setError(undefined);
    try {
      const res = await restoreFromRecoveryKey(mx, recoveryKey);
      const restored = res.restored ? `Restored ${res.restored.imported} of ${res.restored.total} message keys.` : '';
      setResult(res.verified ? `This session is verified. ${restored}`.trim() : restored || 'Unlocked.');
      setTimeout(onResolved, 1500);
    } catch (err) {
      setError(err instanceof RecoveryKeyError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="nu-recovery-prompt" data-nu-role="recovery-prompt">
      <form className="nu-recovery-prompt__panel" onSubmit={handleSubmit}>
        <h2 className="nu-recovery-prompt__title">Verify this session</h2>
        <p className="nu-recovery-prompt__body">
          Enter your recovery key or recovery passphrase (whichever was set up for this account).
          It unlocks your past encrypted messages here, and verifies this session so your other
          Matrix apps trust it.
        </p>
        <input
          className="nu-recovery-prompt__input"
          data-nu-role="recovery-prompt-input"
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
          placeholder="Recovery key or passphrase"
          autoComplete="off"
          autoFocus
        />
        {error && (
          <p className="nu-recovery-prompt__error" data-nu-role="recovery-prompt-error">
            {error}
          </p>
        )}
        {result && (
          <p className="nu-recovery-prompt__success" data-nu-role="recovery-prompt-success">
            {result}
          </p>
        )}
        {verificationError && (
          <p className="nu-recovery-prompt__error" data-nu-role="recovery-prompt-verification-error">
            {verificationError}
          </p>
        )}
        <button
          type="button"
          className="nu-recovery-prompt__verify-instead"
          data-nu-role="recovery-prompt-verify-device"
          onClick={handleStartDeviceVerification}
        >
          Or verify with another device instead
        </button>
        <div className="nu-recovery-prompt__actions">
          <button type="button" className="nu-recovery-prompt__skip" onClick={() => setDismissed(true)}>
            Skip for now
          </button>
          <button
            type="submit"
            className="nu-recovery-prompt__submit"
            disabled={!recoveryKey.trim() || restoring}
          >
            {restoring ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </form>
      {verificationRequest && (
        <VerificationSasModal
          request={verificationRequest}
          onClose={() => setVerificationRequest(undefined)}
          onDone={onResolved}
        />
      )}
    </div>
  );
}

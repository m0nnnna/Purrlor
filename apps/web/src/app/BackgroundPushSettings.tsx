import { useEffect, useState } from 'react';
import { useMatrixClient } from '../matrix/MatrixClientContext';
import {
  disableBackgroundPush,
  enableBackgroundPush,
  getPushSupport,
  isBackgroundPushEnabled,
  readPushGatewayUrl,
  setPushGatewayUrl,
  showBackgroundPushConfirmation,
  type EnableStep,
} from '../matrix/push';

/** What's happening while it's enabled: the push service step can take the better part of a minute. */
const STEP_LABELS: Record<EnableStep, string> = {
  permission: 'Waiting for you to allow notifications in the browser…',
  'service-worker': 'Starting the notification worker…',
  'push-service': 'Registering with your browser’s push service. This can take up to a minute…',
  gateway: 'Connecting to the push gateway…',
  homeserver: 'Telling your homeserver where to send notifications…',
};

/**
 * Background push notifications — separate from "Desktop notifications" above (foreground-tab
 * only, Notification API directly): this round-trips through a push gateway
 * (services/push-gateway) so a notification can arrive even when no tab is open. Its own
 * component because the enable/disable flow is a real multi-step async operation (register a
 * service worker, subscribe with PushManager, register the subscription with the gateway,
 * register a Matrix pusher) with its own failure modes, not a form field to bundle into the
 * profile Save button above.
 */
export function BackgroundPushSettings() {
  const mx = useMatrixClient();
  const [gatewayUrl, setGatewayUrlInput] = useState(() => readPushGatewayUrl(mx) ?? '');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<EnableStep>();
  const [justEnabled, setJustEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const support = getPushSupport();

  useEffect(() => {
    isBackgroundPushEnabled().then(setEnabled);
  }, []);

  const handleEnable = async () => {
    const trimmed = gatewayUrl.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(undefined);
    setJustEnabled(false);
    try {
      await setPushGatewayUrl(mx, trimmed);
      await enableBackgroundPush(mx, trimmed, setStep);
      setEnabled(true);
      setJustEnabled(true);
      void showBackgroundPushConfirmation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable background notifications');
    } finally {
      setBusy(false);
      setStep(undefined);
    }
  };

  const handleDisable = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setJustEnabled(false);
    try {
      await disableBackgroundPush(mx, gatewayUrl.trim());
      setEnabled(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable background notifications');
    } finally {
      setBusy(false);
    }
  };

  if (support === 'unsupported') {
    return (
      <div className="nu-field">
        Background push notifications
        <p className="nu-field__hint">Not supported in this browser.</p>
      </div>
    );
  }

  return (
    <div className="nu-field" data-nu-role="account-settings-push">
      Background push notifications
      <p className="nu-field__hint">
        Arrive even when no tab is open, via this deployment's push gateway. Per-device — enabling
        it here only affects this browser.
      </p>
      <input
        className="nu-field__input"
        data-nu-role="account-settings-push-gateway-url"
        value={gatewayUrl}
        onChange={(e) => setGatewayUrlInput(e.target.value)}
        placeholder="https://push.example.com"
        disabled={enabled}
      />
      {error && (
        <p className="nu-field__error" data-nu-role="account-settings-push-error">
          {error}
        </p>
      )}
      {step && (
        <p className="nu-field__hint" data-nu-role="account-settings-push-step" aria-live="polite">
          {STEP_LABELS[step]}
        </p>
      )}
      <div className="nu-account-settings__notifications">
        <span className="nu-field__hint" data-nu-role="account-settings-push-status">
          {enabled ? (justEnabled ? 'Enabled on this device. A test notification is on its way.' : 'Enabled on this device') : 'Not enabled on this device'}
        </span>
        {enabled ? (
          <button
            type="button"
            className="nu-button nu-button--secondary"
            data-nu-role="account-settings-push-disable"
            disabled={busy}
            onClick={handleDisable}
          >
            {busy ? 'Disabling…' : 'Disable'}
          </button>
        ) : (
          <button
            type="button"
            className="nu-button nu-button--secondary"
            data-nu-role="account-settings-push-enable"
            disabled={busy || !gatewayUrl.trim()}
            onClick={handleEnable}
          >
            {busy ? 'Enabling…' : 'Enable'}
          </button>
        )}
      </div>
    </div>
  );
}

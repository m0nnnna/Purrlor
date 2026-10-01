import { useState } from 'react';
import { promptInstall, useInstallRoute } from './installApp';

/** Account Settings' "Install Purrlor": the browser's own dialog where there is one, steps where not. */
export function InstallAppSettings() {
  const route = useInstallRoute();
  const [declined, setDeclined] = useState(false);

  return (
    <div className="nu-field" data-nu-role="account-settings-install">
      Install Purrlor
      {route === 'installed' && <p className="nu-field__hint">You’re using the installed app.</p>}
      {route === 'prompt' && (
        <div className="nu-account-settings__notifications">
          <span className="nu-field__hint">Open Purrlor from your home screen or app list, like any other app.</span>
          <button
            type="button"
            className="nu-button nu-button--secondary"
            data-nu-role="account-settings-install-button"
            onClick={() => void promptInstall().then((installed) => setDeclined(!installed))}
          >
            Install
          </button>
        </div>
      )}
      {route === 'ios' && (
        <p className="nu-field__hint" data-nu-role="account-settings-install-ios">
          In Safari, tap Share, then <strong>Add to Home Screen</strong>. Background notifications on an iPhone or iPad only
          work from the installed app.
        </p>
      )}
      {route === 'browser-menu' && (
        <p className="nu-field__hint">
          {declined
            ? 'You can install it later from your browser’s menu.'
            : 'Look for “Install app” or “Add to Home screen” in your browser’s menu. Not every browser offers it.'}
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { dismissInstallHint, installHintDismissed, promptInstall, useInstallRoute } from './installApp';

const PHONE_WIDTH = '(max-width: 900px)';

/**
 * A one-time nudge on phones to put Purrlor on the home screen. Gone for good once dismissed,
 * installed, or used from the installed app; Account Settings → Install Purrlor stays for later.
 */
export function InstallHint() {
  const route = useInstallRoute();
  const [dismissed, setDismissed] = useState(installHintDismissed);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(PHONE_WIDTH).matches === true);

  useEffect(() => {
    const query = window.matchMedia?.(PHONE_WIDTH);
    if (!query) return undefined;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (dismissed || !narrow || route === 'installed' || route === 'browser-menu') return null;

  const close = () => {
    dismissInstallHint();
    setDismissed(true);
  };

  return (
    <div className="nu-install-hint" data-nu-role="install-hint" role="status">
      <span className="nu-install-hint__text">
        {route === 'ios' ? (
          <>
            Add Purrlor to your home screen for notifications: tap Share, then <strong>Add to Home Screen</strong>.
          </>
        ) : (
          'Install Purrlor for notifications and a full-screen app.'
        )}
      </span>
      {route === 'prompt' && (
        <button
          type="button"
          className="nu-button nu-button--primary nu-install-hint__install"
          data-nu-role="install-hint-install"
          onClick={() => void promptInstall().then(close)}
        >
          Install
        </button>
      )}
      <button type="button" className="nu-install-hint__dismiss" aria-label="Dismiss" onClick={close}>
        ✕
      </button>
    </div>
  );
}

import { useState } from 'react';
import { useMatrixClient } from '../matrix/MatrixClientContext';
import { useOwnProfile } from '../matrix/hooks/useOwnProfile';
import { usePublicWebEnabled } from '../matrix/hooks/usePublicWebEnabled';
import { publicPageUrl, setPublicWebEnabled } from '../matrix/publicWebSwitch';

/**
 * "Show my page to people who aren't signed in" (matrix/publicWebSwitch.ts), off by default.
 * Used in Account Settings → Privacy and in the page builder. It says what's public either way,
 * so turning it off doesn't look like it hides your Global posts.
 */
export function PublicPageSwitch() {
  const mx = useMatrixClient();
  const profile = useOwnProfile();
  const enabled = usePublicWebEnabled();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const url = publicPageUrl(mx);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      await setPublicWebEnabled(mx, next, profile.displayName || profile.userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change that');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="nu-field" data-nu-role="public-page-switch">
      <label className="nu-field__checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          data-nu-role="public-page-toggle"
          onChange={(evt) => void toggle(evt.target.checked)}
        />
        Show my page to people who aren’t signed in
      </label>
      <p className="nu-field__hint">
        {enabled && url ? (
          <>
            Anyone with the link can see your page, bio and banner: <a href={url}>{url}</a>
          </>
        ) : (
          'Off: signed-out visitors see “Sign in to see this page”. People signed in to Purrlor can always open it.'
        )}{' '}
        Your Global posts, with your avatar and username, are public either way.
      </p>
      {error && <p className="nu-field__error">{error}</p>}
    </div>
  );
}

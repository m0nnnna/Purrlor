import { useState } from 'react';
import { useMatrixClient } from '../matrix/MatrixClientContext';
import { setOver18 } from '../matrix/ageSetting';
import { useOver18 } from '../matrix/hooks/useOver18';
import { PublicPageSwitch } from './PublicPageSwitch';

/** Account Settings → Privacy: who can see what without signing in, and what you're shown. */
export function PrivacySettings() {
  const mx = useMatrixClient();
  const over18 = useOver18();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      await setOver18(mx, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change that');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="nu-privacy-settings" data-nu-role="privacy-settings">
      <PublicPageSwitch />
      <div className="nu-field" data-nu-role="age-setting">
        <label className="nu-field__checkbox-row">
          <input
            type="checkbox"
            checked={over18}
            disabled={saving}
            data-nu-role="age-toggle"
            onChange={(evt) => void toggle(evt.target.checked)}
          />
          I’m over 18
        </label>
        <p className="nu-field__hint">
          Artists can mark pieces on their pages as Mature. Without this they’re hidden from you; with it they’re blurred until you click.
        </p>
        {error && <p className="nu-field__error">{error}</p>}
      </div>
    </div>
  );
}

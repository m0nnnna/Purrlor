import { PublicPageSwitch } from './PublicPageSwitch';

/** Account Settings → Privacy: who can see what without signing in. */
export function PrivacySettings() {
  return (
    <div className="nu-privacy-settings" data-nu-role="privacy-settings">
      <PublicPageSwitch />
    </div>
  );
}

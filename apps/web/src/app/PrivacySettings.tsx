import { ErrorReportsSwitch } from './ErrorReportsSwitch';
import { PublicPageSwitch } from './PublicPageSwitch';

/** Account Settings → Privacy: who can see what without signing in, and what this browser reports. */
export function PrivacySettings() {
  return (
    <div className="nu-privacy-settings" data-nu-role="privacy-settings">
      <PublicPageSwitch />
      <ErrorReportsSwitch />
    </div>
  );
}

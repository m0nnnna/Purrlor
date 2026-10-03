import { useState } from 'react';
import { errorReportsEnabled, setErrorReportsEnabled } from './errorReporting';

/** Account Settings → Privacy: whether this browser sends its errors to the server (errorReporting.ts). */
export function ErrorReportsSwitch() {
  const [enabled, setEnabled] = useState(errorReportsEnabled);

  return (
    <div className="nu-field" data-nu-role="error-reports-switch">
      <label className="nu-field__checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          data-nu-role="error-reports-toggle"
          onChange={(evt) => {
            setErrorReportsEnabled(evt.target.checked);
            setEnabled(evt.target.checked);
          }}
        />
        Send error reports to this server
      </label>
      <p className="nu-field__hint">
        When the app hits an error, it tells the people who run this server what went wrong and on what kind of page,
        so they can fix it. Not who you are or what you were reading, and nothing goes anywhere else. Only for this
        browser.
      </p>
    </div>
  );
}

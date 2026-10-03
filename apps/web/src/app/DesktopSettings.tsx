import { useEffect, useState } from 'react';
import { desktopBridge, type DesktopInfo, type DesktopSettings as Settings } from '../desktop/desktopBridge';
import './VoiceSettings.css';

/**
 * Account Settings → Desktop, shown only inside the desktop app: its own settings, which it keeps
 * in its settings file on this PC (apps/desktop), not in the browser storage or on the server.
 */
export function DesktopSettings() {
  const bridge = desktopBridge();
  const [info, setInfo] = useState<DesktopInfo>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!bridge) return;
    bridge
      .request<DesktopInfo>('getInfo')
      .then(setInfo)
      // Desktop 1.0.0 has no bridge: it never answers.
      .catch(() => setError('Update the Purrlor desktop app to change its settings here.'));
    // The tray menu can change them too.
    return bridge.on('settings', (data) =>
      setInfo((current) => (current ? { ...current, settings: data as Settings } : current))
    );
  }, [bridge]);

  if (!bridge) return null;

  const set = async <K extends keyof Settings>(name: K, value: Settings[K]) => {
    if (!info) return;
    const before = info;
    setInfo({ ...info, settings: { ...info.settings, [name]: value } });
    try {
      await bridge.request('setSetting', { name, value });
    } catch (err) {
      setInfo(before);
      setError(err instanceof Error ? err.message : 'Couldn’t change that');
    }
  };

  return (
    <div className="nu-desktop-settings" data-nu-role="desktop-settings">
      {info && (
        <>
          <label className="nu-field__checkbox-row">
            <input
              type="checkbox"
              data-nu-role="desktop-start-with-windows"
              checked={info.settings.startWithWindows}
              onChange={(e) => void set('startWithWindows', e.target.checked)}
            />
            Start Purrlor with Windows (in the tray)
          </label>
          <div className="nu-field">
            <label className="nu-field__checkbox-row">
              <input
                type="checkbox"
                data-nu-role="desktop-close-to-tray"
                checked={info.settings.closeToTray}
                onChange={(e) => void set('closeToTray', e.target.checked)}
              />
              Closing the window keeps Purrlor running in the tray
            </label>
            <span className="nu-field__hint">
              So you keep getting notifications and stay in voice. Off, the close button quits Purrlor.
            </span>
          </div>
          <div className="nu-field">
            <div>
              <button type="button" className="nu-button nu-button--secondary" onClick={() => void bridge.request('changeServer')}>
                Change server…
              </button>
            </div>
          </div>
          <p className="nu-field__hint">Purrlor desktop {info.version}</p>
        </>
      )}
      {error && <p className="nu-field__error">{error}</p>}
    </div>
  );
}

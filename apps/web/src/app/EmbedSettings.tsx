import { useMatrixClient } from '../matrix/MatrixClientContext';
import { saveEmbedSettings, useEmbedSettings, type EmbedShow } from '../matrix/embedSettings';

const SHOW_OPTIONS: { value: EmbedShow; label: string }[] = [
  { value: 'all', label: 'Show all, players load when pressed' },
  { value: 'no-players', label: 'Cards only, no players' },
  { value: 'none', label: 'Plain links' },
];

/** Account Settings → Appearance: which link embeds to draw (matrix/embedSettings.ts). */
export function EmbedDisplaySetting() {
  const mx = useMatrixClient();
  const { show } = useEmbedSettings();
  return (
    <label className="nu-field" data-nu-role="embed-display-setting">
      Link embeds
      <select
        className="nu-field__input"
        data-nu-role="embed-display-select"
        value={show}
        onChange={(e) => void saveEmbedSettings(mx, { show: e.target.value as EmbedShow })}
      >
        {SHOW_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <span className="nu-field__hint">
        Cards, posts, players and pictures for links in messages and posts. Synced to your account. A player loads
        nothing from its site until you press play.
      </span>
    </label>
  );
}

/** Account Settings → Privacy: whether your messages in encrypted chats get link embeds (docs/embeds.md, rule 3). */
export function EmbedEncryptedSwitch() {
  const mx = useMatrixClient();
  const { encrypted } = useEmbedSettings();
  return (
    <div className="nu-field" data-nu-role="embed-encrypted-switch">
      <label className="nu-field__checkbox-row">
        <input
          type="checkbox"
          checked={encrypted}
          data-nu-role="embed-encrypted-toggle"
          onChange={(evt) => void saveEmbedSettings(mx, { encrypted: evt.target.checked })}
        />
        Link embeds in encrypted chats
      </label>
      <p className="nu-field__hint">
        Off, links you send in encrypted chats stay plain. On, this server looks them up to make the embed, so it sees
        those links (never the rest of the message). The embed itself is encrypted with your message, and the people
        reading it don’t fetch anything.
      </p>
    </div>
  );
}

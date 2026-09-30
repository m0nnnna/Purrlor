import { useState, type FormEvent } from 'react';
import { EventType, type Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  CHANNEL_SETTINGS_EVENT,
  readChannelPermissions,
  setPostingMode,
  setSlowmode,
  setVisibility,
  type PostingMode,
  type Visibility,
} from '../../matrix/channelPermissions';
import { canSendStateEvent } from '../../matrix/permissions';

const SLOWMODE_CHOICES: { seconds: number; label: string }[] = [
  { seconds: 0, label: 'Off' },
  { seconds: 5, label: '5 seconds' },
  { seconds: 10, label: '10 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
];

/**
 * A channel's permissions (matrix/channelPermissions.ts): who can post, who can see it, and
 * slowmode. Each setting is only offered to someone who can change it in that channel.
 */
export function ChannelPermissionsModal({ channel, space, onClose }: { channel: Room; space: Room; onClose: () => void }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const initial = readChannelPermissions(channel);
  const [posting, setPosting] = useState<PostingMode>(initial.posting);
  const [visibility, setVisibilityChoice] = useState<Visibility>(initial.visibility);
  const [slowmode, setSlowmodeChoice] = useState(initial.slowmodeSeconds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const canChangePosting = canSendStateEvent(channel, myUserId, EventType.RoomPowerLevels);
  const canChangeVisibility =
    canSendStateEvent(channel, myUserId, EventType.RoomJoinRules) && canSendStateEvent(channel, myUserId, CHANNEL_SETTINGS_EVENT);
  const canChangeSlowmode = canSendStateEvent(channel, myUserId, CHANNEL_SETTINGS_EVENT);
  // A value that isn't one of the choices (set elsewhere) still shows, rather than reading "Off".
  const slowmodeChoices = SLOWMODE_CHOICES.some((c) => c.seconds === slowmode)
    ? SLOWMODE_CHOICES
    : [...SLOWMODE_CHOICES, { seconds: slowmode, label: `${slowmode} seconds` }];

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (posting !== initial.posting) await setPostingMode(mx, channel, posting);
      if (slowmode !== initial.slowmodeSeconds) await setSlowmode(mx, channel, slowmode);
      if (visibility !== initial.visibility) await setVisibility(mx, channel, space, visibility);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the channel’s permissions');
      setSaving(false);
    }
  };

  return (
    <Modal title={`Permissions for #${channel.name}`} onClose={onClose}>
      <form className="nu-modal-form" onSubmit={handleSubmit} data-nu-role="channel-permissions">
        <label className="nu-field">
          Who can send messages
          <select
            className="nu-field__input"
            data-nu-role="channel-permissions-posting"
            value={posting}
            disabled={!canChangePosting}
            onChange={(e) => setPosting(e.target.value as PostingMode)}
          >
            <option value="everyone">Everyone</option>
            <option value="moderators">Moderators only (everyone can still react)</option>
          </select>
        </label>
        <label className="nu-field">
          Who can see this channel
          <select
            className="nu-field__input"
            data-nu-role="channel-permissions-visibility"
            value={visibility}
            disabled={!canChangeVisibility}
            onChange={(e) => setVisibilityChoice(e.target.value as Visibility)}
          >
            <option value="space">Everyone in {space.name}</option>
            <option value="moderators">Moderators only</option>
          </select>
          {visibility === 'moderators' && initial.visibility !== 'moderators' && (
            <span className="nu-field__hint">
              Everyone else in the channel is removed from it, and it disappears from their list. The Space’s moderators are
              added, now and whenever someone becomes one.
            </span>
          )}
        </label>
        <label className="nu-field">
          Slowmode
          <select
            className="nu-field__input"
            data-nu-role="channel-permissions-slowmode"
            value={slowmode}
            disabled={!canChangeSlowmode}
            onChange={(e) => setSlowmodeChoice(Number(e.target.value))}
          >
            {slowmodeChoices.map((choice) => (
              <option key={choice.seconds} value={choice.seconds}>
                {choice.label}
              </option>
            ))}
          </select>
          <span className="nu-field__hint">
            How long each member waits between messages. Moderators aren’t slowed down. Only Purrlor enforces this; other Matrix
            apps don’t know about it.
          </span>
        </label>
        {error && (
          <p className="nu-field__error" data-nu-role="channel-permissions-error">
            {error}
          </p>
        )}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="nu-button nu-button--primary" data-nu-role="channel-permissions-save" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

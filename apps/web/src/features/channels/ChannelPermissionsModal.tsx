import { useState, type FormEvent } from 'react';
import { EventType, type Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  CHANNEL_SETTINGS_EVENT,
  MODERATOR_LEVEL,
  readChannelPermissions,
  setChannelModerators,
  setPostingMode,
  spaceRoleLevels,
  setSlowmode,
  setNoPlayers,
  setVisibility,
  type PostingMode,
  type Visibility,
} from '../../matrix/channelPermissions';
import { canSendStateEvent } from '../../matrix/permissions';
import { canEnableEncryption, enableEncryption, isEncryptedRoom } from '../../matrix/encryption';
import { listWebhooks } from '../../matrix/webhooks';
import { useRoomMembers } from '../../matrix/hooks/useRoomMembers';
import './ChannelPermissionsModal.css';
import { fallbackName } from '../../matrix/displayName';

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
 * A channel's permissions (matrix/channelPermissions.ts): who can post, who can see it, slowmode,
 * who moderates this channel only (docs/roles.md), and turning on end-to-end encryption
 * (matrix/encryption.ts), which can't be undone. Each setting is only offered to someone who can
 * change it in that channel.
 */
export function ChannelPermissionsModal({ channel, space, onClose }: { channel: Room; space: Room; onClose: () => void }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const initial = readChannelPermissions(channel);
  const [posting, setPosting] = useState<PostingMode>(initial.posting);
  const [visibility, setVisibilityChoice] = useState<Visibility>(initial.visibility);
  const [slowmode, setSlowmodeChoice] = useState(initial.slowmodeSeconds);
  const [noPlayers, setNoPlayersChoice] = useState(initial.noPlayers);
  const [channelModerators, setChannelModeratorList] = useState<string[]>(initial.channelModerators);
  const spaceMembers = useRoomMembers(space.roomId);
  const spaceLevels = spaceRoleLevels(space);
  // Who could be made one: Space members who aren't a moderator there already, or one here.
  const candidates = spaceMembers
    .filter((m) => (spaceLevels[m.userId] ?? 0) < MODERATOR_LEVEL && !channelModerators.includes(m.userId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (userId: string) => spaceMembers.find((m) => m.userId === userId)?.name ?? fallbackName(userId);
  const alreadyEncrypted = isEncryptedRoom(channel);
  const [encrypt, setEncrypt] = useState(false);
  const webhookCount = listWebhooks(channel).length;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const canChangePosting = canSendStateEvent(channel, myUserId, EventType.RoomPowerLevels);
  const canChangeVisibility =
    canSendStateEvent(channel, myUserId, EventType.RoomJoinRules) && canSendStateEvent(channel, myUserId, CHANNEL_SETTINGS_EVENT);
  const canChangeSlowmode = canSendStateEvent(channel, myUserId, CHANNEL_SETTINGS_EVENT);
  const canChangeModerators = canChangeSlowmode && canChangePosting;
  const moderatorsChanged =
    channelModerators.length !== initial.channelModerators.length || channelModerators.some((id) => !initial.channelModerators.includes(id));
  const canEncrypt = canEnableEncryption(channel, myUserId);
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
      if (noPlayers !== initial.noPlayers) await setNoPlayers(mx, channel, noPlayers);
      if (visibility !== initial.visibility) await setVisibility(mx, channel, space, visibility);
      if (moderatorsChanged) await setChannelModerators(mx, channel, space, channelModerators);
      // Last, so a failure above doesn't leave the one change that can't be undone half-made.
      if (encrypt && !alreadyEncrypted) await enableEncryption(mx, channel);
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
        <div className="nu-field" data-nu-role="channel-permissions-no-players">
          <label className="nu-field__checkbox-row">
            <input
              type="checkbox"
              checked={noPlayers}
              disabled={!canChangeSlowmode}
              data-nu-role="channel-permissions-no-players-toggle"
              onChange={(e) => setNoPlayersChoice(e.target.checked)}
            />
            No players in link embeds
          </label>
          <span className="nu-field__hint">
            Videos and music linked here show as cards that open the site, rather than playing in the channel. Only Purrlor
            knows about this.
          </span>
        </div>
        <div className="nu-field" data-nu-role="channel-permissions-moderators">
          Channel moderators
          {channelModerators.length > 0 && (
            <ul className="nu-channel-moderators">
              {channelModerators.map((userId) => (
                <li key={userId} className="nu-channel-moderators__item" data-nu-role="channel-permissions-moderator">
                  <span>{nameOf(userId)}</span>
                  {canChangeModerators && (
                    <button
                      type="button"
                      className="nu-channel-moderators__remove"
                      data-nu-role="channel-permissions-moderator-remove"
                      aria-label={`Remove ${nameOf(userId)}`}
                      onClick={() => setChannelModeratorList((list) => list.filter((id) => id !== userId))}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canChangeModerators && candidates.length > 0 && (
            <select
              className="nu-field__input"
              data-nu-role="channel-permissions-moderator-add"
              value=""
              onChange={(e) => e.target.value && setChannelModeratorList((list) => [...list, e.target.value])}
            >
              <option value="">Add someone…</option>
              {candidates.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </select>
          )}
          <span className="nu-field__hint">
            Moderators of this channel only: they can delete messages and manage people here, and nowhere else in {space.name}. The
            Space’s own moderators already can.
          </span>
        </div>
        <div className="nu-field" data-nu-role="channel-permissions-encryption">
          Encryption
          {alreadyEncrypted ? (
            <span className="nu-field__hint" data-nu-role="channel-permissions-encrypted">
              End-to-end encrypted: only members’ devices can read this channel.
            </span>
          ) : (
            <>
              <label className="nu-field__checkbox-row">
                <input
                  type="checkbox"
                  data-nu-role="channel-permissions-encrypt"
                  checked={encrypt}
                  disabled={!canEncrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                />
                Turn on end-to-end encryption
              </label>
              {encrypt ? (
                <span className="nu-field__warning" data-nu-role="channel-permissions-encrypt-warning" role="alert">
                  <strong>This can’t be undone.</strong> Matrix has no way to turn encryption off again. Messages sent from now on
                  can only be read on members’ devices; earlier ones stay as they are.
                  {webhookCount > 0 &&
                    ` This channel’s ${webhookCount === 1 ? 'webhook' : `${webhookCount} webhooks`} will stop working: they can’t post in an encrypted channel.`}
                </span>
              ) : (
                <span className="nu-field__hint">Off. Messages here are readable by the servers that carry them.</span>
              )}
            </>
          )}
        </div>
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

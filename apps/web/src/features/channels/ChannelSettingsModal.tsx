import { useState, type FormEvent } from 'react';
import { EventType, type Room } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { canSendStateEvent } from '../../matrix/permissions';
import { updateRoomAvatar, updateRoomName, updateRoomTopic } from '../../matrix/roomCreation';

/** Whether this user can change at least one of a channel's name, topic and avatar. */
export function canEditChannelSettings(room: Room, userId: string): boolean {
  return [EventType.RoomName, EventType.RoomTopic, EventType.RoomAvatar].some((type) => canSendStateEvent(room, userId, type));
}

/**
 * A channel's name, topic and avatar, the way Space Settings → General does it for a Space. Each
 * is only editable by someone who can change it in that channel; the rest show as read-only. Only
 * what changed is sent, so saving an untouched form is a no-op.
 */
export function ChannelSettingsModal({ channel, onClose }: { channel: Room; onClose: () => void }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const currentTopic = channel.currentState.getStateEvents(EventType.RoomTopic, '')?.getContent<{ topic?: string }>().topic ?? '';
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(currentTopic);
  const [avatarFile, setAvatarFile] = useState<File>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const canName = canSendStateEvent(channel, myUserId, EventType.RoomName);
  const canTopic = canSendStateEvent(channel, myUserId, EventType.RoomTopic);
  const canAvatar = canSendStateEvent(channel, myUserId, EventType.RoomAvatar);

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const trimmedName = name.trim();
      const trimmedTopic = topic.trim();
      if (canName && trimmedName && trimmedName !== channel.name) await updateRoomName(mx, channel.roomId, trimmedName);
      if (canTopic && trimmedTopic !== currentTopic.trim()) await updateRoomTopic(mx, channel.roomId, trimmedTopic);
      if (canAvatar && avatarFile) await updateRoomAvatar(mx, channel.roomId, avatarFile);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the channel’s settings');
      setSaving(false);
    }
  };

  return (
    <Modal title={`Settings for #${channel.name}`} onClose={onClose}>
      <form className="nu-modal-form" onSubmit={handleSubmit} data-nu-role="channel-settings">
        <div className="nu-space-settings__avatar-row">
          <Avatar name={name || channel.name} mxcUrl={avatarFile ? null : channel.getMxcAvatarUrl()} size={56} />
          {canAvatar && (
            <label className="nu-button nu-button--secondary nu-file-picker nu-space-settings__avatar-picker">
              {avatarFile ? avatarFile.name : 'Change avatar'}
              <input type="file" accept="image/*" data-nu-role="channel-settings-avatar" onChange={(e) => setAvatarFile(e.target.files?.[0])} />
            </label>
          )}
        </div>
        <label className="nu-field">
          Name
          <input
            className="nu-field__input"
            data-nu-role="channel-settings-name"
            value={name}
            disabled={!canName}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="nu-field">
          Topic
          <textarea
            className="nu-field__textarea"
            data-nu-role="channel-settings-topic"
            value={topic}
            disabled={!canTopic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        {error && (
          <p className="nu-field__error" data-nu-role="channel-settings-error">
            {error}
          </p>
        )}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="nu-button nu-button--primary" data-nu-role="channel-settings-save" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

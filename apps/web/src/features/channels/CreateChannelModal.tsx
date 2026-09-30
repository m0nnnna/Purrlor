import { useState, type FormEvent } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import type { ChannelType } from '../../matrix/channelType';
import { useSpaceVoiceServer } from '../../matrix/hooks/useSpaceVoiceServer';
import { createRoom } from '../../matrix/roomCreation';
import { isRoomOnBotHomeserver, serverNameOf } from '../../matrix/voiceBot';
import './CreateChannelModal.css';

type CreateChannelModalProps = {
  space: Room;
  onClose: () => void;
  onCreated: (roomId: string) => void;
};

export function CreateChannelModal({ space, onClose, onCreated }: CreateChannelModalProps) {
  const mx = useMatrixClient();
  const voiceServer = useSpaceVoiceServer(space);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [channelType, setChannelType] = useState<ChannelType>('text');
  const [isPublic, setIsPublic] = useState(false);
  // Follows "Public" (on for a private channel, off for a public one) until chosen by hand.
  const [encryptedChoice, setEncryptedChoice] = useState<boolean>();
  const encrypted = encryptedChoice ?? !isPublic;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  // A new room is created on its creator's own homeserver, and the token server only serves
  // rooms created on its bot's (services/token-server/src/tenancy.ts) — so a federated member of
  // this Space can make a voice channel nobody will ever connect to. Said here, where it can
  // still be acted on, rather than as a puzzling failure the first time someone clicks it.
  // A new room is created on your own homeserver, so that's its origin.
  const voiceWouldWork = isRoomOnBotHomeserver(serverNameOf(mx.getUserId() ?? ''), voiceServer?.botUserId);

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const roomId = await createRoom(mx, {
        name: trimmedName,
        topic: topic.trim(),
        isPublic,
        parentSpace: space,
        channelType,
        encrypted,
        // A voice channel the token server's bot isn't in can't authorize anyone into the call,
        // and a Space-level invite never reaches its channels — so invite it here, at creation,
        // rather than leaving every new voice channel dead until someone works that out.
        invite: channelType === 'voice' && voiceServer?.botUserId ? [voiceServer.botUserId] : undefined,
      });
      onCreated(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`Create a channel in ${space.name}`} onClose={onClose}>
      <form className="nu-modal-form" onSubmit={handleSubmit}>
        <div className="nu-field">
          Channel type
          <div className="nu-channel-type-choice" data-nu-role="create-channel-type">
            <button
              type="button"
              className={
                channelType === 'text'
                  ? 'nu-channel-type-choice__option nu-channel-type-choice__option--active'
                  : 'nu-channel-type-choice__option'
              }
              onClick={() => setChannelType('text')}
            >
              # Text
            </button>
            <button
              type="button"
              className={
                channelType === 'voice'
                  ? 'nu-channel-type-choice__option nu-channel-type-choice__option--active'
                  : 'nu-channel-type-choice__option'
              }
              onClick={() => setChannelType('voice')}
            >
              🔊 Voice
            </button>
          </div>
          {channelType === 'voice' && !voiceServer && (
            <span className="nu-field__hint" data-nu-role="create-channel-no-voice-server">
              This Space has no voice server configured yet, so nobody will be able to connect to
              this channel — set one under Space Settings → General.
            </span>
          )}
          {channelType === 'voice' && voiceServer && !voiceWouldWork && (
            <span className="nu-field__hint" data-nu-role="create-channel-wrong-homeserver">
              This space's voice server only serves channels created on{' '}
              {serverNameOf(voiceServer.botUserId ?? '')}, and your account is on{' '}
              {serverNameOf(mx.getUserId() ?? '')} — a voice channel you create here won't connect.
              Ask someone with an account there to create it instead.
            </span>
          )}
        </div>
        <label className="nu-field">
          Channel name
          <input
            className="nu-field__input"
            data-nu-role="create-channel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="nu-field">
          Topic (optional)
          <textarea className="nu-field__textarea" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </label>
        <label className="nu-field__checkbox-row">
          <input type="checkbox" data-nu-role="create-channel-public" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          Public — anyone can find and join
        </label>
        <label className="nu-field__checkbox-row">
          <input
            type="checkbox"
            data-nu-role="create-channel-encrypted"
            checked={encrypted}
            onChange={(e) => setEncryptedChoice(e.target.checked)}
          />
          End-to-end encrypted — only members’ devices can read it
        </label>
        {encrypted && (
          <span className="nu-field__hint" data-nu-role="create-channel-encrypted-hint">
            {isPublic ? 'A public channel anyone can join gains little from encryption. ' : ''}
            This can’t be turned off later, and webhooks can’t post in an encrypted channel.
          </span>
        )}
        {error && (
          <p className="nu-field__error" data-nu-role="create-channel-error">
            {error}
          </p>
        )}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="nu-button nu-button--primary" disabled={!name.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

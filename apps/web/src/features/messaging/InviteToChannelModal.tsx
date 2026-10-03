import { useState, type FormEvent } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { isValidUserId } from '../../matrix/directMessages';
import { inviteToChannel } from '../../matrix/invites';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import './InviteToChannelModal.css';

/**
 * Invites a Matrix ID into this channel, and into its Space when they aren't in it yet
 * (inviteToChannel, matrix/invites.ts): Space membership doesn't cascade to child rooms, and a
 * channel invited to on its own, with no Space of theirs around it, showed up among the other
 * person's Direct Messages. Mirrors StartDmModal's form.
 *
 * The voice token server's service bot used to be the main thing people had to do this for, and
 * nothing in the app told them so — that's now automatic (matrix/voiceBot.ts): new voice
 * channels invite it at creation, and joining an older one invites it on the spot. This stays
 * the manual escape hatch for a Space with no bot configured, or one whose admin removed it.
 */
export function InviteToChannelModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const mx = useMatrixClient();
  const [userId, setUserId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string>();
  const [invited, setInvited] = useState<{ userId: string; space: boolean }[]>([]);

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    const trimmed = userId.trim();
    if (!trimmed || inviting) return;
    if (!isValidUserId(trimmed)) {
      setError('Enter a full Matrix ID, like @friend:example.com or @some-bot:example.com');
      return;
    }
    setInviting(true);
    setError(undefined);
    try {
      const { space } = await inviteToChannel(mx, room, trimmed);
      setInvited((prev) => [{ userId: trimmed, space }, ...prev]);
      setUserId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite');
    } finally {
      setInviting(false);
    }
  };

  return (
    <Modal title={`Invite to #${room.name}`} onClose={onClose}>
      <form className="nu-modal-form" onSubmit={handleSubmit}>
        <label className="nu-field">
          Matrix ID
          <input
            className="nu-field__input"
            data-nu-role="invite-channel-user-id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="@friend:example.com"
            autoFocus
            required
          />
          <span className="nu-field__hint">
            Someone who isn't in this Space yet is invited to the Space as well (when you're
            allowed to invite there), so the channel shows up inside it for them. Voice channels
            invite the voice service account for you, so this is only needed for it if the Space
            has none configured (Space Settings → General).
          </span>
        </label>
        {error && (
          <p className="nu-field__error" data-nu-role="invite-channel-error">
            {error}
          </p>
        )}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="nu-button nu-button--primary" disabled={!userId.trim() || inviting}>
            {inviting ? 'Inviting…' : 'Invite'}
          </button>
        </div>
      </form>
      {invited.length > 0 && (
        <ul className="nu-invite-channel__sent" data-nu-role="invite-channel-sent-list">
          {invited.map(({ userId: id, space }) => (
            <li key={id}>
              Invited {id}
              {space && ' to this channel and the Space'}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

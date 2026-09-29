import { useState, type FormEvent } from 'react';
import { EventType, type Room } from 'matrix-js-sdk';
import { useConfirm } from '../../components/ConfirmDialog';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  canModerateLibrary,
  canMuteInLibrary,
  canRemoveLibraryPack,
  isMutedInLibrary,
  readLibraryPacks,
  removeLibraryPack,
  setLibraryImageHidden,
  setLibraryMuted,
  type LibraryPack,
} from '../../matrix/emoteLibrary';
import { canSendStateEvent, defaultUserPowerLevel, roomAdmins, userPowerLevel } from '../../matrix/permissions';
import { EmoteImage } from './EmoteImage';

const MODERATOR_LEVEL = 50;

function fullUserId(raw: string, serverName: string): string {
  const name = raw.trim().replace(/^@/, '');
  return name.includes(':') ? `@${name}` : `@${name}:${serverName}`;
}

/**
 * The global emote library's moderation (matrix/emoteLibrary.ts explains each action): hide a
 * single image, take down someone's whole pack, mute someone so they can't add more, and — for
 * whoever can change power levels — appoint moderators. Shown inside EmoteManagerModal. `room` is
 * the library, re-read on every render (the manager re-renders whenever the library changes).
 */
export function EmoteLibraryModeration({ room }: { room: Room }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [newModerator, setNewModerator] = useState('');

  const packs = readLibraryPacks(room).sort((a, b) => a.owner.localeCompare(b.owner));
  const nameOf = (userId: string) => room.getMember(userId)?.name ?? userId;
  const canAppoint = canSendStateEvent(room, myUserId, EventType.RoomPowerLevels);
  const powerUsers = Object.keys(
    room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent<{ users?: Record<string, number> }>().users ?? {}
  );
  // roomAdmins adds the creator, who on room version 12 isn't listed in the power levels at all.
  const moderators = [...new Set([...roomAdmins(room), ...powerUsers.filter((userId) => canModerateLibrary(room, userId))])];
  // Muted people with nothing left in the library still need a way to be unmuted.
  const mutedWithoutPack = powerUsers.filter(
    (userId) => isMutedInLibrary(room, userId) && !packs.some((pack) => pack.owner === userId)
  );

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through');
    } finally {
      setBusy(undefined);
    }
  };

  const removePack = async (pack: LibraryPack) => {
    const ok = await confirm({
      title: 'Remove their emotes?',
      message: `Every image ${nameOf(pack.owner)} added to the global library (${pack.images.length}) stops showing for everyone. They can add new ones unless you mute them too.`,
      confirmLabel: 'Remove all',
    });
    if (ok) await run(`pack-${pack.owner}`, () => removeLibraryPack(mx, room, pack));
  };

  const toggleMute = (userId: string) => {
    const muted = isMutedInLibrary(room, userId);
    return run(`mute-${userId}`, () => setLibraryMuted(mx, room, userId, !muted));
  };

  const handleAppoint = (evt: FormEvent) => {
    evt.preventDefault();
    const serverName = mx.getDomain();
    if (!newModerator.trim() || !serverName) return;
    const userId = fullUserId(newModerator, serverName);
    void run('appoint', async () => {
      await mx.setPowerLevel(room.roomId, userId, MODERATOR_LEVEL);
      setNewModerator('');
    });
  };

  const muteButton = (userId: string) =>
    canMuteInLibrary(room, myUserId, userId) && (
      <button
        type="button"
        className="nu-emote-manager__remove"
        disabled={busy === `mute-${userId}`}
        onClick={() => void toggleMute(userId)}
      >
        {isMutedInLibrary(room, userId) ? 'Unmute' : 'Mute'}
      </button>
    );

  return (
    <div className="nu-emote-manager" data-nu-role="emote-library-moderation">
      {error && <p className="nu-field__error">{error}</p>}

      <p className="nu-field__hint">Moderators</p>
      <div className="nu-emote-manager__list">
        {moderators.map((userId) => (
          <div className="nu-emote-manager__item" key={`mod-${userId}`}>
            <span className="nu-emote-manager__item-code">{nameOf(userId)}</span>
            {canAppoint && userId !== myUserId && userPowerLevel(room, myUserId) > userPowerLevel(room, userId) && (
              <button
                type="button"
                className="nu-emote-manager__remove"
                disabled={busy === `unmod-${userId}`}
                onClick={() =>
                  void run(`unmod-${userId}`, async () => {
                    await mx.setPowerLevel(room.roomId, userId, defaultUserPowerLevel(room));
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {canAppoint && (
        <form className="nu-modal-form" onSubmit={handleAppoint}>
          <label className="nu-field">
            Add a moderator
            <input
              className="nu-field__input"
              value={newModerator}
              onChange={(e) => setNewModerator(e.target.value)}
              placeholder="@name:server"
            />
          </label>
          <div className="nu-form-actions">
            <button type="submit" className="nu-button nu-button--secondary" disabled={!newModerator.trim() || busy === 'appoint'}>
              Make moderator
            </button>
          </div>
        </form>
      )}

      {packs.length === 0 && <p className="nu-field__hint">Nobody has added anything to the global library yet.</p>}
      {packs.map((pack) => (
        <div key={pack.owner} data-nu-role="emote-library-pack">
          <div className="nu-emote-manager__item">
            <span className="nu-emote-manager__item-code">
              {nameOf(pack.owner)} · {pack.images.length}{' '}
              {isMutedInLibrary(room, pack.owner) && <span className="nu-emote-manager__item-scope">muted</span>}
            </span>
            {muteButton(pack.owner)}
            {canRemoveLibraryPack(room, myUserId, pack) && (
              <button
                type="button"
                className="nu-emote-manager__remove"
                disabled={busy === `pack-${pack.owner}`}
                onClick={() => void removePack(pack)}
              >
                Remove all
              </button>
            )}
          </div>
          <div className="nu-emote-manager__list">
            {pack.images.map((image) => (
              <div
                className={image.hidden ? 'nu-emote-manager__item nu-emote-manager__item--hidden' : 'nu-emote-manager__item'}
                key={`${pack.owner}-${image.shortcode}`}
              >
                <EmoteImage shortcode={image.shortcode} mxcUrl={image.mxcUrl} />
                <span className="nu-emote-manager__item-code">
                  :{image.shortcode}: {image.hidden && <span className="nu-emote-manager__item-scope">hidden</span>}
                </span>
                <button
                  type="button"
                  className="nu-emote-manager__remove"
                  disabled={busy === `hide-${image.mxcUrl}`}
                  onClick={() => void run(`hide-${image.mxcUrl}`, () => setLibraryImageHidden(mx, room, image.mxcUrl, !image.hidden))}
                >
                  {image.hidden ? 'Unhide' : 'Hide'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {mutedWithoutPack.length > 0 && (
        <>
          <p className="nu-field__hint">Muted</p>
          <div className="nu-emote-manager__list">
            {mutedWithoutPack.map((userId) => (
              <div className="nu-emote-manager__item" key={`muted-${userId}`}>
                <span className="nu-emote-manager__item-code">{nameOf(userId)}</span>
                {muteButton(userId)}
              </div>
            ))}
          </div>
        </>
      )}
      {dialog}
    </div>
  );
}

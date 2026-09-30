import { useState } from 'react';
import type { Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { isBackgroundRoom } from '../../matrix/backgroundRooms';
import { addRoomToSpace } from '../../matrix/spaceChildren';
import './AddExistingChannelModal.css';

/** Lets an existing room (one you're already in, not a Space, not already a child of this one)
 *  become a channel here — the create-time flow (CreateChannelModal) always made a brand new
 *  room; this is the "link something that already exists" half the README long flagged as
 *  missing. No cross-server room directory search — just what this client already knows about,
 *  matching the "type it / pick from what you have" narrowing used elsewhere (StartDmModal). */
export function AddExistingChannelModal({
  space,
  existingRoomIds,
  onClose,
}: {
  space: Room;
  existingRoomIds: Set<string>;
  onClose: () => void;
}) {
  const mx = useMatrixClient();
  const [busyRoomId, setBusyRoomId] = useState<string>();
  const [error, setError] = useState<string>();

  const candidates = mx
    .getRooms()
    .filter(
      (room) =>
        !room.isSpaceRoom() && !isBackgroundRoom(room) && room.roomId !== space.roomId && !existingRoomIds.has(room.roomId)
    );

  const handleAdd = async (room: Room) => {
    setBusyRoomId(room.roomId);
    setError(undefined);
    try {
      await addRoomToSpace(mx, space, room);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add channel');
      setBusyRoomId(undefined);
    }
  };

  return (
    <Modal title={`Add an existing channel to ${space.name}`} onClose={onClose}>
      <div className="nu-modal-form">
        {error && (
          <p className="nu-field__error" data-nu-role="add-existing-channel-error">
            {error}
          </p>
        )}
        {candidates.length === 0 ? (
          <p className="nu-add-existing-channel__empty">
            Nothing to add — everything you're in is already here, is a Space itself, or is a
            direct message.
          </p>
        ) : (
          <div className="nu-add-existing-channel__list" data-nu-role="add-existing-channel-list">
            {candidates.map((room) => (
              <div key={room.roomId} className="nu-add-existing-channel__row" data-nu-role="add-existing-channel-row">
                <span className="nu-add-existing-channel__name">{room.name}</span>
                <button
                  type="button"
                  className="nu-button nu-button--secondary"
                  data-nu-role="add-existing-channel-submit"
                  disabled={busyRoomId === room.roomId}
                  onClick={() => handleAdd(room)}
                >
                  {busyRoomId === room.roomId ? 'Adding…' : 'Add'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

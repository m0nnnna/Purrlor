import { useMemo, useState } from 'react';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { Modal } from '../../components/Modal';
import { readChannelType } from '../../matrix/channelType';
import { looksLikeEmoteLibrary } from '../../matrix/emoteLibrary';
import { forwardMessage } from '../../matrix/forward';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import './ForwardMessageModal.css';

type TargetGroup = { label: string; rooms: Room[] };

/**
 * Text-channel picker for "Forward" (a message hover action, MessageTimeline.tsx). Computed
 * once on open rather than kept live — a modal open for a few seconds isn't worth the
 * event-listener bookkeeping a reactive room list needs elsewhere in this app.
 */
function useForwardTargets(): TargetGroup[] {
  const mx = useMatrixClient();
  return useMemo(() => {
    const allRooms = mx.getRooms().filter((room) => room.getMyMembership() === 'join' && !looksLikeEmoteLibrary(room));
    const spaces = allRooms.filter((room) => room.isSpaceRoom()).sort((a, b) => a.name.localeCompare(b.name));
    const spaceChildIds = new Set<string>();
    const groups: TargetGroup[] = [];

    for (const space of spaces) {
      const children = allRooms
        .filter((room) => !room.isSpaceRoom() && readChannelType(room) === 'text' && room.currentState.getStateEvents('m.space.parent', space.roomId))
        .sort((a, b) => a.name.localeCompare(b.name));
      children.forEach((room) => spaceChildIds.add(room.roomId));
      if (children.length > 0) groups.push({ label: space.name, rooms: children });
    }

    const spaceless = allRooms
      .filter((room) => !room.isSpaceRoom() && !spaceChildIds.has(room.roomId) && readChannelType(room) === 'text')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (spaceless.length > 0) groups.push({ label: 'Direct Messages', rooms: spaceless });

    return groups;
  }, [mx]);
}

export function ForwardMessageModal({ event, onClose }: { event: MatrixEvent; onClose: () => void }) {
  const mx = useMatrixClient();
  const groups = useForwardTargets();
  const [filter, setFilter] = useState('');
  const [forwardingTo, setForwardingTo] = useState<string>();
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredGroups = normalizedFilter
    ? groups
        .map((group) => ({ ...group, rooms: group.rooms.filter((room) => room.name.toLowerCase().includes(normalizedFilter)) }))
        .filter((group) => group.rooms.length > 0)
    : groups;

  const handleForward = async (roomId: string) => {
    if (forwardingTo) return;
    setForwardingTo(roomId);
    setError(undefined);
    try {
      await forwardMessage(mx, roomId, event);
      setSentTo((prev) => new Set(prev).add(roomId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to forward message');
    } finally {
      setForwardingTo(undefined);
    }
  };

  return (
    <Modal title="Forward Message" onClose={onClose}>
      <input
        className="nu-field__input nu-forward-message__filter"
        data-nu-role="forward-message-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Find a channel…"
        autoFocus
      />
      {error && (
        <p className="nu-field__error" data-nu-role="forward-message-error">
          {error}
        </p>
      )}
      {filteredGroups.length === 0 ? (
        <p className="nu-forward-message__empty" data-nu-role="forward-message-empty">
          No channels found.
        </p>
      ) : (
        <div className="nu-forward-message__list" data-nu-role="forward-message-list">
          {filteredGroups.map((group) => (
            <div key={group.label} className="nu-forward-message__group">
              <div className="nu-forward-message__group-label">{group.label}</div>
              {group.rooms.map((room) => {
                const sent = sentTo.has(room.roomId);
                return (
                  <button
                    key={room.roomId}
                    type="button"
                    className="nu-forward-message__room"
                    data-nu-role="forward-message-room"
                    disabled={forwardingTo === room.roomId}
                    onClick={() => handleForward(room.roomId)}
                  >
                    <span># {room.name}</span>
                    <span className="nu-forward-message__room-status">
                      {sent ? 'Sent ✓' : forwardingTo === room.roomId ? 'Sending…' : 'Forward'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

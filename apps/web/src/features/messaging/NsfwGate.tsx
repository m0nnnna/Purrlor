import { useState, type ReactNode } from 'react';
import type { Room } from 'matrix-js-sdk';
import { useSetAtom } from 'jotai';
import { selectedRoomIdAtom } from '../../app/state/selection';
import { useChannelPermissions } from '../../matrix/hooks/useChannelPermissions';
import './NsfwGate.css';

const STORAGE_KEY = 'nu.nsfwAccepted';

function accepted(roomId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]).includes(roomId);
  } catch {
    return false;
  }
}

function remember(roomId: string): void {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set([...list, roomId])]));
  } catch {
    // Storage unavailable: the warning just shows again next time.
  }
}

/** A channel marked NSFW shows this warning the first time someone opens it (remembered on this
 *  device afterward), so nobody lands in it unprepared at work. */
export function NsfwGate({ room, children }: { room: Room; children: ReactNode }) {
  const { nsfw } = useChannelPermissions(room);
  const [entered, setEntered] = useState(() => accepted(room.roomId));
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  if (!nsfw || entered) return <>{children}</>;
  return (
    <main className="nu-main-pane nu-nsfw-gate" data-nu-role="nsfw-gate">
      <span className="nu-nsfw-gate__tag">NSFW</span>
      <h1 className="nu-nsfw-gate__title">Do not open this at work</h1>
      <p className="nu-nsfw-gate__hint">
        #{room.name} is marked NSFW. It may contain adult content that isn’t safe to have on screen around other people.
      </p>
      <div className="nu-nsfw-gate__actions">
        <button type="button" className="nu-nsfw-gate__back" onClick={() => setSelectedRoomId(null)}>
          Go back
        </button>
        <button
          type="button"
          className="nu-nsfw-gate__enter"
          data-nu-role="nsfw-gate-enter"
          onClick={() => {
            remember(room.roomId);
            setEntered(true);
          }}
        >
          I’m 18+ and want to continue
        </button>
      </div>
    </main>
  );
}

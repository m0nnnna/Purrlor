import { afterEach, describe, expect, it } from 'vitest';
import { MatrixEvent, RoomMember, type RoomState } from 'matrix-js-sdk';
import { fallbackName, installMemberNameFallback, nameOrFallback } from './displayName';
import { setHomeServer } from './homeServer';

afterEach(() => setHomeServer(undefined));

function memberEvent(userId: string, displayname?: string): MatrixEvent {
  return new MatrixEvent({
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    room_id: '!r:purr.example',
    content: { membership: 'join', ...(displayname && { displayname }) },
  });
}

// setMembershipEvent only asks the room state about other members with the same name.
const roomState = { getUserIdsWithDisplayName: () => [] } as unknown as RoomState;

describe('fallbackName', () => {
  it("is this server's people's localpart, without the @", () => {
    setHomeServer('purr.example');
    expect(fallbackName('@mino:purr.example')).toBe('mino');
  });

  it("keeps another server's people's server, so same-named people stay apart", () => {
    setHomeServer('purr.example');
    expect(fallbackName('@mochi:cats.example')).toBe('mochi:cats.example');
  });
});

describe('nameOrFallback', () => {
  it('prefers a real display name', () => {
    expect(nameOrFallback('Mino', '@mino:purr.example')).toBe('Mino');
  });

  it('treats a missing, blank or user-ID name as none', () => {
    setHomeServer('purr.example');
    for (const name of [undefined, null, '', '  ', '@mino:purr.example']) {
      expect(nameOrFallback(name, '@mino:purr.example')).toBe('mino');
    }
  });
});

describe('installMemberNameFallback', () => {
  it('names a room member with no display name by their handle', () => {
    setHomeServer('purr.example');
    installMemberNameFallback();
    const member = new RoomMember('!r:purr.example', '@mino:purr.example');
    member.setMembershipEvent(memberEvent('@mino:purr.example'), roomState);
    expect(member.name).toBe('mino');
  });

  it('leaves a real display name alone', () => {
    installMemberNameFallback();
    const member = new RoomMember('!r:purr.example', '@luna:purr.example');
    member.setMembershipEvent(memberEvent('@luna:purr.example', 'Luna'), roomState);
    expect(member.name).toBe('Luna');
  });
});

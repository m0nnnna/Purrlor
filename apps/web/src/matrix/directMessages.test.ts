import { describe, expect, it, vi } from 'vitest';
import { findExistingDirectMessageRoomId, findPendingDirectMessageInviteRoomId, isValidUserId, openDirectMessage } from './directMessages';

describe('isValidUserId', () => {
  it.each([
    '@alice:example.org',
    '@bob:matrix.org',
    '@a.b-c_d=e:sub.example.org',
    '@user:localhost',
  ])('accepts a well-formed Matrix ID: %s', (userId) => {
    expect(isValidUserId(userId)).toBe(true);
  });

  it.each([
    'alice:example.org', // missing leading @
    '@alice', // missing :domain
    '@:example.org', // empty localpart
    '@alice example.org', // whitespace instead of colon
    '',
    'not a matrix id at all',
  ])('rejects a malformed value: %s', (value) => {
    expect(isValidUserId(value)).toBe(false);
  });
});

const ME = '@me:example.org';
const THEM = '@them:example.org';

type FakeMember = { userId: string; membership: string };
type FakeStateEvent = { getStateKey: () => string; getContent: () => Record<string, unknown>; getSender?: () => string };
type FakeRoom = {
  roomId: string;
  isSpaceRoom: () => boolean;
  getMembers: () => FakeMember[];
  getMyMembership: () => string;
  getType: () => string | undefined;
  getLastActiveTimestamp: () => number;
  currentState: { getStateEvents: (type: string, stateKey?: string) => FakeStateEvent[] | FakeStateEvent | null };
};

function fakeClient(myUserId: string, rooms: FakeRoom[], direct: Record<string, string[]> = {}) {
  return {
    getUserId: () => myUserId,
    getRooms: () => rooms,
    getRoom: (roomId: string) => rooms.find((room) => room.roomId === roomId) ?? null,
    getAccountData: (type: string) => (type === 'm.direct' ? { getContent: () => direct } : undefined),
    setAccountData: vi.fn(async () => ({})),
    joinRoom: vi.fn(async () => ({})),
    createRoom: vi.fn(async () => ({ room_id: '!new:example.org' })),
  } as unknown as Parameters<typeof findExistingDirectMessageRoomId>[0] & {
    joinRoom: ReturnType<typeof vi.fn>;
    createRoom: ReturnType<typeof vi.fn>;
  };
}

function fakeRoom(
  roomId: string,
  memberIds: string[],
  {
    isSpace = false,
    children = [] as string[],
    parent = undefined as string | undefined,
    lastActive = 0,
    invited = [] as string[],
    myMembership = 'join',
    invite = undefined as { from: string; isDirect: boolean } | undefined,
  } = {}
): FakeRoom {
  const myInvite: FakeStateEvent | null = invite
    ? { getStateKey: () => ME, getSender: () => invite.from, getContent: () => ({ membership: 'invite', is_direct: invite.isDirect }) }
    : null;
  const state: Record<string, FakeStateEvent[]> = {
    'm.space.child': children.map((child) => ({ getStateKey: () => child, getContent: () => ({ via: ['example.org'] }) })),
    'm.space.parent': parent ? [{ getStateKey: () => parent, getContent: () => ({ via: ['example.org'] }) }] : [],
  };
  return {
    roomId,
    isSpaceRoom: () => isSpace,
    getMembers: () => [
      ...memberIds.map((userId) => ({ userId, membership: 'join' })),
      ...invited.map((userId) => ({ userId, membership: 'invite' })),
    ],
    getMyMembership: () => myMembership,
    getType: () => (isSpace ? 'm.space' : undefined),
    getLastActiveTimestamp: () => lastActive,
    currentState: {
      getStateEvents: (type, stateKey) =>
        stateKey === undefined ? state[type] ?? [] : type === 'm.room.member' && stateKey === ME ? myInvite : null,
    },
  };
}


describe('findExistingDirectMessageRoomId', () => {
  it('finds a room with exactly the two of you joined', () => {
    const mx = fakeClient(ME, [fakeRoom('!dm:example.org', [ME, THEM])]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBe('!dm:example.org');
  });

  it('ignores a group chat with more than two members', () => {
    const mx = fakeClient(ME, [fakeRoom('!group:example.org', [ME, THEM, '@someone-else:example.org'])]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBeUndefined();
  });

  it('ignores Space rooms even if they happen to have two members', () => {
    const mx = fakeClient(ME, [fakeRoom('!space:example.org', [ME, THEM], { isSpace: true })]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBeUndefined();
  });

  it("ignores a Space's channel with just the two of you in it", () => {
    const mx = fakeClient(ME, [
      fakeRoom('!general:example.org', [ME, THEM], { lastActive: 2 }),
      fakeRoom('!space:example.org', [ME, THEM], { isSpace: true, children: ['!general:example.org'] }),
      fakeRoom('!dm:example.org', [ME, THEM], { lastActive: 1 }),
    ]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBe('!dm:example.org');
  });

  it('ignores a room that names a Space as its parent', () => {
    const mx = fakeClient(ME, [fakeRoom('!general:example.org', [ME, THEM], { parent: '!left-space:example.org' })]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBeUndefined();
  });

  it('prefers the room m.direct records for that user', () => {
    const mx = fakeClient(
      ME,
      [fakeRoom('!other:example.org', [ME, THEM], { lastActive: 2 }), fakeRoom('!dm:example.org', [ME, THEM], { lastActive: 1 })],
      { [THEM]: ['!dm:example.org'] }
    );
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBe('!dm:example.org');
  });

  it('finds a DM you started that they have not accepted yet', () => {
    const mx = fakeClient(ME, [fakeRoom('!dm:example.org', [ME], { invited: [THEM] })]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBe('!dm:example.org');
  });

  it('returns undefined when no DM with that user exists', () => {
    const mx = fakeClient(ME, [fakeRoom('!dm:example.org', [ME, '@someone-else:example.org'])]);
    expect(findExistingDirectMessageRoomId(mx, THEM)).toBeUndefined();
  });
});

describe('findPendingDirectMessageInviteRoomId', () => {
  it("finds a DM they've invited you to", () => {
    const mx = fakeClient(ME, [fakeRoom('!dm:example.org', [THEM], { myMembership: 'invite', invite: { from: THEM, isDirect: true } })]);
    expect(findPendingDirectMessageInviteRoomId(mx, THEM)).toBe('!dm:example.org');
  });

  it("ignores an invite that isn't a DM, or is from someone else", () => {
    const mx = fakeClient(ME, [
      fakeRoom('!group:example.org', [THEM], { myMembership: 'invite', invite: { from: THEM, isDirect: false } }),
      fakeRoom('!dm:example.org', ['@other:example.org'], { myMembership: 'invite', invite: { from: '@other:example.org', isDirect: true } }),
    ]);
    expect(findPendingDirectMessageInviteRoomId(mx, THEM)).toBeUndefined();
  });
});

describe('openDirectMessage', () => {
  it('reopens the DM you started while they have not accepted, instead of starting another', async () => {
    const mx = fakeClient(ME, [fakeRoom('!dm:example.org', [ME], { invited: [THEM] })]);
    await expect(openDirectMessage(mx, THEM)).resolves.toBe('!dm:example.org');
    expect(mx.createRoom).not.toHaveBeenCalled();
  });

  it('accepts their pending DM invite rather than starting a second DM', async () => {
    const mx = fakeClient(ME, [fakeRoom('!dm:example.org', [THEM], { myMembership: 'invite', invite: { from: THEM, isDirect: true } })]);
    await expect(openDirectMessage(mx, THEM)).resolves.toBe('!dm:example.org');
    expect(mx.joinRoom).toHaveBeenCalledWith('!dm:example.org');
    expect(mx.createRoom).not.toHaveBeenCalled();
  });

  it('starts a new DM when there is neither', async () => {
    const mx = fakeClient(ME, []);
    await expect(openDirectMessage(mx, THEM)).resolves.toBe('!new:example.org');
  });
});

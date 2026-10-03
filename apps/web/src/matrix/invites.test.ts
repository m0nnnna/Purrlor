import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { acceptInvite, classifyInvite, declineInvite, inviteToChannel, parentSpaceOf } from './invites';

function fakeRoom({ isSpace = false, parentSpaceId, via }: { isSpace?: boolean; parentSpaceId?: string; via?: string[] } = {}): Room {
  return {
    isSpaceRoom: () => isSpace,
    currentState: {
      getStateEvents: () =>
        parentSpaceId
          ? [{ getStateKey: () => parentSpaceId, getContent: () => (via ? { via } : {}) }]
          : [],
    },
  } as unknown as Room;
}

function fakeClient(rooms: Record<string, Room> = {}): MatrixClient {
  return {
    getRoom: (id: string) => rooms[id] ?? null,
  } as unknown as MatrixClient;
}

describe('classifyInvite', () => {
  it('classifies a Space invite', () => {
    const mx = fakeClient();
    expect(classifyInvite(mx, fakeRoom({ isSpace: true }))).toBe('space');
  });

  it('classifies an invite to a channel with a known parent Space', () => {
    const parentSpace = fakeRoom({ isSpace: true });
    const mx = fakeClient({ '!space:example.org': parentSpace });
    expect(classifyInvite(mx, fakeRoom({ parentSpaceId: '!space:example.org' }))).toBe('channel');
  });

  it("classifies a channel of a Space you aren't in (another instance's) as a channel, not a DM", () => {
    const mx = fakeClient();
    expect(classifyInvite(mx, fakeRoom({ parentSpaceId: '!space:cats.example' }))).toBe('channel');
  });

  it('falls back to "dm" for a non-space room with no discoverable parent Space', () => {
    const mx = fakeClient();
    expect(classifyInvite(mx, fakeRoom())).toBe('dm');
  });
});

describe('parentSpaceOf', () => {
  it("reads the parent's ID and its via servers", () => {
    expect(parentSpaceOf(fakeRoom({ parentSpaceId: '!s:cats.example', via: ['cats.example', 7 as unknown as string] }))).toEqual({
      roomId: '!s:cats.example',
      via: ['cats.example'],
    });
  });
});

describe('acceptInvite', () => {
  function client({ parent, spaceMembership }: { parent?: { id: string; via?: string[] }; spaceMembership?: string } = {}) {
    const joinRoom = vi.fn().mockResolvedValue({});
    const roomState = vi
      .fn()
      .mockResolvedValue(parent ? [{ type: 'm.space.parent', state_key: parent.id, content: parent.via ? { via: parent.via } : {} }] : []);
    const getRoom = (id: string) => (parent && id === parent.id && spaceMembership ? { getMyMembership: () => spaceMembership } : null);
    return { mx: { joinRoom, roomState, getRoom } as unknown as MatrixClient, joinRoom };
  }

  it('joins the room', async () => {
    const { mx, joinRoom } = client();
    await acceptInvite(mx, '!room:example.org');
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledWith('!room:example.org');
  });

  it("also joins the channel's Space when you aren't in it, through the parent's via servers", async () => {
    const { mx, joinRoom } = client({ parent: { id: '!space:cats.example', via: ['cats.example'] } });
    await acceptInvite(mx, '!general:cats.example');
    expect(joinRoom).toHaveBeenLastCalledWith('!space:cats.example', { viaServers: ['cats.example'] });
  });

  it("falls back to the channel's own server when the parent names none", async () => {
    const { mx, joinRoom } = client({ parent: { id: '!space:cats.example' } });
    await acceptInvite(mx, '!general:cats.example');
    expect(joinRoom).toHaveBeenLastCalledWith('!space:cats.example', { viaServers: ['cats.example'] });
  });

  it('leaves the Space alone when you are already in it', async () => {
    const { mx, joinRoom } = client({ parent: { id: '!space:cats.example' }, spaceMembership: 'join' });
    await acceptInvite(mx, '!general:cats.example');
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when the Space can't be joined", async () => {
    const { mx, joinRoom } = client({ parent: { id: '!space:cats.example' } });
    joinRoom.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('M_FORBIDDEN'));
    await expect(acceptInvite(mx, '!general:cats.example')).resolves.toBeUndefined();
  });
});

describe('inviteToChannel', () => {
  function setup({ spaceMembership, myLevel = 100 }: { spaceMembership?: string; myLevel?: number } = {}) {
    const invite = vi.fn().mockResolvedValue({});
    const space = {
      roomId: '!space:purr.example',
      getMember: () => (spaceMembership ? { membership: spaceMembership } : null),
      currentState: {
        getStateEvents: (type: string) => (type === 'm.room.power_levels' ? { getContent: () => ({ invite: 50, users: { '@me:purr.example': myLevel } }) } : null),
      },
    };
    const channel = {
      roomId: '!general:purr.example',
      currentState: { getStateEvents: () => [{ getStateKey: () => '!space:purr.example' }] },
    } as unknown as Room;
    const mx = {
      invite,
      getUserId: () => '@me:purr.example',
      getRoom: (id: string) => (id === space.roomId ? space : null),
    } as unknown as MatrixClient;
    return { mx, channel, invite };
  }

  it("invites to the channel and to its Space when they aren't in it", async () => {
    const { mx, channel, invite } = setup();
    expect(await inviteToChannel(mx, channel, '@mochi:cats.example')).toEqual({ space: true });
    expect(invite.mock.calls).toEqual([
      ['!general:purr.example', '@mochi:cats.example'],
      ['!space:purr.example', '@mochi:cats.example'],
    ]);
  });

  it('only invites to the channel when they are already in the Space', async () => {
    const { mx, channel, invite } = setup({ spaceMembership: 'join' });
    expect(await inviteToChannel(mx, channel, '@mochi:cats.example')).toEqual({ space: false });
    expect(invite).toHaveBeenCalledTimes(1);
  });

  it("only invites to the channel when you can't invite to the Space", async () => {
    const { mx, channel, invite } = setup({ myLevel: 0 });
    expect(await inviteToChannel(mx, channel, '@mochi:cats.example')).toEqual({ space: false });
    expect(invite).toHaveBeenCalledTimes(1);
  });
});

describe('declineInvite', () => {
  it('declines by leaving the room (Matrix has no separate reject-invite call)', async () => {
    const leave = vi.fn().mockResolvedValue({});
    const mx = { leave } as unknown as MatrixClient;
    await declineInvite(mx, '!room:example.org');
    expect(leave).toHaveBeenCalledWith('!room:example.org');
  });
});

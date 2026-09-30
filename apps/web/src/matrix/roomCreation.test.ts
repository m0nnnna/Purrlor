import { describe, expect, it, vi } from 'vitest';
import {
  EventType,
  JoinRule,
  RestrictedAllowType,
  Visibility,
  type ICreateRoomOpts,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { createRoom, getJoinRule, setJoinRule } from './roomCreation';

function fakeClient() {
  const createRoomFn = vi.fn().mockResolvedValue({ room_id: '!new:example.org' });
  const mx = {
    getUserId: () => '@me:example.org',
    createRoom: createRoomFn,
    sendStateEvent: vi.fn().mockResolvedValue({}),
  } as unknown as MatrixClient;
  return { mx, createRoomFn };
}

const SPACE = { roomId: '!space:example.org' } as unknown as Room;

/** The join rule a given createRoom call asked for, out of its initial_state. */
function joinRuleOf(opts: ICreateRoomOpts) {
  return opts.initial_state?.find((event) => event.type === EventType.RoomJoinRules)?.content;
}

describe('createRoom', () => {
  it('encrypts a room from its first event when asked, and not otherwise', () => {
    const { mx, createRoomFn } = fakeClient();
    void createRoom(mx, { name: 'Private', isPublic: false, encrypted: true });
    void createRoom(mx, { name: 'Plain', isPublic: false });
    const encryptionOf = (call: number) =>
      (createRoomFn.mock.calls[call][0] as ICreateRoomOpts).initial_state?.find((e) => e.type === EventType.RoomEncryption)?.content;
    expect(encryptionOf(0)).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
    expect(encryptionOf(1)).toBeUndefined();
  });

  it('never encrypts a Space, which holds no messages', () => {
    const { mx, createRoomFn } = fakeClient();
    void createRoom(mx, { name: 'Hub', isPublic: false, isSpace: true, encrypted: true });
    const opts = createRoomFn.mock.calls[0][0] as ICreateRoomOpts;
    expect(opts.initial_state?.some((e) => e.type === EventType.RoomEncryption)).toBe(false);
  });

  it('publishes to the directory (visibility: public) when isPublic is set, not just the join rule', () => {
    const { mx, createRoomFn } = fakeClient();
    void createRoom(mx, { name: 'Open Room', isPublic: true });
    expect(createRoomFn).toHaveBeenCalledWith(expect.objectContaining({ visibility: Visibility.Public }));
  });

  it('keeps a non-public room out of the directory', () => {
    const { mx, createRoomFn } = fakeClient();
    void createRoom(mx, { name: 'Closed Room', isPublic: false });
    expect(createRoomFn).toHaveBeenCalledWith(expect.objectContaining({ visibility: Visibility.Private }));
  });

  // The voice token server's bot has to be a member of a voice channel's own room to authorize
  // anyone into the call, and a Space-level invite never reaches its channels — so it goes in
  // atomically at creation (see matrix/voiceBot.ts).
  it('invites the accounts it is given, so a voice channel works the moment it exists', () => {
    const { mx, createRoomFn } = fakeClient();
    void createRoom(mx, { name: 'General', isPublic: false, invite: ['@voice-bot:example.org'] });
    expect(createRoomFn).toHaveBeenCalledWith(
      expect.objectContaining({ invite: ['@voice-bot:example.org'] })
    );
  });

  it('omits the invite key entirely when there is nobody to invite', () => {
    const { mx, createRoomFn } = fakeClient();
    void createRoom(mx, { name: 'General', isPublic: false, invite: [] });
    expect(createRoomFn.mock.calls[0][0].invite).toBeUndefined();
  });

  // Membership of the Space is what grants access to a voice channel inside it — Discord's
  // model, and what lets the voice service bot join a channel itself rather than depending on
  // an invite it can't ask for (services/token-server/src/tenancy.ts).
  it('restricts a private voice channel to its parent space rather than invite-only', async () => {
    const { mx, createRoomFn } = fakeClient();
    await createRoom(mx, { name: 'Lounge', isPublic: false, parentSpace: SPACE, channelType: 'voice' });
    expect(joinRuleOf(createRoomFn.mock.calls[0][0])).toEqual({
      join_rule: JoinRule.Restricted,
      allow: [{ type: RestrictedAllowType.RoomMembership, room_id: SPACE.roomId }],
    });
  });

  it('leaves text channels invite-only', async () => {
    const { mx, createRoomFn } = fakeClient();
    await createRoom(mx, { name: 'general', isPublic: false, parentSpace: SPACE, channelType: 'text' });
    expect(joinRuleOf(createRoomFn.mock.calls[0][0])).toEqual({ join_rule: JoinRule.Invite });
  });

  it('leaves a public voice channel public, which is already more open than restricted', async () => {
    const { mx, createRoomFn } = fakeClient();
    await createRoom(mx, { name: 'Lounge', isPublic: true, parentSpace: SPACE, channelType: 'voice' });
    expect(joinRuleOf(createRoomFn.mock.calls[0][0])).toEqual({ join_rule: JoinRule.Public });
  });

  it('has nothing to restrict a space-less voice room to, so leaves it invite-only', async () => {
    const { mx, createRoomFn } = fakeClient();
    await createRoom(mx, { name: 'Lounge', isPublic: false, channelType: 'voice' });
    expect(joinRuleOf(createRoomFn.mock.calls[0][0])).toEqual({ join_rule: JoinRule.Invite });
  });

  // Restricted join rules need room version 9+. Creating the channel matters more than the
  // access model upgrade, so an older homeserver gets the room it can actually make.
  it('falls back to an invite-only room when the homeserver rejects a restricted one', async () => {
    const { mx, createRoomFn } = fakeClient();
    createRoomFn.mockRejectedValueOnce(new Error('M_UNSUPPORTED_ROOM_VERSION'));

    await expect(
      createRoom(mx, { name: 'Lounge', isPublic: false, parentSpace: SPACE, channelType: 'voice' })
    ).resolves.toBe('!new:example.org');

    expect(createRoomFn).toHaveBeenCalledTimes(2);
    expect(joinRuleOf(createRoomFn.mock.calls[1][0])).toEqual({ join_rule: JoinRule.Invite });
  });

  it('does not retry a failure it has no fallback for', async () => {
    const { mx, createRoomFn } = fakeClient();
    createRoomFn.mockRejectedValueOnce(new Error('M_LIMIT_EXCEEDED'));
    await expect(createRoom(mx, { name: 'general', isPublic: false, channelType: 'text' })).rejects.toThrow(
      'M_LIMIT_EXCEEDED'
    );
    expect(createRoomFn).toHaveBeenCalledTimes(1);
  });
});

function fakeRoomWithJoinRule(joinRule?: JoinRule): Room {
  return {
    currentState: {
      getStateEvents: () =>
        joinRule === undefined ? null : { getContent: () => ({ join_rule: joinRule }) },
    },
  } as unknown as Room;
}

describe('getJoinRule', () => {
  it('reads the current join rule', () => {
    expect(getJoinRule(fakeRoomWithJoinRule(JoinRule.Public))).toBe(JoinRule.Public);
  });

  it('defaults to Invite when the room has no join_rules event', () => {
    expect(getJoinRule(fakeRoomWithJoinRule(undefined))).toBe(JoinRule.Invite);
  });
});

describe('setJoinRule', () => {
  it('sends only a join_rules state event, leaving directory visibility untouched', async () => {
    const sendStateEvent = vi.fn().mockResolvedValue({});
    const mx = { sendStateEvent } as unknown as MatrixClient;
    await setJoinRule(mx, '!space:example.org', JoinRule.Public);
    expect(sendStateEvent).toHaveBeenCalledWith('!space:example.org', EventType.RoomJoinRules, {
      join_rule: JoinRule.Public,
    });
  });
});

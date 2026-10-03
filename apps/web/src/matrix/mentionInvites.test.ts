import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { inviteMentioned, mentionInviteReason, parseMentionInviteReason, readMentionInvite } from './mentionInvites';

const ME = '@me:x';

describe('mention invite reason', () => {
  it('round-trips the post it names, and ignores ordinary reasons', () => {
    expect(parseMentionInviteReason(mentionInviteReason('$post1'))).toBe('$post1');
    expect(parseMentionInviteReason('come hang out')).toBeUndefined();
    expect(parseMentionInviteReason(undefined)).toBeUndefined();
  });
});

function inviteRoom({ type = 'xyz.nekous.profile', creator = '@alice:x', inviter = '@alice:x', reason = mentionInviteReason('$p') } = {}) {
  return {
    roomId: '!profile:x',
    getMyMembership: () => 'invite',
    currentState: {
      getStateEvents: (eventType: string, key: string) => {
        if (eventType === 'm.room.create') return { getContent: () => ({ type }), getSender: () => creator };
        if (eventType === 'm.room.member' && key === ME) return { getContent: () => ({ membership: 'invite', reason }), getSender: () => inviter };
        return undefined;
      },
    },
  } as unknown as Room;
}

const client = { getUserId: () => ME } as unknown as MatrixClient;

describe('readMentionInvite', () => {
  it('recognises an invite to a profile room from its owner, naming a post', () => {
    expect(readMentionInvite(client, inviteRoom())).toEqual({ inviter: '@alice:x', postId: '$p', tagged: false });
  });

  it('leaves every other invite alone', () => {
    expect(readMentionInvite(client, inviteRoom({ type: 'm.space' }))).toBeUndefined();
    expect(readMentionInvite(client, inviteRoom({ reason: 'join us' }))).toBeUndefined();
    // Someone other than the room's owner can't make an invite look like a mention.
    expect(readMentionInvite(client, inviteRoom({ inviter: '@mallory:x' }))).toBeUndefined();
  });
});

describe('inviteMentioned', () => {
  it('invites only people not already in the room, never yourself, with the reason', async () => {
    const invite = vi.fn().mockResolvedValue({});
    const members: Record<string, string> = { '@joined:x': 'join', '@banned:x': 'ban' };
    const mx = {
      getUserId: () => ME,
      getRoom: () => ({ getMember: (id: string) => (members[id] ? { membership: members[id] } : null) }),
      invite,
    } as unknown as MatrixClient;
    await inviteMentioned(mx, '!profile:x', '$p', ['@joined:x', '@banned:x', '@new:x', ME]);
    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite).toHaveBeenCalledWith('!profile:x', '@new:x', mentionInviteReason('$p'));
  });
});

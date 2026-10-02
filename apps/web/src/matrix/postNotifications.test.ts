import { describe, expect, it, vi } from 'vitest';
import { muteRuleBody, mutedPostIds, setPostMuted, syncPostNotificationRules, wantedPostRules } from './postNotifications';

describe('wantedPostRules', () => {
  it('gives each owned feed a comment rule with sound and a quiet like rule, scoped to that room', () => {
    const rules = wantedPostRules(['!feed:x'], { comments: true, likes: true });
    expect(rules).toEqual([
      {
        ruleId: 'xyz.nekous.feed_comment.!feed:x',
        body: {
          conditions: [
            { kind: 'event_match', key: 'type', pattern: 'xyz.nekous.comment' },
            { kind: 'event_match', key: 'room_id', pattern: '!feed:x' },
          ],
          actions: ['notify', { set_tweak: 'sound', value: 'default' }],
        },
      },
      {
        ruleId: 'xyz.nekous.feed_like.!feed:x',
        body: {
          conditions: [
            { kind: 'event_match', key: 'type', pattern: 'm.reaction' },
            { kind: 'event_match', key: 'room_id', pattern: '!feed:x' },
          ],
          actions: ['notify'],
        },
      },
    ]);
  });

  it('leaves out whatever is switched off', () => {
    expect(wantedPostRules(['!a', '!b'], { comments: true, likes: false }).map((r) => r.ruleId)).toEqual([
      'xyz.nekous.feed_comment.!a',
      'xyz.nekous.feed_comment.!b',
    ]);
    expect(wantedPostRules(['!a'], { comments: false, likes: false })).toEqual([]);
  });
});

function fakeClient(existingRuleIds: string[], accountData: Record<string, unknown>) {
  return {
    pushRules: { global: { override: existingRuleIds.map((rule_id) => ({ rule_id })) } },
    getAccountData: (type: string) => (type in accountData ? { getContent: () => accountData[type] } : undefined),
    http: { authedRequest: vi.fn(async () => ({})) },
    deletePushRule: vi.fn(async () => ({})),
  };
}

/** The rules added (PUT), in order, with where each was placed. */
function added(mx: ReturnType<typeof fakeClient>) {
  return (mx.http.authedRequest.mock.calls as unknown as [string, string, Record<string, string> | undefined][]).map(([, path, query]) => ({
    ruleId: decodeURIComponent(path.replace('/pushrules/global/override/', '')),
    query,
  }));
}

describe('syncPostNotificationRules', () => {
  const owned = { 'xyz.nekous.profile_room': { roomId: '!profile' }, 'xyz.nekous.feed_rooms': { '!space': '!spacefeed' } };

  it('adds only the missing rules, for the profile feed and every Space feed', async () => {
    const mx = fakeClient(['xyz.nekous.feed_comment.!profile', '.m.rule.master', 'someone.elses.rule'], owned);
    await syncPostNotificationRules(mx as never, { comments: true, likes: true });
    expect(added(mx).map((rule) => rule.ruleId)).toEqual([
      'xyz.nekous.feed_like.!profile',
      'xyz.nekous.feed_comment.!spacefeed',
      'xyz.nekous.feed_like.!spacefeed',
    ]);
    expect(added(mx)[0].query).toBeUndefined();
    expect(mx.deletePushRule).not.toHaveBeenCalled();
  });

  it('removes its own rules that are no longer wanted, and never anyone else’s', async () => {
    const mx = fakeClient(
      ['xyz.nekous.feed_like.!profile', 'xyz.nekous.feed_comment.!gone', '.m.rule.reaction', 'custom.rule'],
      owned
    );
    await syncPostNotificationRules(mx as never, { comments: false, likes: false });
    expect(mx.deletePushRule.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      'xyz.nekous.feed_like.!profile',
      'xyz.nekous.feed_comment.!gone',
    ]);
    expect(mx.http.authedRequest).not.toHaveBeenCalled();
  });

  it('puts new rules below muted posts, so a mute keeps winning', async () => {
    const mx = fakeClient(['xyz.nekous.mute_post.$a', 'xyz.nekous.mute_post.$b', 'xyz.nekous.feed_comment.!profile'], owned);
    await syncPostNotificationRules(mx as never, { comments: true, likes: false });
    expect(added(mx)).toEqual([{ ruleId: 'xyz.nekous.feed_comment.!spacefeed', query: { after: 'xyz.nekous.mute_post.$b' } }]);
  });

  it('changes nothing when the rules already match', async () => {
    const mx = fakeClient(['xyz.nekous.feed_comment.!profile', 'xyz.nekous.feed_like.!profile'], {
      'xyz.nekous.profile_room': { roomId: '!profile' },
    });
    await syncPostNotificationRules(mx as never, { comments: true, likes: true });
    expect(mx.http.authedRequest).not.toHaveBeenCalled();
    expect(mx.deletePushRule).not.toHaveBeenCalled();
  });
});

describe('muting a post', () => {
  it('silences everything related to the post in its room, with no actions', () => {
    expect(muteRuleBody('!feed:x', '$post')).toEqual({
      conditions: [
        { kind: 'event_match', key: 'room_id', pattern: '!feed:x' },
        { kind: 'event_match', key: 'content.m\\.relates_to.event_id', pattern: '$post' },
      ],
      actions: [],
    });
  });

  it('goes ahead of your other rules, and reads back as muted', async () => {
    const mx = fakeClient(['.m.rule.master', 'xyz.nekous.feed_comment.!profile', '.m.rule.is_user_mention'], {});
    await setPostMuted(mx as never, '!feed:x', '$post', true);
    expect(added(mx)).toEqual([{ ruleId: 'xyz.nekous.mute_post.$post', query: { before: 'xyz.nekous.feed_comment.!profile' } }]);
    expect(mutedPostIds(fakeClient(['xyz.nekous.mute_post.$post', 'xyz.nekous.feed_like.!p'], {}) as never)).toEqual(new Set(['$post']));
  });

  it('unmuting deletes the rule', async () => {
    const mx = fakeClient(['xyz.nekous.mute_post.$post'], {});
    await setPostMuted(mx as never, '!feed:x', '$post', false);
    expect(mx.deletePushRule).toHaveBeenCalledWith('global', 'override', 'xyz.nekous.mute_post.$post');
  });
});

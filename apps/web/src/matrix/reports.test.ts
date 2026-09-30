import { describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { excerptOf, readReports, reportToSpaceModerators } from './reports';

type Fake = { id: string; type: string; sender: string; content: Record<string, unknown>; ts?: number; redacted?: boolean };

function reviewRoom(events: Fake[], levels: Record<string, number>): Room {
  return {
    getLiveTimeline: () => ({
      getEvents: () =>
        events.map((e) => ({
          getId: () => e.id,
          getType: () => e.type,
          getSender: () => e.sender,
          getContent: () => e.content,
          getTs: () => e.ts ?? 0,
          isRedacted: () => !!e.redacted,
        })),
    }),
    currentState: {
      getStateEvents: (type: string) =>
        type === 'm.room.power_levels' ? { getContent: () => ({ users: levels }) } : type === 'm.room.create' ? null : [],
    },
  } as unknown as Room;
}

const report = (id: string, extra: Record<string, unknown> = {}) => ({
  report_id: id,
  space_id: '!space',
  room_id: '!chan',
  event_id: `$msg-${id}`,
  reported_user: '@troll',
  reason: 'spam',
  reported_at: Number(id.replace(/\D/g, '')) || 1,
  reporter: '@reporter',
  ...extra,
});

describe('readReports', () => {
  it('lists reports newest first, once each, with their resolution', () => {
    const room = reviewRoom(
      [
        { id: '$r1', type: 'xyz.nekous.report', sender: '@mod', content: report('r1') },
        { id: '$r2', type: 'xyz.nekous.report', sender: '@mod', content: report('r2') },
        // The same report filed again by another moderator's client.
        { id: '$r2b', type: 'xyz.nekous.report', sender: '@mod2', content: report('r2') },
        { id: '$x', type: 'xyz.nekous.report_resolution', sender: '@mod2', content: { action: 'dismissed', 'm.relates_to': { event_id: '$r1' } } },
      ],
      { '@mod': 50, '@mod2': 50 }
    );
    const reports = readReports(room);
    expect(reports.map((r) => r.report_id)).toEqual(['r2', 'r1']);
    expect(reports[0].resolution).toBeUndefined();
    expect(reports[1].resolution).toMatchObject({ action: 'dismissed', by: '@mod2' });
    expect(reports[1].reporter).toBe('@reporter');
  });

  it('ignores reports and resolutions from anyone below moderator', () => {
    const room = reviewRoom(
      [
        { id: '$r1', type: 'xyz.nekous.report', sender: '@mod', content: report('r1') },
        { id: '$fake', type: 'xyz.nekous.report', sender: '@demoted', content: report('r9') },
        { id: '$x', type: 'xyz.nekous.report_resolution', sender: '@demoted', content: { action: 'dismissed', 'm.relates_to': { event_id: '$r1' } } },
      ],
      { '@mod': 50, '@demoted': 0 }
    );
    const reports = readReports(room);
    expect(reports.map((r) => r.report_id)).toEqual(['r1']);
    expect(reports[0].resolution).toBeUndefined();
  });

  it('skips malformed and redacted reports', () => {
    const room = reviewRoom(
      [
        { id: '$bad', type: 'xyz.nekous.report', sender: '@mod', content: { report_id: 'x' } },
        { id: '$gone', type: 'xyz.nekous.report', sender: '@mod', content: report('r2'), redacted: true },
      ],
      { '@mod': 50 }
    );
    expect(readReports(room)).toEqual([]);
  });
});

describe('excerptOf', () => {
  it('quotes the body, cut at 500 characters', () => {
    expect(excerptOf({ body: 'hello' })).toBe('hello');
    expect(excerptOf({ body: 'x'.repeat(600) })).toHaveLength(501);
    expect(excerptOf({ body: '  ' })).toBeUndefined();
    expect(excerptOf({})).toBeUndefined();
  });
});

describe('reportToSpaceModerators for a post or comment', () => {
  const state: Record<string, Record<string, unknown>> = {
    'xyz.nekous.moderation': { '': { review_room: '!review' } },
    'm.room.power_levels': { '': { users: { '@mod:x': 50, '@me:x': 0, '@helper:x': 25 } } },
  };
  const space = {
    roomId: '!space',
    currentState: {
      getStateEvents: (type: string, key?: string) => {
        const byKey = state[type];
        if (!byKey) return key === undefined ? [] : null;
        return key === undefined ? Object.entries(byKey).map(([k, c]) => ({ getStateKey: () => k, getContent: () => c })) : byKey[key] ? { getContent: () => byKey[key], getSender: () => undefined } : null;
      },
    },
  } as unknown as Room;
  const sent: { type: string; content: Record<string, unknown>; to: string[] }[] = [];
  const mx = {
    getUserId: () => '@me:x',
    getCrypto: () => undefined,
    sendToDevice: async (type: string, map: Map<string, Map<string, Record<string, unknown>>>) => {
      const [[, devices]] = [...map];
      sent.push({ type, content: [...devices.values()][0], to: [...map.keys()] });
      return {};
    },
  } as unknown as MatrixClient;
  const post = {
    getRoomId: () => '!feed',
    getId: () => '$post',
    getSender: () => '@bad:x',
    isEncrypted: () => false,
    getContent: () => ({ body: 'spam spam' }),
  } as unknown as MatrixEvent;

  it('marks the report as about a post, with the post to open, and reaches only real moderators', async () => {
    const count = await reportToSpaceModerators(mx, space, post, 'spam', { kind: 'post', postId: '$post' });
    expect(count).toBe(1);
    expect(sent[0].to).toEqual(['@mod:x']); // a custom-role holder below moderator doesn't review reports
    expect(sent[0].content).toMatchObject({ room_id: '!feed', event_id: '$post', content_kind: 'post', post_id: '$post', excerpt: 'spam spam' });
  });

  it('leaves a chat message’s report as it was', async () => {
    await reportToSpaceModerators(mx, space, post, 'spam');
    expect(sent[1].content.content_kind).toBeUndefined();
  });
});

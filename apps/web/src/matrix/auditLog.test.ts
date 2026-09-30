import { describe, expect, it } from 'vitest';
import { EventType } from 'matrix-js-sdk';
import { buildAuditLog } from './auditLog';

type FakeEventInit = {
  type: string;
  sender: string;
  stateKey?: string;
  content?: Record<string, unknown>;
  prevContent?: Record<string, unknown>;
  ts?: number;
  id?: string;
};

let nextId = 0;

function fakeEvent(init: FakeEventInit) {
  const id = init.id ?? `$event${nextId++}`;
  return {
    getId: () => id,
    getType: () => init.type,
    getSender: () => init.sender,
    getStateKey: () => init.stateKey,
    getContent: () => init.content ?? {},
    getPrevContent: () => init.prevContent ?? {},
    getTs: () => init.ts ?? 0,
  };
}

function fakeRoom(name: string, events: ReturnType<typeof fakeEvent>[], memberNames: Record<string, string> = {}) {
  const timeline = { getEvents: () => events };
  const timelineSet = { getTimelines: () => [timeline] };
  return {
    roomId: `!${name}:example.org`,
    name,
    getTimelineSets: () => [timelineSet],
    getMember: (userId: string) => (memberNames[userId] ? { name: memberNames[userId] } : null),
  } as unknown as Parameters<typeof buildAuditLog>[0][number];
}

describe('buildAuditLog', () => {
  it('describes an invite, join, kick, ban, unban, leave, and invite-withdrawal', () => {
    const members = { '@alice:example.org': 'Alice', '@bob:example.org': 'Bob' };
    const room = fakeRoom('general', [
      fakeEvent({ type: EventType.RoomMember, sender: '@alice:example.org', stateKey: '@bob:example.org', content: { membership: 'invite' }, prevContent: {}, ts: 1 }),
      fakeEvent({ type: EventType.RoomMember, sender: '@bob:example.org', stateKey: '@bob:example.org', content: { membership: 'join' }, prevContent: { membership: 'invite' }, ts: 2 }),
      fakeEvent({ type: EventType.RoomMember, sender: '@alice:example.org', stateKey: '@bob:example.org', content: { membership: 'leave' }, prevContent: { membership: 'join' }, ts: 3 }),
      fakeEvent({ type: EventType.RoomMember, sender: '@alice:example.org', stateKey: '@bob:example.org', content: { membership: 'ban' }, prevContent: { membership: 'leave' }, ts: 4 }),
      fakeEvent({ type: EventType.RoomMember, sender: '@alice:example.org', stateKey: '@bob:example.org', content: { membership: 'leave' }, prevContent: { membership: 'ban' }, ts: 5 }),
      fakeEvent({ type: EventType.RoomMember, sender: '@bob:example.org', stateKey: '@bob:example.org', content: { membership: 'leave' }, prevContent: { membership: 'join' }, ts: 6 }),
    ], members);

    const descriptions = buildAuditLog([room])
      .sort((a, b) => a.ts - b.ts)
      .map((e) => e.description);

    expect(descriptions).toEqual([
      'Alice invited Bob',
      'Bob joined',
      'Alice kicked Bob',
      'Alice banned Bob',
      'Alice unbanned Bob',
      'Bob left',
    ]);
  });

  it('ignores a membership event where membership did not actually change (e.g. a profile-only update)', () => {
    const room = fakeRoom('general', [
      fakeEvent({ type: EventType.RoomMember, sender: '@alice:example.org', stateKey: '@alice:example.org', content: { membership: 'join' }, prevContent: { membership: 'join' } }),
    ]);
    expect(buildAuditLog([room])).toEqual([]);
  });

  it('describes a power level change per affected user', () => {
    const room = fakeRoom('general', [
      fakeEvent({
        type: EventType.RoomPowerLevels,
        sender: '@alice:example.org',
        content: { users: { '@alice:example.org': 100, '@bob:example.org': 50 } },
        prevContent: { users: { '@alice:example.org': 100, '@bob:example.org': 0 } },
      }),
    ], { '@alice:example.org': 'Alice', '@bob:example.org': 'Bob' });

    const descriptions = buildAuditLog([room]).map((e) => e.description);
    expect(descriptions).toEqual(["Alice set Bob's power level to 50"]);
  });

  it('describes name, topic, avatar, and redaction events', () => {
    const room = fakeRoom('general', [
      fakeEvent({ type: EventType.RoomName, sender: '@alice:example.org', content: { name: 'New Name' }, ts: 1 }),
      fakeEvent({ type: EventType.RoomTopic, sender: '@alice:example.org', content: { topic: 'New Topic' }, ts: 2 }),
      fakeEvent({ type: EventType.RoomAvatar, sender: '@alice:example.org', content: { url: 'mxc://x' }, ts: 3 }),
      fakeEvent({ type: EventType.RoomRedaction, sender: '@alice:example.org', content: {}, ts: 4 }),
    ], { '@alice:example.org': 'Alice' });

    const descriptions = buildAuditLog([room])
      .sort((a, b) => a.ts - b.ts)
      .map((e) => e.description);
    expect(descriptions).toEqual([
      'Alice renamed the room to "New Name"',
      'Alice changed the topic to "New Topic"',
      'Alice changed the room icon',
      'Alice deleted a message',
    ]);
  });

  it('ignores irrelevant event types (e.g. messages, reactions)', () => {
    const room = fakeRoom('general', [fakeEvent({ type: 'm.room.message', sender: '@alice:example.org' })]);
    expect(buildAuditLog([room])).toEqual([]);
  });

  it('sorts newest-first across multiple rooms and applies the limit', () => {
    const roomA = fakeRoom('a', [fakeEvent({ type: EventType.RoomAvatar, sender: '@alice:example.org', ts: 1 })]);
    const roomB = fakeRoom('b', [fakeEvent({ type: EventType.RoomAvatar, sender: '@alice:example.org', ts: 5 })]);
    const entries = buildAuditLog([roomA, roomB], 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].roomName).toBe('b');
  });

  it('falls back to the raw user ID when the actor is not a known room member', () => {
    const room = fakeRoom('general', [fakeEvent({ type: EventType.RoomAvatar, sender: '@ghost:example.org' })]);
    expect(buildAuditLog([room])[0].description).toBe('@ghost:example.org changed the room icon');
  });

  it('folds the channel-role sync across channels into one line, apart from edits by hand', () => {
    const names = { '@alice:example.org': 'Alice', '@bob:example.org': 'Bob' };
    const sync = (ts: number) =>
      fakeEvent({
        type: EventType.RoomPowerLevels,
        sender: '@alice:example.org',
        content: { users: { '@bob:example.org': 50 }, 'xyz.nekous.role_sync': ts },
        prevContent: { users: {} },
        ts,
      });
    const byHand = fakeEvent({
      type: EventType.RoomPowerLevels,
      sender: '@alice:example.org',
      // Starts from the synced content, so the marker comes along unchanged.
      content: { users: { '@bob:example.org': 50, '@carol:example.org': 10 }, 'xyz.nekous.role_sync': 1000 },
      prevContent: { users: { '@bob:example.org': 50 }, 'xyz.nekous.role_sync': 1000 },
      ts: 5000,
    });
    const rooms = [fakeRoom('general', [sync(1000), byHand], names), fakeRoom('random', [sync(2000)], names), fakeRoom('art', [sync(3000)], names)];

    expect(buildAuditLog(rooms).map((e) => [e.roomName, e.description])).toEqual([
      ['general', "Alice set @carol:example.org's power level to 10"],
      ['3 channels', "Alice applied the Space's roles: Bob is now a moderator"],
    ]);
  });
});

import { EventType, RoomEvent, RoomStateEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { ROLE_SYNC_MARKER } from './channelPermissions';
import { roleFor } from './roles';

export type AuditLogEntry = {
  id: string;
  ts: number;
  roomName: string;
  description: string;
};

/**
 * Rooms this doesn't try to derive an audit entry for at all — anything not listed here is noise
 * for a moderation log (message edits, reactions, typing, read receipts, ...).
 */
const RELEVANT_TYPES: Set<string> = new Set([
  EventType.RoomMember,
  EventType.RoomPowerLevels,
  EventType.RoomName,
  EventType.RoomTopic,
  EventType.RoomAvatar,
  EventType.RoomJoinRules,
  EventType.RoomHistoryVisibility,
  EventType.RoomRedaction,
]);

function actorName(room: Room, userId: string): string {
  return room.getMember(userId)?.name || userId;
}

function describeMembership(room: Room, event: MatrixEvent): string | null {
  const actor = actorName(room, event.getSender() ?? '');
  const targetId = event.getStateKey() ?? '';
  const target = actorName(room, targetId);
  const prevMembership = event.getPrevContent().membership as string | undefined;
  const membership = event.getContent().membership as string | undefined;
  if (prevMembership === membership) return null; // a profile-only re-send (e.g. display name change)

  switch (membership) {
    case 'invite':
      return `${actor} invited ${target}`;
    case 'join':
      return `${target} joined`;
    case 'leave':
      if (prevMembership === 'ban') return `${actor} unbanned ${target}`;
      if (prevMembership === 'invite') return `${actor} withdrew ${target}'s invite`;
      if (event.getSender() === targetId) return `${target} left`;
      return `${actor} kicked ${target}`;
    case 'ban':
      return `${actor} banned ${target}`;
    default:
      return null;
  }
}

/** Whether a power-levels write was the channel-role sync's (channelPermissions.ts) rather than someone's by hand. */
function isRoleSync(event: MatrixEvent): boolean {
  const marker = event.getContent()[ROLE_SYNC_MARKER];
  return marker !== undefined && marker !== event.getPrevContent()[ROLE_SYNC_MARKER];
}

function describePowerLevels(room: Room, event: MatrixEvent): Line[] {
  const actor = actorName(room, event.getSender() ?? '');
  const prevUsers = (event.getPrevContent().users ?? {}) as Record<string, number>;
  const users = (event.getContent().users ?? {}) as Record<string, number>;
  const changedUserIds = [...new Set([...Object.keys(prevUsers), ...Object.keys(users)])].filter(
    (id) => (prevUsers[id] ?? 0) !== (users[id] ?? 0)
  );
  if (isRoleSync(event)) {
    // The same change lands in every channel of the Space; said once, in the Space's words.
    return changedUserIds.map((id) => ({
      description: `${actor} applied the Space's roles: ${actorName(room, id)} is now ${withArticle(roleFor(users[id] ?? 0).label.toLowerCase())}`,
      sync: true,
    }));
  }
  if (changedUserIds.length === 0) return [{ description: `${actor} updated room permissions` }];
  return changedUserIds.map((id) => ({ description: `${actor} set ${actorName(room, id)}'s power level to ${users[id] ?? 0}` }));
}

type Line = { description: string; sync?: boolean };

const withArticle = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/** A single event -> zero or more human-readable audit lines (power-level changes can touch
 *  several users at once, everything else is at most one line). */
function describeEvent(room: Room, event: MatrixEvent): Line[] {
  if (event.getType() === EventType.RoomPowerLevels) return describePowerLevels(room, event);
  return describeOther(room, event).map((description) => ({ description }));
}

function describeOther(room: Room, event: MatrixEvent): string[] {
  const actor = actorName(room, event.getSender() ?? '');
  switch (event.getType()) {
    case EventType.RoomMember: {
      const line = describeMembership(room, event);
      return line ? [line] : [];
    }
    case EventType.RoomName: {
      const name = event.getContent().name;
      return name ? [`${actor} renamed the room to "${name}"`] : [`${actor} removed the room name`];
    }
    case EventType.RoomTopic: {
      const topic = event.getContent().topic;
      return topic ? [`${actor} changed the topic to "${topic}"`] : [`${actor} removed the topic`];
    }
    case EventType.RoomAvatar:
      return [`${actor} changed the room icon`];
    case EventType.RoomJoinRules:
      return [`${actor} set the join rule to "${event.getContent().join_rule}"`];
    case EventType.RoomHistoryVisibility:
      return [`${actor} set history visibility to "${event.getContent().history_visibility}"`];
    case EventType.RoomRedaction:
      return [`${actor} deleted a message`];
    default:
      return [];
  }
}

/**
 * A rolling moderation log for a Space and its channels — derived entirely from state/redaction
 * events already loaded into each room's timeline (no dedicated audit-log endpoint exists in
 * Matrix), so this reflects recent activity rather than a complete historical archive: an event
 * from before the client paginated back that far simply isn't in memory to read. Good enough for
 * "what changed recently," which is what most moderation questions actually are.
 */
export function buildAuditLog(rooms: Room[], limit = 200): AuditLogEntry[] {
  const entries: AuditLogEntry[] = [];
  const syncs: (AuditLogEntry & { rooms: Set<string> })[] = [];
  for (const room of rooms) {
    const seenTimelines = new Set(room.getTimelineSets().flatMap((set) => set.getTimelines()));
    const events = [...seenTimelines].flatMap((timeline) => timeline.getEvents());
    for (const event of events) {
      if (!RELEVANT_TYPES.has(event.getType())) continue;
      for (const { description, sync } of describeEvent(room, event)) {
        const entry = { id: `${event.getId()}:${description}`, ts: event.getTs(), roomName: room.name, description };
        if (!sync) {
          entries.push(entry);
          continue;
        }
        // One role change reaches every channel within a few minutes: one line for all of them.
        const same = syncs.find((s) => s.description === description && Math.abs(s.ts - entry.ts) < SYNC_GROUP_MS);
        if (same) {
          same.rooms.add(room.name);
          same.ts = Math.max(same.ts, entry.ts);
        } else {
          syncs.push({ ...entry, rooms: new Set([room.name]) });
        }
      }
    }
  }
  for (const { rooms: names, ...entry } of syncs) {
    entries.push({ ...entry, roomName: names.size === 1 ? entry.roomName : `${names.size} channels` });
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries.slice(0, limit);
}

/** Sync writes for the same change this close together are one change. */
const SYNC_GROUP_MS = 10 * 60_000;

/** Room-level events this hook needs to re-derive the log on — new timeline events and any
 *  state change (covers redactions arriving via either path depending on client version). */
export const AUDIT_LOG_WATCH_EVENTS = [RoomEvent.Timeline, RoomStateEvent.Events] as const;

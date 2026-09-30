import { EventType, JoinRule, Preset, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { CHANNEL_SETTINGS_EVENT, MODERATOR_LEVEL, spaceRoleLevels } from './channelPermissions';
import { userPowerLevel } from './permissions';

/**
 * Reports a Space's own moderators can act on. docs/moderation.md has the design; in short:
 *
 * The homeserver's report endpoint only reaches the server's admins, and Matrix can't give a room
 * "write but not read", so a room people report *into* would let every reporter read every
 * report. Instead:
 *
 * 1. The reporter's client sends the report to each of the Space's moderators as a **to-device
 *    message** (`xyz.nekous.report`) to all their devices: it waits for devices that are offline,
 *    and no other member sees it. It's **Olm-encrypted** to each of their devices
 *    (sendEncryptedToDevice), so the servers carrying it can't read it; only where that can't be
 *    done (no encryption in this client, or a moderator with no device that has keys) does it go
 *    plain, as before. The quoted text is only ever included for unencrypted rooms.
 * 2. Whichever moderator's client receives it **files it** into the Space's **review room**: a
 *    room only its moderators are in (a moderators-only room, kept in line by ChannelGovernance
 *    like any other), so they all share one queue.
 * 3. A moderator acts from Space Settings → Reports: delete the message, remove or ban its author,
 *    or dismiss. The outcome is an `xyz.nekous.report_resolution` event referencing the report.
 *
 * The review room is named in the Space's `xyz.nekous.moderation` state; without it a Space has no
 * report review and reports only reach the server's admins, as before.
 */

export const MODERATION_EVENT = 'xyz.nekous.moderation';
export const REPORT_EVENT = 'xyz.nekous.report';
export const RESOLUTION_EVENT = 'xyz.nekous.report_resolution';
/** The review room's type, so lists of rooms leave it out (backgroundRooms.ts). */
export const REVIEW_ROOM_TYPE = 'xyz.nekous.review_room';

export type ModerationConfig = { reviewRoomId?: string; blockedWords: string[] };

export type ReportContent = {
  report_id: string;
  space_id: string;
  room_id: string;
  event_id: string;
  reported_user: string;
  reason: string;
  /** The message as the reporter saw it, for when it's been edited or deleted since. Only for
   *  unencrypted rooms: the review room isn't encrypted (so new moderators can read the whole
   *  queue), and an encrypted channel's text shouldn't end up readable by the server there. */
  excerpt?: string;
  reported_at: number;
  /** Set on reports filed by automod.ts rather than a person. */
  automod?: { word: string; deleted: boolean };
};

export type Resolution = 'deleted' | 'removed' | 'banned' | 'dismissed';

export type Report = ReportContent & {
  /** The report's event in the review room. */
  eventId: string;
  /** Who sent it: the reporter, or for automod the moderator whose client caught it. */
  reporter: string;
  resolution?: { action: Resolution; by: string; at: number };
};

// --- Configuration ---------------------------------------------------------------------------

export function readModerationConfig(space: Room): ModerationConfig {
  const content = space.currentState.getStateEvents(MODERATION_EVENT, '')?.getContent<Record<string, unknown>>() ?? {};
  const words = Array.isArray(content.blocked_words) ? content.blocked_words : [];
  return {
    reviewRoomId: typeof content.review_room === 'string' ? content.review_room : undefined,
    blockedWords: words.filter((w): w is string => typeof w === 'string' && w.trim().length > 0),
  };
}

async function writeModerationConfig(mx: MatrixClient, space: Room, changes: Record<string, unknown>): Promise<void> {
  const current = space.currentState.getStateEvents(MODERATION_EVENT, '')?.getContent<Record<string, unknown>>() ?? {};
  await mx.sendStateEvent(space.roomId, MODERATION_EVENT as any, { ...current, ...changes } as any, '');
}

export async function setBlockedWords(mx: MatrixClient, space: Room, words: string[]): Promise<void> {
  const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
  await writeModerationConfig(mx, space, { blocked_words: clean });
}

export function isSpaceModerator(space: Room, userId: string): boolean {
  return (spaceRoleLevels(space)[userId] ?? 0) >= MODERATOR_LEVEL;
}

/** The Space whose review room this is, if it's one. */
export function spaceOfReviewRoom(mx: MatrixClient, roomId: string): Room | undefined {
  return mx.getRooms().find((room) => room.isSpaceRoom() && readModerationConfig(room).reviewRoomId === roomId);
}

/**
 * Creates the Space's review room and points the Space at it. Moderators-only, so the governance
 * pass invites the Space's moderators and keeps it to them. Not a Space child, so it isn't a
 * channel anyone sees in the list; it's reached through Space Settings.
 */
export async function setUpReviewRoom(mx: MatrixClient, space: Room): Promise<string> {
  const { room_id: roomId } = await mx.createRoom({
    name: `${space.name} reports`,
    preset: Preset.PrivateChat,
    creation_content: { type: REVIEW_ROOM_TYPE },
    initial_state: [
      { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: JoinRule.Invite } },
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
      { type: CHANNEL_SETTINGS_EVENT, state_key: '', content: { moderators_only: true } },
    ],
  });
  await writeModerationConfig(mx, space, { review_room: roomId });
  return roomId;
}

// --- Reporting -------------------------------------------------------------------------------

function newReportId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The plain text a report quotes, trimmed. Pure. */
export function excerptOf(content: Record<string, unknown>): string | undefined {
  const body = content.body;
  if (typeof body !== 'string' || !body.trim()) return undefined;
  return body.length > 500 ? `${body.slice(0, 500)}…` : body;
}

/**
 * Sends a report to the moderators of the Space `roomId` is in (see the module comment). Resolves
 * to how many moderators it went to: 0 when the Space has no review room or no other moderator.
 */
export async function reportToSpaceModerators(
  mx: MatrixClient,
  space: Room,
  event: MatrixEvent,
  reason: string
): Promise<number> {
  const roomId = event.getRoomId();
  const eventId = event.getId();
  if (!roomId || !eventId || !readModerationConfig(space).reviewRoomId) return 0;

  const levels = spaceRoleLevels(space);
  // Moderators and admins: a custom role below moderator doesn't review reports.
  const moderators = Object.keys(levels).filter((userId) => levels[userId] >= MODERATOR_LEVEL && userId !== mx.getUserId());
  if (moderators.length === 0) return 0;

  const content: ReportContent = {
    report_id: newReportId(),
    space_id: space.roomId,
    room_id: roomId,
    event_id: eventId,
    reported_user: event.getSender() ?? '',
    reason,
    ...(!event.isEncrypted() && { excerpt: excerptOf(event.getContent()) }),
    reported_at: Date.now(),
  };
  await sendEncryptedToDevice(mx, moderators, REPORT_EVENT, content);
  return moderators.length;
}

// --- Encrypting a report to the moderators' devices -----------------------------------------

/**
 * The parts of the SDK's Rust crypto this needs beyond its public API. The SDK encrypts to-device
 * messages only for users whose devices it tracks, which it does for the members of encrypted rooms
 * you're in — and a reporter usually shares none with the Space's moderators. So they're added to
 * the tracked users first, and their device keys fetched, the same two calls the SDK makes itself
 * when someone joins an encrypted room. Checked for rather than assumed: an SDK that renames them
 * makes reports go plain again, not fail.
 */
type RustCryptoInternals = {
  getOlmMachineOrThrow?: () => { updateTrackedUsers(users: unknown[]): Promise<void> };
  outgoingRequestsManager?: { doProcessOutgoingRequests(): Promise<void> };
};

/** Starts tracking these users' devices, and fetches their keys. False when this client can't. */
async function trackDevices(mx: MatrixClient, userIds: string[]): Promise<boolean> {
  const internals = mx.getCrypto() as unknown as RustCryptoInternals | undefined;
  if (!internals?.getOlmMachineOrThrow || !internals.outgoingRequestsManager) return false;
  // The same module instance the SDK's crypto runs on, so its UserId objects are ones it accepts.
  const { UserId } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  await internals.getOlmMachineOrThrow().updateTrackedUsers(userIds.map((userId) => new UserId(userId)));
  await internals.outgoingRequestsManager.doProcessOutgoingRequests();
  return true;
}

/**
 * Sends `content` as a to-device message to every device of each of `userIds`, Olm-encrypted to
 * each device where it can be. Anyone it couldn't be encrypted for — no crypto in this client, or
 * none of their devices has keys — gets it plain, so a report still arrives. Resolves to who got
 * it encrypted and who plain.
 */
export async function sendEncryptedToDevice(
  mx: MatrixClient,
  userIds: string[],
  type: string,
  content: Record<string, unknown>
): Promise<{ encrypted: string[]; plain: string[] }> {
  const crypto = mx.getCrypto();
  const encrypted = new Set<string>();
  if (crypto && (await trackDevices(mx, userIds).catch(() => false))) {
    try {
      const deviceMap = await crypto.getUserDeviceInfo(userIds);
      const devices = [...deviceMap].flatMap(([userId, byId]) => [...byId.keys()].map((deviceId) => ({ userId, deviceId })));
      if (devices.length > 0) {
        const batch = await crypto.encryptToDeviceMessages(type, devices, content);
        if (batch.batch.length > 0) {
          await mx.queueToDevice(batch);
          for (const { userId } of batch.batch) encrypted.add(userId);
        }
      }
    } catch (err) {
      console.warn('Couldn’t encrypt a to-device message; sending it plain', err);
      encrypted.clear();
    }
  }
  const plain = userIds.filter((userId) => !encrypted.has(userId));
  if (plain.length > 0) {
    await mx.sendToDevice(type, new Map(plain.map((userId) => [userId, new Map([['*', content as any]])])));
  }
  return { encrypted: [...encrypted], plain };
}

// --- Filing and reading the queue ----------------------------------------------------------

function isReportContent(value: unknown): value is ReportContent {
  const c = value as Partial<ReportContent> | null;
  return (
    !!c &&
    typeof c.report_id === 'string' &&
    typeof c.space_id === 'string' &&
    typeof c.room_id === 'string' &&
    typeof c.event_id === 'string' &&
    typeof c.reported_user === 'string' &&
    typeof c.reason === 'string' &&
    typeof c.reported_at === 'number'
  );
}

/**
 * A report that came in by to-device, filed into the Space's review room if this client can: it
 * has to be a moderator's, in that room. Reports claiming a Space the sender isn't a member of, or
 * one this user doesn't moderate, are dropped. Returns whether it was filed.
 */
export async function fileIncomingReport(mx: MatrixClient, sender: string, content: unknown): Promise<boolean> {
  if (!isReportContent(content)) return false;
  const space = mx.getRoom(content.space_id);
  const myUserId = mx.getUserId() ?? '';
  if (!space || !isSpaceModerator(space, myUserId)) return false;
  if (space.getMember(sender)?.membership !== 'join') return false;
  const reviewRoomId = readModerationConfig(space).reviewRoomId;
  const reviewRoom = reviewRoomId ? mx.getRoom(reviewRoomId) : null;
  if (!reviewRoom || reviewRoom.getMyMembership() !== 'join') return false;
  // Filed by more than one moderator's client at once, it's shown once (readReports).
  if (readReports(reviewRoom).some((r) => r.report_id === content.report_id)) return true;
  const { automod: _ignored, ...fromReporter } = content;
  await mx.sendEvent(reviewRoom.roomId, REPORT_EVENT as any, { ...fromReporter, reporter: sender } as any);
  return true;
}

/** Automod's own report, filed straight into the review room by the moderator's client that
 *  caught the message. Its id is fixed per message, so two moderators catching it file one. */
export async function fileAutomodReport(mx: MatrixClient, space: Room, event: MatrixEvent, word: string, deleted: boolean): Promise<void> {
  const reviewRoomId = readModerationConfig(space).reviewRoomId;
  const reviewRoom = reviewRoomId ? mx.getRoom(reviewRoomId) : null;
  const eventId = event.getId();
  if (!reviewRoom || reviewRoom.getMyMembership() !== 'join' || !eventId) return;
  const reportId = `automod:${eventId}`;
  if (readReports(reviewRoom).some((r) => r.report_id === reportId)) return;
  const content: ReportContent & { reporter: string } = {
    report_id: reportId,
    space_id: space.roomId,
    room_id: event.getRoomId() ?? '',
    event_id: eventId,
    reported_user: event.getSender() ?? '',
    reason: `Contains “${word}”`,
    ...(!event.isEncrypted() && { excerpt: excerptOf(event.getContent()) }),
    reported_at: Date.now(),
    automod: { word, deleted },
    reporter: mx.getUserId() ?? '',
  };
  await mx.sendEvent(reviewRoom.roomId, REPORT_EVENT as any, content as any);
}

/**
 * The reports in what's loaded of a review room, newest first, one per report id, each with its
 * latest resolution. Only events from the room's moderators count: anyone else in it (someone
 * who's just been demoted, before they're removed) can't file or resolve anything.
 */
export function readReports(reviewRoom: Room): Report[] {
  const events = reviewRoom.getLiveTimeline().getEvents();
  const canAct = (event: MatrixEvent) => userPowerLevel(reviewRoom, event.getSender() ?? '') >= MODERATOR_LEVEL;
  const reports = new Map<string, Report>();
  for (const event of events) {
    if (event.getType() !== REPORT_EVENT || event.isRedacted() || !canAct(event)) continue;
    // Not until the server has it: a local echo's id is a temporary "~…" one, and resolving a
    // report by that id would point at nothing (and make the SDK throw).
    if (event.getId()?.startsWith('~')) continue;
    const content = event.getContent<ReportContent & { reporter?: string }>();
    if (!isReportContent(content) || reports.has(content.report_id)) continue;
    reports.set(content.report_id, {
      ...content,
      eventId: event.getId() ?? '',
      reporter: typeof content.reporter === 'string' ? content.reporter : event.getSender() ?? '',
    });
  }
  const byEventId = new Map([...reports.values()].map((r) => [r.eventId, r]));
  for (const event of events) {
    if (event.getType() !== RESOLUTION_EVENT || !canAct(event)) continue;
    const content = event.getContent<{ action?: Resolution; 'm.relates_to'?: { event_id?: string } }>();
    const report = byEventId.get(content['m.relates_to']?.event_id ?? '');
    if (!report || !content.action) continue;
    report.resolution = { action: content.action, by: event.getSender() ?? '', at: event.getTs() };
  }
  return [...reports.values()].sort((a, b) => b.reported_at - a.reported_at);
}

export async function resolveReport(mx: MatrixClient, reviewRoomId: string, report: Report, action: Resolution): Promise<void> {
  await mx.sendEvent(reviewRoomId, RESOLUTION_EVENT as any, {
    action,
    'm.relates_to': { rel_type: 'm.reference', event_id: report.eventId },
  } as any);
}

/** The Space whose moderator invited you to its review room, if that's what this invite is. */
export function reviewRoomInviteFromModerator(mx: MatrixClient, room: Room): Room | undefined {
  const myUserId = mx.getUserId();
  if (!myUserId || room.getMyMembership() !== 'invite') return undefined;
  const inviter = room.getMember(myUserId)?.events.member?.getSender();
  const space = spaceOfReviewRoom(mx, room.roomId);
  return space && inviter && isSpaceModerator(space, inviter) ? space : undefined;
}

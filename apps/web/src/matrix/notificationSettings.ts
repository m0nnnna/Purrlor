import { EventType, PushRuleKind, type IPushRule, type IPushRules, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { readFreshAccountData } from './freshAccountData';

/**
 * Per-channel and per-Space notification settings — Discord's three choices, for channels, DMs
 * and whole Spaces:
 *
 * - **All messages** — the homeserver's defaults: every message notifies.
 * - **Only @mentions** — a `room` push rule for the room with no actions. Mentions are `override`
 *   rules, which run before `room` rules, so they still notify; plain messages don't.
 * - **Nothing** — an `override` push rule matching the room, with no actions. It runs before the
 *   mention rules too, so nothing in the room notifies.
 *
 * Both rules take the room ID as their rule ID, the convention Element, Cinny and others use for
 * these same settings, so they show up in those clients as well. And because they're push rules,
 * the homeserver applies them: the unread badges (useUnreadCounts.ts, counted by the server),
 * DesktopNotifications (the same evaluation, client-side) and background push (the homeserver
 * only calls the push gateway when a rule says notify) all agree without any of them knowing
 * about this module. Checked against Continuwuity: plain messages and mentions notify, don't, or
 * only mentions do, exactly as above, and an override beats a room rule for the same room.
 *
 * Matrix has no Space-level push rules, so a Space's setting is the setting of each of its
 * channels: this module writes the rules into every channel of the Space, and
 * NotificationRules.tsx re-applies them when a channel is added or joined. What you chose is kept
 * in account data (`xyz.nekous.notification_settings`), and the push rules are worked out from it
 * — a Space's level for its channels, a channel's own level over its Space's. So reconciling is a
 * pure function of account data: two devices applying it at once end up with the same rules, and
 * a room this app has no setting for is never touched (a setting made in Element for a DM stays).
 * The cost: a setting changed in another client for a channel whose Space has a level here is put
 * back to what Purrlor says on the next pass. docs/notification-settings.md has the full design.
 */

export type NotificationLevel = 'all' | 'mentions' | 'nothing';

export type NotificationSettings = {
  /** A Space's level applies to each of its channels that has no level of its own. */
  spaces: Record<string, NotificationLevel>;
  /** A channel's or DM's own level. */
  rooms: Record<string, NotificationLevel>;
};

export const NOTIFICATION_SETTINGS_ACCOUNT_DATA = 'xyz.nekous.notification_settings';

const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'nothing'];

function isLevel(value: unknown): value is NotificationLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

function readLevels(value: unknown): Record<string, NotificationLevel> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, NotificationLevel] => isLevel(entry[1]))
  );
}

export function parseNotificationSettings(content: unknown): NotificationSettings {
  const raw = (content && typeof content === 'object' ? content : {}) as Record<string, unknown>;
  return { spaces: readLevels(raw.spaces), rooms: readLevels(raw.rooms) };
}

export function readNotificationSettings(mx: MatrixClient): NotificationSettings {
  return parseNotificationSettings(mx.getAccountData(NOTIFICATION_SETTINGS_ACCOUNT_DATA as any)?.getContent());
}

/** When a room is in several Spaces with different levels, the loudest wins: a Space you still
 *  want everything from shouldn't go quiet because another Space holding the same room did. */
function loudest(levels: NotificationLevel[]): NotificationLevel | undefined {
  if (levels.length === 0) return undefined;
  return LEVELS.find((level) => levels.includes(level));
}

/** The Spaces a room is a channel of, for the rooms that matter here. */
export type SpaceChildren = Record<string, string[]>;

/** The level a room gets from its Spaces, if any of them has one. */
export function inheritedLevel(settings: NotificationSettings, spaceChildren: SpaceChildren, roomId: string): NotificationLevel | undefined {
  return loudest(
    Object.entries(spaceChildren)
      .filter(([spaceId, children]) => settings.spaces[spaceId] && children.includes(roomId))
      .map(([spaceId]) => settings.spaces[spaceId])
  );
}

/** A room's level from this app's settings: its own, else its Spaces'. Undefined when neither
 *  says anything — then the push rules (readRuleLevel) are the only answer. */
export function settingsLevel(settings: NotificationSettings, spaceChildren: SpaceChildren, roomId: string): NotificationLevel | undefined {
  return settings.rooms[roomId] ?? inheritedLevel(settings, spaceChildren, roomId);
}

// --- Push rules --------------------------------------------------------------------------

type RuleState = { override: boolean; room: boolean };

function wantedRuleState(level: NotificationLevel): RuleState {
  return { override: level === 'nothing', room: level === 'mentions' };
}

function findRule(rules: IPushRules | undefined, kind: 'override' | 'room', roomId: string): IPushRule | undefined {
  return rules?.global?.[kind]?.find((rule) => rule.rule_id === roomId);
}

/** Actions that don't notify: none at all, or the deprecated "dont_notify" older clients write. */
function isSilent(rule: IPushRule): boolean {
  return rule.actions.every((action) => action === 'dont_notify');
}

/** A room's level as its push rules have it, however they got there (this app, or Element). */
export function readRuleLevel(rules: IPushRules | undefined, roomId: string): NotificationLevel {
  const override = findRule(rules, 'override', roomId);
  if (override?.enabled && isSilent(override)) return 'nothing';
  const room = findRule(rules, 'room', roomId);
  if (room?.enabled && isSilent(room)) return 'mentions';
  return 'all';
}

function currentRuleState(rules: IPushRules | undefined, roomId: string): RuleState {
  return { override: !!findRule(rules, 'override', roomId), room: !!findRule(rules, 'room', roomId) };
}

export type RuleChange =
  | { op: 'add'; kind: 'override' | 'room'; roomId: string }
  | { op: 'delete'; kind: 'override' | 'room'; roomId: string };

/**
 * The push-rule changes that make these rooms' rules match their levels. `rooms` is every room
 * whose rules this app manages right now. A rule that exists but isn't exactly ours (a room rule
 * that notifies, say, left by another client) is replaced, not kept. Pure, so it's tested
 * directly.
 */
export function planRuleChanges(rules: IPushRules | undefined, levels: Record<string, NotificationLevel>): RuleChange[] {
  return Object.entries(levels).flatMap(([roomId, level]) => {
    const want = wantedRuleState(level);
    const have = currentRuleState(rules, roomId);
    const override = findRule(rules, 'override', roomId);
    const room = findRule(rules, 'room', roomId);
    const changes: RuleChange[] = [];
    if (have.override && (!want.override || !override?.enabled || !isSilent(override))) {
      changes.push({ op: 'delete', kind: 'override', roomId });
    }
    if (have.room && (!want.room || !room?.enabled || !isSilent(room))) {
      changes.push({ op: 'delete', kind: 'room', roomId });
    }
    if (want.override && !(override?.enabled && isSilent(override))) changes.push({ op: 'add', kind: 'override', roomId });
    if (want.room && !(room?.enabled && isSilent(room))) changes.push({ op: 'add', kind: 'room', roomId });
    return changes;
  });
}

async function applyRuleChange(mx: MatrixClient, change: RuleChange): Promise<void> {
  const kind = change.kind === 'override' ? PushRuleKind.Override : PushRuleKind.RoomSpecific;
  if (change.op === 'delete') {
    try {
      await mx.deletePushRule('global', kind, change.roomId);
    } catch (err) {
      // Already gone (another device got there first) is the outcome we wanted.
      if ((err as { errcode?: string }).errcode !== 'M_NOT_FOUND') throw err;
    }
    return;
  }
  const body =
    change.kind === 'override'
      ? { conditions: [{ kind: 'event_match', key: 'room_id', pattern: change.roomId }], actions: [] }
      : { actions: [] };
  await mx.addPushRule('global', kind, change.roomId, body as Parameters<MatrixClient['addPushRule']>[3]);
}

async function applyRuleChanges(mx: MatrixClient, changes: RuleChange[]): Promise<void> {
  // Deletes first: a room going from Nothing to Only @mentions never has both rules at once.
  for (const change of changes.filter((c) => c.op === 'delete')) await applyRuleChange(mx, change);
  for (const change of changes.filter((c) => c.op === 'add')) await applyRuleChange(mx, change);
}

/** Fresh from the server, not the copy from the last sync: this runs right after writes, and
 *  a stale copy would redo or undo them. (The SDK also updates `mx.pushRules` with it, so
 *  DesktopNotifications sees a change straight away.) */
async function fetchRules(mx: MatrixClient): Promise<IPushRules> {
  return mx.getPushRules();
}

// --- Spaces ------------------------------------------------------------------------------

type SpaceChildContent = { via?: unknown };

/** The joined, non-Space rooms under each joined Space — what the channel list shows. */
export function listSpaceChildren(mx: MatrixClient): SpaceChildren {
  const result: SpaceChildren = {};
  for (const space of mx.getRooms()) {
    if (!space.isSpaceRoom() || space.getMyMembership() !== 'join') continue;
    const children = (space.currentState.getStateEvents(EventType.SpaceChild) as MatrixEvent[])
      .filter((event) => {
        const via = event.getContent<SpaceChildContent>().via;
        return Array.isArray(via) && via.length > 0;
      })
      .map((event) => event.getStateKey() ?? '')
      .filter((roomId) => {
        const room = mx.getRoom(roomId);
        return !!room && !room.isSpaceRoom() && room.getMyMembership() === 'join';
      });
    result[space.roomId] = children;
  }
  return result;
}

/** Every room this app manages the rules of, with the level it should have. */
export function managedLevels(settings: NotificationSettings, spaceChildren: SpaceChildren): Record<string, NotificationLevel> {
  const levels: Record<string, NotificationLevel> = {};
  for (const [spaceId, children] of Object.entries(spaceChildren)) {
    if (!settings.spaces[spaceId]) continue;
    for (const roomId of children) {
      const level = settingsLevel(settings, spaceChildren, roomId);
      if (level) levels[roomId] = level;
    }
  }
  for (const [roomId, level] of Object.entries(settings.rooms)) levels[roomId] = level;
  return levels;
}

/**
 * Makes the push rules of every room this app manages match the settings. Changes nothing when
 * they already match, so it's cheap to run on every start (NotificationRules.tsx does).
 */
export async function syncNotificationRules(mx: MatrixClient, settings: NotificationSettings = readNotificationSettings(mx)): Promise<void> {
  const levels = managedLevels(settings, listSpaceChildren(mx));
  if (Object.keys(levels).length === 0) return;
  await applyRuleChanges(mx, planRuleChanges(await fetchRules(mx), levels));
}

// --- What the settings UI calls ------------------------------------------------------------

/** For a read-modify-write, so a level just set on another device isn't undone (see
 *  freshAccountData.ts). */
async function readFreshSettings(mx: MatrixClient): Promise<NotificationSettings> {
  return parseNotificationSettings(await readFreshAccountData(mx, NOTIFICATION_SETTINGS_ACCOUNT_DATA));
}

async function writeSettings(mx: MatrixClient, settings: NotificationSettings): Promise<void> {
  await mx.setAccountData(NOTIFICATION_SETTINGS_ACCOUNT_DATA as any, settings as any);
}

/**
 * Rooms that just stopped being managed (their own level cleared, or their Space's) go back to
 * the server's defaults. Done here, when the setting changes, rather than on every sync: a room
 * nobody set anything for in this app may have rules from another client, and those stay.
 */
async function releaseRooms(mx: MatrixClient, roomIds: string[], stillManaged: Record<string, NotificationLevel>): Promise<void> {
  const released = Object.fromEntries(roomIds.filter((roomId) => !stillManaged[roomId]).map((roomId) => [roomId, 'all' as const]));
  if (Object.keys(released).length === 0) return;
  await applyRuleChanges(mx, planRuleChanges(await fetchRules(mx), released));
}

/** A channel's or DM's own level; `undefined` goes back to its Space's level, or the default. */
export async function setRoomNotificationLevel(mx: MatrixClient, roomId: string, level: NotificationLevel | undefined): Promise<void> {
  const settings = await readFreshSettings(mx);
  const rooms = { ...settings.rooms };
  if (level) rooms[roomId] = level;
  else delete rooms[roomId];
  const next = { ...settings, rooms };
  await writeSettings(mx, next);
  const spaceChildren = listSpaceChildren(mx);
  await releaseRooms(mx, [roomId], managedLevels(next, spaceChildren));
  await syncNotificationRules(mx, next);
}

/** A Space's level for its channels; `undefined` goes back to the default. */
export async function setSpaceNotificationLevel(mx: MatrixClient, spaceId: string, level: NotificationLevel | undefined): Promise<void> {
  const settings = await readFreshSettings(mx);
  const spaces = { ...settings.spaces };
  if (level) spaces[spaceId] = level;
  else delete spaces[spaceId];
  const next = { ...settings, spaces };
  await writeSettings(mx, next);
  const spaceChildren = listSpaceChildren(mx);
  await releaseRooms(mx, spaceChildren[spaceId] ?? [], managedLevels(next, spaceChildren));
  await syncNotificationRules(mx, next);
}

/** What a room's notification menu shows: its own level if it has one, else what it inherits
 *  (from its Spaces here, or from rules another client wrote), marked as inherited. */
export function describeRoomLevel(
  mx: MatrixClient,
  roomId: string
): { own: NotificationLevel | undefined; effective: NotificationLevel; fromSpace: NotificationLevel | undefined } {
  const settings = readNotificationSettings(mx);
  const fromSpace = inheritedLevel(settings, listSpaceChildren(mx), roomId);
  const own = settings.rooms[roomId];
  return { own, fromSpace, effective: own ?? fromSpace ?? readRuleLevel(mx.pushRules, roomId) };
}

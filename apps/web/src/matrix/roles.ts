import type { MatrixClient, Room } from 'matrix-js-sdk';
import { SPACE_NEWS_EVENT } from './spaceNews';
import { isRemoteUser } from './homeServer';

/**
 * Named roles over Matrix's raw power levels. Matrix has no role objects of its own, only an
 * integer per person per room; this is the one place that decides what a number *means* to a
 * person looking at the member list or a message's sender name. docs/roles.md has the design.
 *
 * Three roles are built in — Admin (100), Moderator (50), Member (0) — and a Space can add its own
 * between them (`xyz.nekous.roles`, readSpaceRoles): "Helper" at 25, "Senior mod" at 75. A custom
 * role is a tier, not a set of flags: Matrix gives each person one level, so each person has one
 * role, and what a role can do is whatever that level reaches (the Space's thresholds, see
 * capabilities below), copied into every channel by the role sync (channelPermissions.ts).
 */
export type RoleId = string;

export type RoleLevel = {
  id: RoleId;
  label: string;
  pluralLabel: string;
  value: number;
  /** A custom role's colour for names and badges (#rrggbb); built-ins use the theme's. */
  color?: string;
  custom?: boolean;
};

export const ROLE_LEVELS: RoleLevel[] = [
  { id: 'admin', label: 'Admin', pluralLabel: 'Admins', value: 100 },
  { id: 'moderator', label: 'Moderator', pluralLabel: 'Moderators', value: 50 },
  { id: 'member', label: 'Member', pluralLabel: 'Members', value: 0 },
];

export const ROLES_EVENT = 'xyz.nekous.roles';

/** Custom roles per Space, and how long a name may be. */
export const MAX_CUSTOM_ROLES = 20;
const MAX_NAME = 32;

type StoredRole = { id?: unknown; name?: unknown; level?: unknown; color?: unknown };

const BUILT_IN_LEVELS = new Set(ROLE_LEVELS.map((role) => role.value));

/** A Space's custom roles from its `xyz.nekous.roles` content: each at a level of its own
 *  between 1 and 99 (not 50, Moderator's), with a name. Anything else is left out. Pure. */
export function parseCustomRoles(content: unknown): RoleLevel[] {
  const stored = (content as { roles?: unknown } | undefined)?.roles;
  if (!Array.isArray(stored)) return [];
  const taken = new Set(BUILT_IN_LEVELS);
  const roles: RoleLevel[] = [];
  for (const item of stored as StoredRole[]) {
    const { id, name, level, color } = item ?? {};
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) continue;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 99 || taken.has(level)) continue;
    taken.add(level);
    const label = name.trim().slice(0, MAX_NAME);
    roles.push({
      id: `custom:${id}`,
      label,
      pluralLabel: label,
      value: level,
      ...(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) && { color: color.toLowerCase() }),
      custom: true,
    });
    if (roles.length === MAX_CUSTOM_ROLES) break;
  }
  return roles;
}

/** Every role a Space has, highest first: the built-ins and its own. Built-ins alone without one. */
export function readSpaceRoles(space: Room | null | undefined): RoleLevel[] {
  const custom = space ? parseCustomRoles(space.currentState.getStateEvents(ROLES_EVENT, '')?.getContent()) : [];
  return [...ROLE_LEVELS, ...custom].sort((a, b) => b.value - a.value);
}

/** The role a power level holds: the highest one at or below it. */
export function roleFor(powerLevel: number, roles: RoleLevel[] = ROLE_LEVELS): RoleLevel {
  const sorted = [...roles].sort((a, b) => b.value - a.value);
  return sorted.find((role) => powerLevel >= role.value) ?? sorted[sorted.length - 1];
}

/** The custom roles as stored, for saving an edited list. */
export function toStoredRoles(roles: RoleLevel[]): { roles: { id: string; name: string; level: number; color?: string }[] } {
  return {
    roles: roles
      .filter((role) => role.custom)
      .map((role) => ({ id: role.id.replace(/^custom:/, ''), name: role.label, level: role.value, ...(role.color && { color: role.color }) })),
  };
}

export async function saveCustomRoles(mx: MatrixClient, space: Room, roles: RoleLevel[]): Promise<void> {
  await mx.sendStateEvent(space.roomId, ROLES_EVENT as any, toStoredRoles(roles) as any, '');
}

/** The lowest level that is a role (the lowest custom one, else Moderator's): anyone at or above it
 *  in a Space holds a role there, and the role sync carries it into the channels. */
export function lowestRoleLevel(roles: RoleLevel[]): number {
  return Math.min(50, ...roles.filter((role) => role.value > 0).map((role) => role.value));
}

// --- What a role can do ----------------------------------------------------------------------

/**
 * The actions a Space lets its roles do, each as the minimum power level it takes — Matrix's own
 * thresholds, set on the Space and copied into its channels by the role sync, so the homeserver
 * enforces them in every room. A `spaceOnly` one is about the Space itself (its news), so it isn't
 * copied into the channels.
 */
export type Capability = 'redact' | 'kick' | 'ban' | 'invite' | 'pin' | 'news';

export const CAPABILITIES: { id: Capability; label: string; defaultLevel: number; spaceOnly?: boolean }[] = [
  { id: 'redact', label: 'Delete other people’s messages', defaultLevel: 50 },
  { id: 'pin', label: 'Pin messages', defaultLevel: 50 },
  { id: 'kick', label: 'Remove members', defaultLevel: 50 },
  { id: 'ban', label: 'Ban members', defaultLevel: 50 },
  { id: 'invite', label: 'Invite people', defaultLevel: 0 },
  { id: 'news', label: 'Edit the Space’s news', defaultLevel: 50, spaceOnly: true },
];

type Thresholds = { redact?: number; kick?: number; ban?: number; invite?: number; events?: Record<string, number>; [key: string]: unknown };

/** The capabilities that are a state event's own level (in `events`) rather than a named threshold. */
const EVENT_CAPABILITIES: Partial<Record<Capability, string>> = {
  pin: 'm.room.pinned_events',
  news: SPACE_NEWS_EVENT,
};

/** A capability's level in a room's power levels, with the spec's defaults. Pure. */
export function capabilityLevel(levels: Thresholds, capability: Capability): number {
  const eventType = EVENT_CAPABILITIES[capability];
  if (eventType) return levels.events?.[eventType] ?? (levels.state_default as number | undefined) ?? 50;
  const value = levels[capability];
  return typeof value === 'number' ? value : capability === 'invite' ? 0 : 50;
}

/** Power levels with one capability set to `level`. Pure. */
export function withCapability<T extends Thresholds>(levels: T, capability: Capability, level: number): T {
  const eventType = EVENT_CAPABILITIES[capability];
  if (eventType) return { ...levels, events: { ...levels.events, [eventType]: level } };
  return { ...levels, [capability]: level };
}

/** A member's handle for display under their name — the localpart of their Matrix ID
 *  (`@neko:example.org` → `@neko`), the part people actually recognize and type in mentions. */
export function handleFor(userId: string): string {
  // A federated instance's people keep their server (homeServer.ts): `@mochi:cats.example`.
  if (isRemoteUser(userId)) return userId;
  const colon = userId.indexOf(':');
  return colon > 0 ? userId.slice(0, colon) : userId;
}

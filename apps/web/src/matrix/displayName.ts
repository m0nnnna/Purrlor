import { RoomMember } from 'matrix-js-sdk';
import { handleFor } from './roles';

/**
 * What to call someone who never set a display name: their handle without the "@" — `mino` for
 * `@mino:this.server`, `mochi:cats.example` for someone on another server (handleFor keeps a
 * federated person's server, so two people called mochi are never confused). Matrix's own
 * fallback, and matrix-js-sdk's, is the full user ID, which filled the timeline, the member list
 * and the user panel with `@mino:matrix.example.org`.
 */
export function fallbackName(userId: string): string {
  return handleFor(userId).replace(/^@/, '');
}

/** A profile's display name, or the fallback above when it has none (the SDK's User object
 *  reports a missing one as the user ID itself). */
export function nameOrFallback(displayName: string | null | undefined, userId: string): string {
  return displayName?.trim() && displayName !== userId ? displayName : fallbackName(userId);
}

type NamedMember = { userId: string; name: string };

/** Swaps the SDK's user-ID stand-in for fallbackName. Exported for the test. */
export function applyNameFallback(member: NamedMember): void {
  if (member.name === member.userId) member.name = fallbackName(member.userId);
}

let installed = false;

/**
 * matrix-js-sdk computes RoomMember.name inside the two methods below with a module-private
 * helper that returns the user ID when there's no display name, and around 45 places in the app
 * read `member.name`. Rather than wrap every one of them, the fallback is applied once, right
 * after the SDK sets the name. The SDK is pinned to an exact version in package.json; if a
 * future version renames these methods, names quietly go back to full user IDs, nothing breaks.
 *
 * Call before the client starts syncing, and after setHomeServer, since which server counts as
 * "this one" decides whether the fallback keeps the server part.
 */
export function installMemberNameFallback(): void {
  if (installed) return;
  installed = true;
  const proto = RoomMember.prototype as unknown as Record<string, unknown>;
  for (const method of ['setMembershipEvent', 'recalculateDisambiguatedName']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function (this: RoomMember, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      applyNameFallback(this);
      return result;
    };
  }
}

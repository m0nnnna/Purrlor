import { useEffect, useSyncExternalStore } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useMatrixClient } from './MatrixClientContext';
import { getExtendedProfile } from './extendedProfile';

/**
 * The color your name shows in chat, chosen by you instead of the hue picked from your name
 * (Avatar.tsx's nameHue). Set once on your profile (the `xyz.nekous.name_color` extended-profile
 * field, extendedProfile.ts), so it's the same in every room and DM, to people on any server.
 * A role's own color still wins over it, as on Discord: that's how people spot the moderators.
 */

/** Ready-made choices, all light enough to read on the dark themes. */
export const NAME_COLOR_PRESETS = [
  '#ff8fab',
  '#ff9e7a',
  '#ffd166',
  '#b9f18c',
  '#6ee7b7',
  '#7dd3fc',
  '#a5b4fc',
  '#d8b4fe',
  '#f0abfc',
  '#e5e7eb',
] as const;

/** A name color as drawn: mixed toward the text color as far as the theme asks
 *  (`--nu-name-ink-mix`, tokens.css), so the pale colors still read on a light theme. */
export function nameColorStyle(color: string): string {
  return `color-mix(in oklab, ${color}, var(--nu-color-text-primary) var(--nu-name-ink-mix, 0%))`;
}

/** `#rrggbb`, lowercased, or '' for anything else. Applied when reading anyone's, since a profile
 *  field can be written by any client, and it ends up in a style attribute. */
export function sanitizeNameColor(raw: unknown): string {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : '';
}

// Read once per person and kept a while: a busy channel has many messages from the same few people.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { color: string; at: number }>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function load(mx: MatrixClient, userId: string): void {
  const cached = cache.get(userId);
  if ((cached && Date.now() - cached.at < CACHE_TTL_MS) || pending.has(userId)) return;
  pending.add(userId);
  void getExtendedProfile(mx, userId, { maxAgeMs: CACHE_TTL_MS })
    .then((profile) => {
      const color = sanitizeNameColor(profile.nameColor);
      const changed = cache.get(userId)?.color !== color;
      cache.set(userId, { color, at: Date.now() });
      if (changed) notify();
    })
    .finally(() => pending.delete(userId));
}

/** After saving your own, so your next message shows it without waiting out the cache. */
export function rememberNameColor(userId: string, color: string): void {
  cache.set(userId, { color: sanitizeNameColor(color), at: Date.now() });
  notify();
}

/** Someone's chosen name color, or undefined (not set, or not loaded yet). */
export function useNameColor(userId: string | undefined): string | undefined {
  const mx = useMatrixClient();
  useEffect(() => {
    if (userId) load(mx, userId);
  }, [mx, userId]);
  return useSyncExternalStore(subscribe, () => (userId && cache.get(userId)?.color) || undefined);
}

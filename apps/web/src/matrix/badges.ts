import { useEffect, useState } from 'react';
import { isDemoMode } from '../demo/demoMode';

/**
 * Badges (docs/federation.md, "Badges"): the 4-letter coloured pills admins give out. Made and
 * given only through `purrlor badges` on the server; the app only reads them, from
 * `GET /api/public/badges` (this server's and its peers', by user ID). Nothing here writes.
 */

export type Badge = { id: string; text: string; color: string };
export type BadgeMap = Record<string, Badge[]>;

const API = '/api/public/badges';
const TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 60_000;

export function parseBadges(raw: unknown): BadgeMap {
  const list = (raw as { badges?: unknown } | null)?.badges;
  const out: BadgeMap = {};
  if (!list || typeof list !== 'object' || Array.isArray(list)) return out;
  for (const [user, entries] of Object.entries(list)) {
    if (!user.startsWith('@') || !Array.isArray(entries)) continue;
    const good = entries.flatMap((entry) => {
      const b = entry as Record<string, unknown> | null;
      return b && typeof b.id === 'string' && typeof b.text === 'string' && /^.{4}$/u.test(b.text) && typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)
        ? [{ id: b.id, text: b.text, color: b.color }]
        : [];
    });
    if (good.length) out[user] = good.slice(0, 5);
  }
  return out;
}

/** Black or white, whichever reads better on `color`. */
export function badgeTextColor(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111' : '#fff';
}

let current: BadgeMap = {};
let loadedAt = 0;
let ttl = TTL_MS;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function refresh(): void {
  if (isDemoMode() || loading || Date.now() - loadedAt < ttl) return;
  loading = fetch(API)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      current = parseBadges(await response.json());
      ttl = TTL_MS;
      listeners.forEach((fn) => fn());
    })
    .catch(() => {
      ttl = FAILED_TTL_MS;
    })
    .finally(() => {
      loadedAt = Date.now();
      loading = undefined;
    });
}

/** The badges an admin gave this person (none for most), reading the list once and reusing it. */
export function useBadges(userId: string | undefined): Badge[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    refresh();
    return () => void listeners.delete(fn);
  }, []);
  return (userId && current[userId]) || [];
}

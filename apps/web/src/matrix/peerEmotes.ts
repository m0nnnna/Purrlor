import type { MatrixClient } from 'matrix-js-sdk';
import { isDemoMode } from '../demo/demoMode';
import type { Emote, Sticker } from './emotes';
import { getOpenIdTokenCached } from './openIdToken';

/**
 * Emotes and stickers from approved peers' global emote libraries (docs/federation.md, "Emotes and
 * stickers"): the token server's bot reads them, and hands them to this server's own people
 * (`POST /api/public/peers/emotes`). Usable like the global library's: a message carries the
 * emote's image, which every homeserver can fetch, so anyone reading it sees it.
 *
 * A peer's shortcodes get its server name added (`:wave:` from cats.example is
 * `:wave+cats-example:`), so a peer's emote never stands in for this server's own of the same name.
 */

const API = '/api/public/peers/emotes';

export type PeerEmoteSet = { serverName: string; name: string; emotes: Emote[]; stickers: Sticker[] };

/** `wave` from `cats.example` → `wave+cats-example`: still only the characters a shortcode allows. */
export function peerShortcode(shortcode: string, serverName: string): string {
  return `${shortcode}+${serverName.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

const MXC = /^mxc:\/\/[^/\s]+\/[^/\s?#]+$/;
const SHORTCODE = /^[a-zA-Z0-9_+-]{1,100}$/;

/** The token server's answer, checked: anything out of shape is left out. Pure. */
export function parsePeerEmotes(raw: unknown): PeerEmoteSet[] {
  const peers = (raw as { peers?: unknown } | null)?.peers;
  if (!Array.isArray(peers)) return [];
  return peers.flatMap((peer): PeerEmoteSet[] => {
    const { serverName, name, images } = (peer ?? {}) as { serverName?: unknown; name?: unknown; images?: unknown };
    if (typeof serverName !== 'string' || !serverName || !Array.isArray(images)) return [];
    const emotes: Emote[] = [];
    const stickers: Sticker[] = [];
    for (const image of images as Record<string, unknown>[]) {
      if (typeof image?.shortcode !== 'string' || !SHORTCODE.test(image.shortcode) || typeof image.url !== 'string' || !MXC.test(image.url)) continue;
      const shortcode = peerShortcode(image.shortcode, serverName);
      if (image.emoticon === true) emotes.push({ shortcode, mxcUrl: image.url });
      if (image.sticker === true) {
        stickers.push({ shortcode, mxcUrl: image.url, body: typeof image.body === 'string' && image.body ? image.body : image.shortcode });
      }
    }
    const label = typeof name === 'string' && name.trim() ? name.trim() : serverName;
    return emotes.length || stickers.length ? [{ serverName, name: label, emotes, stickers }] : [];
  });
}

/** What this server's peers' libraries hold now (empty without peers), or undefined when the server can't say. */
export async function fetchPeerEmotes(mx: MatrixClient): Promise<PeerEmoteSet[] | undefined> {
  if (isDemoMode()) return [];
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openid_token: await getOpenIdTokenCached(mx) }),
    });
    return res.ok ? parsePeerEmotes(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}

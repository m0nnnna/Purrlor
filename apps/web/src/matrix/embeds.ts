import type { EncryptedAttachmentInfo } from 'browser-encrypt-attachment';

/**
 * Link embeds (docs/embeds.md): the `xyz.nekous.embeds` field a message or post carries, read
 * defensively (it's whatever the sender's client wrote), the links a body has that may get one,
 * and the table of players the app will load, built from validated IDs only.
 */

export const EMBEDS_KEY = 'xyz.nekous.embeds';
export const MAX_EMBEDS = 3;

export type EmbedKind = 'card' | 'post' | 'player' | 'image' | 'video' | 'audio';

export type EmbedImageInfo = { mimetype: string; size?: number; w?: number; h?: number; duration?: number };
/** A picture or file: plain (`url`) or, in an encrypted room, an encrypted attachment (`file`). */
export type EmbedFile = { url?: string; file?: EncryptedAttachmentInfo & { url: string }; info: EmbedImageInfo };

export type StoredEmbed = {
  url: string;
  kind: EmbedKind;
  site?: { name?: string; color?: string };
  title?: string;
  description?: string;
  author?: { name?: string; handle?: string; url?: string; avatar?: EmbedFile };
  image?: EmbedFile;
  media?: EmbedFile;
  player?: { provider: PlayerProvider; id: string };
  published?: number;
  sensitive?: boolean;
};

// --- Players -------------------------------------------------------------------------------------

export type PlayerProvider = 'youtube' | 'vimeo' | 'spotify' | 'soundcloud' | 'twitch-clip' | 'twitch-video' | 'streamable';

type PlayerSpec = { pattern: RegExp; frame: (id: string, parentHost: string) => string; height?: number; audio?: boolean };

/** Every player the app will load, and how. Each frame host is in the app's frame-src. */
export const PLAYERS: Record<PlayerProvider, PlayerSpec> = {
  youtube: { pattern: /^[A-Za-z0-9_-]{11}$/, frame: (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1` },
  vimeo: { pattern: /^\d{1,12}$/, frame: (id) => `https://player.vimeo.com/video/${id}?dnt=1&autoplay=1` },
  spotify: {
    pattern: /^(track|album|playlist|episode|show|artist)\/[A-Za-z0-9]{22}$/,
    frame: (id) => `https://open.spotify.com/embed/${id}`,
    height: 152,
    audio: true,
  },
  soundcloud: {
    pattern: /^[a-z0-9_-]+\/(sets\/)?[a-z0-9_-]+$/,
    frame: (id) => `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${id}`)}&auto_play=true&visual=true`,
    height: 166,
    audio: true,
  },
  'twitch-clip': { pattern: /^[A-Za-z0-9_-]{1,100}$/, frame: (id, host) => `https://clips.twitch.tv/embed?clip=${id}&parent=${host}&autoplay=true` },
  'twitch-video': { pattern: /^\d{1,15}$/, frame: (id, host) => `https://player.twitch.tv/?video=${id}&parent=${host}&autoplay=true` },
  streamable: { pattern: /^[a-z0-9]{3,12}$/, frame: (id) => `https://streamable.com/e/${id}?autoplay=1` },
};

/** The player's frame URL, or undefined for an unknown provider or an ID that doesn't fit it. */
export function playerFrameUrl(player: { provider: string; id: string } | undefined, parentHost: string): string | undefined {
  if (!player || !Object.prototype.hasOwnProperty.call(PLAYERS, player.provider)) return undefined;
  const spec = PLAYERS[player.provider as PlayerProvider];
  return spec.pattern.test(player.id) ? spec.frame(player.id, parentHost) : undefined;
}

export function playerSpec(provider: PlayerProvider): PlayerSpec {
  return PLAYERS[provider];
}

// --- Finding links -------------------------------------------------------------------------------

/**
 * The links in a body that may get an embed, in order, at most MAX_EMBEDS: http(s) links not
 * written `<like this>` (Discord's way of saying "no embed") and not inside code.
 */
export function embeddableLinks(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, (code) => ' '.repeat(code.length)).replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length));
  const links: string[] = [];
  for (const match of withoutCode.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const start = match.index ?? 0;
    if (withoutCode[start - 1] === '<') continue;
    // Trailing punctuation belongs to the sentence, not the link (an unmatched ")" too).
    let link = match[0].replace(/[.,;:!?'"]+$/, '');
    while (link.endsWith(')') && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) link = link.slice(0, -1);
    try {
      new URL(link);
    } catch {
      continue;
    }
    if (!links.includes(link)) links.push(link);
    if (links.length === MAX_EMBEDS) break;
  }
  return links;
}

// --- Reading the field ---------------------------------------------------------------------------

const KINDS = new Set<EmbedKind>(['card', 'post', 'player', 'image', 'video', 'audio']);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

function webLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

const isMxc = (value: unknown): value is string => typeof value === 'string' && /^mxc:\/\/[^/\s]+\/[^/\s?#]+$/.test(value);

function readFile(raw: unknown, kind: 'image' | 'video' | 'audio' | 'media'): EmbedFile | undefined {
  if (!isRecord(raw)) return undefined;
  const info = isRecord(raw.info) ? raw.info : {};
  const mimetype = typeof info.mimetype === 'string' ? info.mimetype : '';
  const ok = kind === 'media' ? /^(video|audio)\//.test(mimetype) : mimetype.startsWith(`${kind}/`);
  if (!ok || /svg/i.test(mimetype)) return undefined;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const cleanInfo: EmbedImageInfo = {
    mimetype,
    ...(num(info.size) !== undefined && { size: num(info.size) }),
    ...(num(info.w) && { w: num(info.w) }),
    ...(num(info.h) && { h: num(info.h) }),
    ...(num(info.duration) !== undefined && { duration: num(info.duration) }),
  };
  if (isMxc(raw.url)) return { url: raw.url, info: cleanInfo };
  const file = raw.file;
  if (isRecord(file) && isMxc(file.url) && isRecord(file.key) && typeof file.iv === 'string' && isRecord(file.hashes)) {
    return { file: file as unknown as EncryptedAttachmentInfo & { url: string }, info: cleanInfo };
  }
  return undefined;
}

/**
 * An event's embeds, cleaned (docs/embeds.md): only links its body has, known kinds, strings cut to
 * their limits, pictures only from mxc or an encrypted file, players only from the table. What
 * doesn't fit is dropped, field by field, rather than refused whole.
 */
export function readEmbeds(content: Record<string, unknown>): StoredEmbed[] {
  const raw = content[EMBEDS_KEY];
  const body = typeof content.body === 'string' ? content.body : '';
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const embeds: StoredEmbed[] = [];
  for (const item of raw) {
    if (!isRecord(item) || embeds.length === MAX_EMBEDS) continue;
    const url = webLink(item.url);
    const kind = typeof item.kind === 'string' && KINDS.has(item.kind as EmbedKind) ? (item.kind as EmbedKind) : undefined;
    if (!url || !kind || !body.includes(url) || seen.has(url)) continue;
    const site = isRecord(item.site) ? item.site : {};
    const author = isRecord(item.author) ? item.author : undefined;
    const color = typeof site.color === 'string' && /^#[0-9a-f]{6}$/i.test(site.color) ? site.color : undefined;
    const player =
      kind === 'player' && isRecord(item.player) && typeof item.player.provider === 'string' && typeof item.player.id === 'string' && playerFrameUrl({ provider: item.player.provider, id: item.player.id }, 'x')
        ? { provider: item.player.provider as PlayerProvider, id: item.player.id }
        : undefined;
    const image = readFile(item.image, 'image');
    const media = kind === 'video' ? readFile(item.media, 'video') : kind === 'audio' ? readFile(item.media, 'audio') : undefined;
    // A file kind without its file has nothing to show; a player without a valid player is a card.
    if (kind === 'image' && !image) continue;
    if ((kind === 'video' || kind === 'audio') && !media) continue;
    const embed: StoredEmbed = {
      url,
      kind: kind === 'player' && !player ? 'card' : kind,
      ...((text(site.name, 64) || color) && { site: { ...(text(site.name, 64) && { name: text(site.name, 64) }), ...(color && { color }) } }),
      ...(text(item.title, 256) && { title: text(item.title, 256) }),
      ...(text(item.description, 1000) && { description: text(item.description, 1000) }),
      ...(image && { image }),
      ...(media && { media }),
      ...(player && { player }),
      ...(typeof item.published === 'number' && Number.isFinite(item.published) && { published: item.published }),
      ...(item.sensitive === true && { sensitive: true }),
    };
    if (author) {
      const avatar = readFile(author.avatar, 'image');
      const a = {
        ...(text(author.name, 128) && { name: text(author.name, 128) }),
        ...(text(author.handle, 128) && { handle: text(author.handle, 128) }),
        ...(webLink(author.url) && { url: webLink(author.url) }),
        ...(avatar && { avatar }),
      };
      if (Object.keys(a).length) embed.author = a;
    }
    // Something to show beyond the link itself.
    if (embed.kind === 'card' && !embed.title && !embed.description) continue;
    seen.add(url);
    embeds.push(embed);
  }
  return embeds;
}

/** Whether an event's content says anything about embeds: then the homeserver's preview isn't asked. */
export function hasEmbedsField(content: Record<string, unknown>): boolean {
  return Array.isArray(content[EMBEDS_KEY]);
}

/** The content keys for a list of embeds (an empty list still says "no embeds": see hasEmbedsField). */
export function embedsContent(embeds: StoredEmbed[]): Record<string, unknown> {
  return { [EMBEDS_KEY]: embeds };
}

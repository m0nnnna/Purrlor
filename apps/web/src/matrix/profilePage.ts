/**
 * **Profile pages**: the homepage a person builds for themselves with the page builder
 * (features/profilePage/). A page is data, never code: colours, a background, fonts, a few fixed
 * effects and a list of blocks, each from a fixed set of choices. Purrlor draws it with its own
 * stylesheet; nothing a person types becomes a CSS selector, property name or `url()`.
 *
 * Stored as one state event in the owner's profile room (profileFeed.ts), which is
 * world-readable and whose state only the owner can set:
 *
 * ```json
 * // xyz.nekous.profile_page, state key ""
 * { "version": 1, "style": { "colors": { "bg": "#1b1530", … }, "background": { "kind": "image", … }, … },
 *   "blocks": [ { "id": "b1", "type": "text", "body": "hi!" }, … ] }
 * ```
 *
 * Empty content (`{}`) means no page. The draft lives in the owner's account data until they
 * publish it. Everything that reads a page, in the app or (later) the public pages endpoint, goes
 * through `parseProfilePage`, which keeps only what it recognises: an unknown block type or field
 * is dropped, a number is clamped to its range, a colour must be `#rrggbb`, an image must be an
 * `mxc://` URL and a link must be `https://`. A page written by another client, or by hand, can
 * be odd but never more than the builder itself could make.
 */

export const PROFILE_PAGE_EVENT = 'xyz.nekous.profile_page';
export const PROFILE_PAGE_DRAFT_ACCOUNT_DATA = 'xyz.nekous.profile_page_draft';
export const PROFILE_PAGE_VERSION = 1;

export const PAGE_FONTS = [
  'figtree',
  'display',
  'pixel',
  'handwriting',
  'serif',
  'mono',
  'rounded',
  'typewriter',
  'comic',
  'condensed',
] as const;
export type PageFont = (typeof PAGE_FONTS)[number];

export const PAGE_BORDERS = ['none', 'solid', 'dashed', 'double', 'glow'] as const;
export type PageBorder = (typeof PAGE_BORDERS)[number];

export const PAGE_EFFECTS = ['none', 'sparkles', 'snow', 'hearts', 'stars'] as const;
export type PageEffect = (typeof PAGE_EFFECTS)[number];

export const BACKGROUND_FITS = ['cover', 'tile', 'fixed'] as const;
export type BackgroundFit = (typeof BACKGROUND_FITS)[number];

export const DIVIDER_STYLES = ['line', 'dots', 'emote'] as const;
export type DividerStyle = (typeof DIVIDER_STYLES)[number];

/** Who may sign a guestbook: anyone signed in, or only people its owner follows. */
export const GUESTBOOK_WHO = ['everyone', 'following'] as const;
export type GuestbookWho = (typeof GUESTBOOK_WHO)[number];

/** A piece's content rating. Mature pieces are blurred until clicked, and hidden unless the viewer
 *  signed in (every account is 18+) and never shown signed out. */
export const ART_RATINGS = ['general', 'mature'] as const;
export type ArtRating = (typeof ART_RATINGS)[number];

/** The kinds of audio file a music block may hold: ones browsers play, and nothing else. The public
 *  media route (services/token-server, publicWeb.ts) serves sound from the same list. */
export const MUSIC_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
] as const;
export type MusicAudioType = (typeof MUSIC_AUDIO_TYPES)[number];

export type PageColors = { bg: string; text: string; accent: string; link: string; block: string };

export type PageBackground =
  { kind: 'color' } | { kind: 'gradient'; from: string; to: string; angle: number } | { kind: 'image'; url: string; fit: BackgroundFit };

export type PageStyle = {
  colors: PageColors;
  background: PageBackground;
  fonts: { heading: PageFont; body: PageFont };
  /** Block corner radius, px. */
  corners: number;
  border: PageBorder;
  borderColor: string;
  /** How solid the blocks' background is: 0.3 (see-through) to 1. */
  blockOpacity: number;
  columns: 1 | 2;
  effect: PageEffect;
};

export type PageLink = { label: string; url: string; emote?: string; color?: string };

export type PageBlock =
  | { id: string; type: 'text'; title?: string; body: string; formatted?: string }
  | { id: string; type: 'links'; title?: string; items: PageLink[] }
  | { id: string; type: 'image'; url: string; caption?: string; link?: string }
  /** Albums of pieces, each with a caption and tags. With `ratings` on, a piece can be rated Mature.
   *  This is the one gallery block: the older flat gallery (`images`) reads as a single album, and
   *  the older `art` block reads as a gallery with ratings on. */
  | { id: string; type: 'gallery'; title?: string; albums: ArtAlbum[]; ratings: boolean }
  | { id: string; type: 'song'; title?: string; url: string }
  | { id: string; type: 'spaces'; title?: string; spaces: PageSpace[] }
  | { id: string; type: 'divider'; style: DividerStyle; emote?: string }
  /** The owner's Top 8: people who follow them back (checked again when the page is drawn). */
  | { id: string; type: 'friends'; title?: string; users: string[] }
  /** Visitors' messages, kept in the profile room (matrix/guestbook.ts). The owner's rules are here. */
  | { id: string; type: 'guestbook'; title?: string; who: GuestbookWho; slowmode: number; blockedWords: string[] }
  /** Commission status, price sheet and queue, drawn from their own state events (matrix/commissions.ts). */
  | { id: string; type: 'commissions'; title?: string }
  /** Audio the owner uploaded, played by the page's own player. Nothing loads until play. */
  | { id: string; type: 'music'; title?: string; tracks: MusicTrack[] };

/** One uploaded track: an mxc:// file of an allowed audio type, with a one-line title and artist.
 *  `duration` (seconds) and `size` (bytes) are what the uploader measured, for the track list only. */
export type MusicTrack = { url: string; mimetype: MusicAudioType; title: string; artist?: string; duration?: number; size?: number };

export type ArtPiece = { url: string; title?: string; description?: string; tags: string[]; rating: ArtRating };
export type ArtAlbum = { id: string; title: string; description?: string; pieces: ArtPiece[] };

/** A Space shown on a page, as it was when the owner added it (name and avatar can go stale). */
export type PageSpace = { roomId: string; name: string; avatarUrl?: string; via?: string[] };

export type PageBlockType = PageBlock['type'];

export type ProfilePage = { version: number; style: PageStyle; blocks: PageBlock[] };

export const LIMITS = {
  blocks: 40,
  /** Background and image blocks together, so a page stays light to load. */
  images: 20,
  links: 12,
  spaces: 8,
  /** The Top 8. */
  friends: 8,
  guestbookWords: 20,
  guestbookWord: 40,
  /** Longest slowmode a guestbook may ask for, seconds. */
  guestbookSlowmode: 3600,
  albums: 12,
  albumPieces: 24,
  /** Pieces across a page's gallery blocks. They load only when their album is opened, so they
   *  don't count toward `images`. */
  galleryPieces: 60,
  /** Tracks across a page's music blocks. They load only when played, so they don't count toward `images`. */
  tracks: 20,
  trackTitle: 100,
  /** Longest track duration the list shows, seconds (6 hours); a longer claim is dropped, not the track. */
  trackDuration: 6 * 60 * 60,
  tags: 6,
  tag: 24,
  title: 60,
  label: 40,
  caption: 200,
  body: 2000,
  formatted: 16000,
  url: 500,
  spaceName: 80,
  corners: 32,
  minBlockOpacity: 0.3,
} as const;

/** Nightfur's colours, the app's own default look. */
export const DEFAULT_PAGE_STYLE: PageStyle = {
  colors: { bg: '#0d0a13', text: '#f4effa', accent: '#ffb547', link: '#ffcb7a', block: '#1a1524' },
  background: { kind: 'color' },
  fonts: { heading: 'display', body: 'figtree' },
  corners: 12,
  border: 'solid',
  borderColor: '#2b2439',
  blockOpacity: 0.9,
  columns: 1,
  effect: 'none',
};

export function emptyProfilePage(): ProfilePage {
  return { version: PROFILE_PAGE_VERSION, style: structuredClone(DEFAULT_PAGE_STYLE), blocks: [] };
}

// --- Checks for single values -------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-f]{6}$/;
/** `mxc://server/media-id`: the server part as the spec's server names allow, the ID as media IDs do. */
const MXC_URL = /^mxc:\/\/[A-Za-z0-9.\-:[\]]{1,255}\/[A-Za-z0-9_-]{1,255}$/;
const BLOCK_ID = /^[A-Za-z0-9_-]{1,16}$/;
// Room version 12 room IDs have no server part (`!<hash>`); older ones do (`!opaque:server`).
const ROOM_ID = /^![A-Za-z0-9._~=+/-]{1,255}(:[A-Za-z0-9.\-:[\]]{1,255})?$/;
const USER_ID = /^@[a-z0-9._=\-/+]{1,200}:[A-Za-z0-9.\-:[\]]{1,200}$/;
const SERVER_NAME = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function readColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return HEX_COLOR.test(lower) ? lower : undefined;
}

export function readMxc(value: unknown): string | undefined {
  return typeof value === 'string' && MXC_URL.test(value) ? value : undefined;
}

/** An `https://` link with no user name or password in it, normalised, or undefined. */
export function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > LIMITS.url) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined;
  return url.href;
}

/** A single line of plain text, trimmed and cut to `max` characters; empty is undefined. */
export function readLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters (newlines included) out: these are labels and titles, one line each.
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return line ? [...line].slice(0, max).join('') : undefined;
}

function readText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? [...text].slice(0, max).join('') : undefined;
}

function readChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}

function readNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// --- Style ------------------------------------------------------------------------------------

function readBackground(raw: unknown): PageBackground {
  if (!isRecord(raw)) return { kind: 'color' };
  if (raw.kind === 'gradient') {
    const from = readColor(raw.from);
    const to = readColor(raw.to);
    if (from && to) return { kind: 'gradient', from, to, angle: Math.round(readNumber(raw.angle, 0, 359, 180)) };
  }
  if (raw.kind === 'image') {
    const url = readMxc(raw.url);
    if (url) return { kind: 'image', url, fit: readChoice(raw.fit, BACKGROUND_FITS, 'cover') };
  }
  return { kind: 'color' };
}

export function readPageStyle(raw: unknown): PageStyle {
  const style = isRecord(raw) ? raw : {};
  const colors = isRecord(style.colors) ? style.colors : {};
  const fonts = isRecord(style.fonts) ? style.fonts : {};
  const fallback = DEFAULT_PAGE_STYLE;
  return {
    colors: {
      bg: readColor(colors.bg) ?? fallback.colors.bg,
      text: readColor(colors.text) ?? fallback.colors.text,
      accent: readColor(colors.accent) ?? fallback.colors.accent,
      link: readColor(colors.link) ?? fallback.colors.link,
      block: readColor(colors.block) ?? fallback.colors.block,
    },
    background: readBackground(style.background),
    fonts: {
      heading: readChoice(fonts.heading, PAGE_FONTS, fallback.fonts.heading),
      body: readChoice(fonts.body, PAGE_FONTS, fallback.fonts.body),
    },
    corners: Math.round(readNumber(style.corners, 0, LIMITS.corners, fallback.corners)),
    border: readChoice(style.border, PAGE_BORDERS, fallback.border),
    borderColor: readColor(style.borderColor) ?? fallback.borderColor,
    blockOpacity: Math.round(readNumber(style.blockOpacity, LIMITS.minBlockOpacity, 1, fallback.blockOpacity) * 100) / 100,
    columns: style.columns === 2 ? 2 : 1,
    effect: readChoice(style.effect, PAGE_EFFECTS, fallback.effect),
  };
}

// --- Blocks -----------------------------------------------------------------------------------

function readLink(raw: unknown): PageLink | undefined {
  if (!isRecord(raw)) return undefined;
  const url = readHttpsUrl(raw.url);
  const label = readLine(raw.label, LIMITS.label);
  if (!url || !label) return undefined;
  const emote = readMxc(raw.emote);
  const color = readColor(raw.color);
  return { label, url, ...(emote && { emote }), ...(color && { color }) };
}

function readSpace(raw: unknown): PageSpace | undefined {
  if (!isRecord(raw) || typeof raw.roomId !== 'string' || !ROOM_ID.test(raw.roomId)) return undefined;
  const name = readLine(raw.name, LIMITS.spaceName);
  if (!name) return undefined;
  const avatarUrl = readMxc(raw.avatarUrl);
  const via = Array.isArray(raw.via)
    ? raw.via.filter((server): server is string => typeof server === 'string' && SERVER_NAME.test(server)).slice(0, 3)
    : [];
  return { roomId: raw.roomId, name, ...(avatarUrl && { avatarUrl }), ...(via.length > 0 && { via }) };
}

/** A tag: lower case, no leading #, one word's worth of characters. */
function readTag(value: unknown): string | undefined {
  const line = readLine(value, LIMITS.tag)?.replace(/^#+/, '').trim().toLowerCase();
  return line || undefined;
}

function readPiece(raw: unknown): ArtPiece | undefined {
  if (!isRecord(raw)) return undefined;
  const url = readMxc(raw.url);
  if (!url) return undefined;
  const title = readLine(raw.title, LIMITS.title);
  const description = readLine(raw.description, LIMITS.caption);
  const tags = [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map(readTag).filter((tag): tag is string => !!tag))].slice(0, LIMITS.tags);
  return { url, ...(title && { title }), ...(description && { description }), tags, rating: readChoice(raw.rating, ART_RATINGS, 'general') };
}

function readAlbum(raw: unknown, index: number): ArtAlbum | undefined {
  if (!isRecord(raw)) return undefined;
  const title = readLine(raw.title, LIMITS.title);
  const pieces = (Array.isArray(raw.pieces) ? raw.pieces : []).map(readPiece).filter((piece): piece is ArtPiece => !!piece).slice(0, LIMITS.albumPieces);
  if (!title || pieces.length === 0) return undefined;
  const description = readLine(raw.description, LIMITS.caption);
  const id = typeof raw.id === 'string' && BLOCK_ID.test(raw.id) ? raw.id : `a${index}`;
  return { id, title, ...(description && { description }), pieces };
}

/** A gallery block's albums, from `albums` or, in an older gallery, from its flat `images` (one
 *  album, the captions becoming descriptions). Without `ratings` every piece is General. */
function readAlbums(raw: Record<string, unknown>, ratings: boolean): ArtAlbum[] {
  let albums: ArtAlbum[];
  if (Array.isArray(raw.albums)) {
    albums = raw.albums.map(readAlbum).filter((album): album is ArtAlbum => !!album);
  } else {
    const pieces = (Array.isArray(raw.images) ? raw.images : [])
      .map((image): ArtPiece | undefined => {
        if (!isRecord(image)) return undefined;
        const url = readMxc(image.url);
        const description = readLine(image.caption, LIMITS.caption);
        return url ? { url, ...(description && { description }), tags: [], rating: 'general' } : undefined;
      })
      .filter((piece): piece is ArtPiece => !!piece)
      .slice(0, LIMITS.albumPieces);
    albums = pieces.length > 0 ? [{ id: 'a0', title: readLine(raw.title, LIMITS.title) ?? 'Photos', pieces }] : [];
  }
  const seen = new Set<string>();
  return albums
    .map((album) => {
      let id = album.id;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      return { ...album, id, ...(!ratings && { pieces: album.pieces.map((piece): ArtPiece => ({ ...piece, rating: 'general' })) }) };
    })
    .slice(0, LIMITS.albums);
}

/** An audio type from the allowlist, lower-cased and without parameters (`audio/ogg; codecs=opus`). */
export function readAudioType(value: unknown): MusicAudioType | undefined {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  const type = value.split(';')[0].trim().toLowerCase();
  return (MUSIC_AUDIO_TYPES as readonly string[]).includes(type) ? (type as MusicAudioType) : undefined;
}

function readTrack(raw: unknown): MusicTrack | undefined {
  if (!isRecord(raw)) return undefined;
  const url = readMxc(raw.url);
  const mimetype = readAudioType(raw.mimetype);
  const title = readLine(raw.title, LIMITS.trackTitle);
  if (!url || !mimetype || !title) return undefined;
  const artist = readLine(raw.artist, LIMITS.trackTitle);
  const duration =
    typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0 && raw.duration <= LIMITS.trackDuration
      ? Math.round(raw.duration)
      : undefined;
  const size = typeof raw.size === 'number' && Number.isSafeInteger(raw.size) && raw.size > 0 ? raw.size : undefined;
  return { url, mimetype, title, ...(artist && { artist }), ...(duration && { duration }), ...(size && { size }) };
}

function withTitle(raw: Record<string, unknown>): { title?: string } {
  const title = readLine(raw.title, LIMITS.title);
  return title ? { title } : {};
}

/** One block, or undefined if it isn't one the renderer knows how to draw. */
function readBlock(raw: unknown, id: string): PageBlock | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.type) {
    case 'text': {
      const body = readText(raw.body, LIMITS.body);
      if (!body) return undefined;
      const formatted = typeof raw.formatted === 'string' && raw.formatted.length <= LIMITS.formatted ? raw.formatted : undefined;
      return { id, type: 'text', ...withTitle(raw), body, ...(formatted && { formatted }) };
    }
    case 'links': {
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .map(readLink)
        .filter((item): item is PageLink => !!item)
        .slice(0, LIMITS.links);
      return items.length > 0 ? { id, type: 'links', ...withTitle(raw), items } : undefined;
    }
    case 'image': {
      const url = readMxc(raw.url);
      if (!url) return undefined;
      const caption = readLine(raw.caption, LIMITS.caption);
      const link = readHttpsUrl(raw.link);
      return { id, type: 'image', url, ...(caption && { caption }), ...(link && { link }) };
    }
    case 'gallery':
    case 'art': {
      // `art` is what a gallery with ratings was called before the two blocks became one.
      const ratings = raw.type === 'art' || raw.ratings === true;
      const albums = readAlbums(raw, ratings);
      return albums.length > 0 ? { id, type: 'gallery', ...withTitle(raw), albums, ratings } : undefined;
    }
    case 'song': {
      const url = readHttpsUrl(raw.url);
      return url ? { id, type: 'song', ...withTitle(raw), url } : undefined;
    }
    case 'spaces': {
      const spaces = (Array.isArray(raw.spaces) ? raw.spaces : [])
        .map(readSpace)
        .filter((space): space is PageSpace => !!space)
        .slice(0, LIMITS.spaces);
      return spaces.length > 0 ? { id, type: 'spaces', ...withTitle(raw), spaces } : undefined;
    }
    case 'divider': {
      const emote = readMxc(raw.emote);
      const style = readChoice(raw.style, DIVIDER_STYLES, 'line');
      if (style === 'emote') return emote ? { id, type: 'divider', style, emote } : { id, type: 'divider', style: 'line' };
      return { id, type: 'divider', style };
    }
    case 'friends': {
      const users = [...new Set((Array.isArray(raw.users) ? raw.users : []).filter((user): user is string => typeof user === 'string' && user.length <= 255 && USER_ID.test(user)))].slice(0, LIMITS.friends);
      return users.length > 0 ? { id, type: 'friends', ...withTitle(raw), users } : undefined;
    }
    case 'guestbook': {
      const blockedWords = [
        ...new Set((Array.isArray(raw.blockedWords) ? raw.blockedWords : []).map((word) => readLine(word, LIMITS.guestbookWord)).filter((word): word is string => !!word)),
      ].slice(0, LIMITS.guestbookWords);
      return {
        id,
        type: 'guestbook',
        ...withTitle(raw),
        who: readChoice(raw.who, GUESTBOOK_WHO, 'everyone'),
        slowmode: Math.round(readNumber(raw.slowmode, 0, LIMITS.guestbookSlowmode, 0)),
        blockedWords,
      };
    }
    case 'commissions':
      return { id, type: 'commissions', ...withTitle(raw) };
    case 'music': {
      const tracks = (Array.isArray(raw.tracks) ? raw.tracks.slice(0, LIMITS.tracks * 4) : [])
        .map(readTrack)
        .filter((track): track is MusicTrack => !!track)
        .slice(0, LIMITS.tracks);
      return tracks.length > 0 ? { id, type: 'music', ...withTitle(raw), tracks } : undefined;
    }
    default:
      return undefined;
  }
}

type GalleryBlock = Extract<PageBlock, { type: 'gallery' }>;

function galleryPieceCount(block: GalleryBlock): number {
  return block.albums.reduce((count, album) => count + album.pieces.length, 0);
}

/** A gallery block cut down to `room` pieces, dropping albums that end up empty. */
function limitGalleryPieces(block: GalleryBlock, room: number): GalleryBlock | undefined {
  let left = room;
  const albums: ArtAlbum[] = [];
  for (const album of block.albums) {
    if (left < 1) break;
    const pieces = album.pieces.slice(0, left);
    left -= pieces.length;
    albums.push({ ...album, pieces });
  }
  return albums.length > 0 ? { ...block, albums } : undefined;
}

function blockImageCount(block: PageBlock): number {
  return block.type === 'image' ? 1 : 0;
}

/**
 * The blocks a page may show, in order: known types only, unique IDs, at most `LIMITS.blocks`,
 * and images cut off once the page has `LIMITS.images` of them (the background counts as one).
 */
function readBlocks(raw: unknown, backgroundImages: number): PageBlock[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const blocks: PageBlock[] = [];
  let images = backgroundImages;
  let galleryPieces = 0;
  let tracks = 0;
  for (const [index, item] of raw.entries()) {
    if (blocks.length >= LIMITS.blocks) break;
    const rawId = isRecord(item) ? item.id : undefined;
    let id = typeof rawId === 'string' && BLOCK_ID.test(rawId) && !seen.has(rawId) ? rawId : `b${index}`;
    while (seen.has(id)) id = `${id}_`;
    let block = readBlock(item, id);
    if (!block) continue;
    const room = LIMITS.images - images;
    if (block.type === 'image' && room < 1) continue;
    if (block.type === 'gallery') {
      const limited = limitGalleryPieces(block, LIMITS.galleryPieces - galleryPieces);
      if (!limited) continue;
      block = limited;
      galleryPieces += galleryPieceCount(block);
    }
    if (block.type === 'music') {
      if (tracks >= LIMITS.tracks) continue;
      block = { ...block, tracks: block.tracks.slice(0, LIMITS.tracks - tracks) };
      tracks += block.tracks.length;
    }
    images += blockImageCount(block);
    seen.add(id);
    blocks.push(block);
  }
  return blocks;
}

/** A page from raw event content, or undefined if there's no page there. */
export function parseProfilePage(raw: unknown): ProfilePage | undefined {
  if (!isRecord(raw) || typeof raw.version !== 'number' || raw.version < 1) return undefined;
  const style = readPageStyle(raw.style);
  return {
    version: PROFILE_PAGE_VERSION,
    style,
    blocks: readBlocks(raw.blocks, style.background.kind === 'image' ? 1 : 0),
  };
}

// --- Colour contrast, for the builder's readability warning ---------------------------------

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two `#rrggbb` colours: 1 (none) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA for body text. */
export const READABLE_CONTRAST = 4.5;

/** Black or white, whichever reads better on `background`: the builder's suggested fix. */
export function readableTextOn(background: string): string {
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#111111' : '#ffffff';
}

/** A fresh block ID that isn't on the page yet. */
export function newBlockId(blocks: PageBlock[]): string {
  const taken = new Set(blocks.map((block) => block.id));
  for (;;) {
    const id = `b${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

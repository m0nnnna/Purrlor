/**
 * The public web: what this deployment shows people who aren't signed in. docs/public-web.md has
 * the design; the rules, all enforced here rather than trusted to a client:
 *
 * - **Global posts are public.** A post in someone's profile room (room type
 *   `xyz.nekous.profile`) is shown, with only its author's avatar and username. A Space's posts
 *   are never read at all: this service lists profile rooms and nothing else, so whether a post is
 *   public depends on where it lives, not on a flag a client could get wrong.
 * - **A repost or quote of a Space post** shows that something was shared, never what.
 * - **Likes and comments** are counts. Who liked and what commenters said stays behind sign-in.
 * - **A profile page** is public only if its owner opted in (`xyz.nekous.public_web` with
 *   `enabled: true` in their profile room). Otherwise it answers exactly as for a user who doesn't
 *   exist, so a signed-out visitor learns nothing from asking.
 * - **Only this homeserver's people**, and never anyone an admin has hidden.
 * - **Media** is served only while a public post or page names it, and never once an admin has
 *   blocked it (MediaIndex, mayServeMedia).
 *
 * This file is the pure part (unit-tested in publicWeb.test.ts); publicWebRoutes.ts does the I/O.
 */

export const PROFILE_ROOM_TYPE = 'xyz.nekous.profile';
export const POST_EVENT = 'xyz.nekous.post';
export const COMMENT_EVENT = 'xyz.nekous.comment';
export const FEED_MARKER_EVENT = 'xyz.nekous.feed';
export const PUBLIC_WEB_EVENT = 'xyz.nekous.public_web';
export const PROFILE_PAGE_EVENT = 'xyz.nekous.profile_page';
const LIKE_KEY = '❤️';

const ATTACHMENTS_KEY = 'xyz.nekous.attachments';
const REPOST_KEY = 'xyz.nekous.repost_of';
const WARNING_KEY = 'xyz.nekous.content_warning';
const SENSITIVE_KEY = 'xyz.nekous.sensitive';

/** Same strictness as the web client's page parser: media IDs are `[A-Za-z0-9_-]` by the spec. */
const MXC_URL = /^mxc:\/\/([A-Za-z0-9.\-:[\]]{1,255})\/([A-Za-z0-9_-]{1,255})$/;
// The spec's localpart characters, less `/`: an address like /@a/b would read as a path, so an
// account with one in its name just has no public page.
const USER_ID = /^@([a-z0-9._=+-]{1,255}):([A-Za-z0-9.\-:[\]]{1,255})$/;
const LOCALPART = /^[a-z0-9._=+-]{1,255}$/;

export type RawEvent = {
  type: string;
  event_id?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isMxc(value: unknown): value is string {
  return typeof value === 'string' && MXC_URL.test(value);
}

/** `mxc://server/id` → its two parts, or undefined. */
export function splitMxc(value: string): { server: string; mediaId: string } | undefined {
  const match = MXC_URL.exec(value);
  return match ? { server: match[1], mediaId: match[2] } : undefined;
}

/**
 * A user ID on this homeserver from what a visitor typed: `@nibbles`, `nibbles`, or the full
 * `@nibbles:server`. Anything for another server, or not a valid ID, is undefined.
 */
export function localUserId(input: string, serverName: string): string | undefined {
  const raw = input.trim();
  const full = USER_ID.exec(raw);
  if (full) return full[2] === serverName ? raw : undefined;
  const localpart = raw.replace(/^@/, '').toLowerCase();
  return LOCALPART.test(localpart) ? `@${localpart}:${serverName}` : undefined;
}

export function serverNameOf(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

/**
 * Who a profile room belongs to, from its state: the feed marker's owner, cross-checked against
 * the room's creator so a hand-edited marker can't claim someone else's name (the web client's
 * readProfileOwner does the same).
 */
export function readProfileOwner(state: RawEvent[]): string | undefined {
  const create = state.find((event) => event.type === 'm.room.create' && event.state_key === '');
  if (create?.content?.type !== PROFILE_ROOM_TYPE) return undefined;
  const creator = (create.content.creator as string | undefined) ?? create.sender;
  const marker = state.find((event) => event.type === FEED_MARKER_EVENT && event.state_key === '');
  const owner = marker?.content?.owner;
  if (typeof owner !== 'string' || !owner) return undefined;
  return creator && creator !== owner ? undefined : owner;
}

/** Whether the owner opted in to showing their page to people who aren't signed in. */
export function readPublicWeb(state: RawEvent[]): boolean {
  const event = state.find((e) => e.type === PUBLIC_WEB_EVENT && e.state_key === '');
  return event?.content?.enabled === true;
}

/** The owner's published page, as stored. The web client checks it again before drawing it. */
export function readPageContent(state: RawEvent[]): Record<string, unknown> | undefined {
  const content = state.find((e) => e.type === PROFILE_PAGE_EVENT && e.state_key === '')?.content;
  return isRecord(content) && typeof content.version === 'number' ? content : undefined;
}

export const FOLLOW_EVENT = 'xyz.nekous.follow';

/**
 * Who a profile room's owner follows: their `xyz.nekous.follow` state, one event per person. The
 * state key is the followed user's ID without its `@` (homeservers refuse anyone else's `@…` key);
 * the full ID is read too. The web client's readProfileFollows reads them the same way.
 */
export function readFollows(state: RawEvent[], owner: string): Set<string> {
  const follows = new Set<string>();
  for (const event of state) {
    if (event.type !== FOLLOW_EVENT || event.sender !== owner || !event.state_key || event.content?.following !== true) continue;
    const userId = event.state_key.startsWith('@') ? event.state_key : `@${event.state_key}`;
    if (USER_ID.test(userId)) follows.add(userId);
  }
  return follows;
}

/**
 * A stored page as signed-out visitors get it. The Top 8 keeps only the friends `friendShown`
 * allows (their own page public, and they follow the owner back), so the answer never carries
 * the user ID of someone who hasn't chosen to be public, or who never chose to be this person's
 * friend. Mature art pieces are left out: they're only for people who said they're over 18, and
 * nobody signed out has. Everything else is passed on as stored; the client parses it.
 */
export function publicPageContent(content: Record<string, unknown>, friendShown: (userId: string) => boolean): Record<string, unknown> {
  if (!Array.isArray(content.blocks)) return content;
  return {
    ...content,
    blocks: content.blocks.map((block) => {
      if (!isRecord(block)) return block;
      if (block.type === 'friends') {
        const users = Array.isArray(block.users) ? block.users.filter((user): user is string => typeof user === 'string' && friendShown(user)) : [];
        return { ...block, users };
      }
      if (block.type === 'art' && Array.isArray(block.albums)) {
        const albums = block.albums.map((album) =>
          isRecord(album) && Array.isArray(album.pieces) ? { ...album, pieces: album.pieces.filter((piece) => !isRecord(piece) || piece.rating !== 'mature') } : album
        );
        return { ...block, albums };
      }
      return block;
    }),
  };
}

/** Every mxc:// URL anywhere in a value, for the media allowlist. */
export function collectMxc(value: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8) return into;
  if (isMxc(value)) into.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectMxc(item, into, depth + 1));
  else if (isRecord(value)) Object.values(value).forEach((item) => collectMxc(item, into, depth + 1));
  return into;
}

// --- Posts --------------------------------------------------------------------------------------

export type PublicAttachment = { kind: 'image' | 'video'; url: string; mimetype: string; w?: number; h?: number };
export type PublicEmote = { shortcode: string; url: string };

export type PublicRepost =
  | { kind: 'global'; author: string; ts: number; body: string; emotes?: PublicEmote[]; attachments?: PublicAttachment[]; warning?: string; sensitive?: boolean }
  /** A post from a Space: shown only as "something was shared". */
  | { kind: 'hidden' };

export type PublicPost = {
  eventId: string;
  author: string;
  ts: number;
  body: string;
  emotes?: PublicEmote[];
  attachments?: PublicAttachment[];
  warning?: string;
  sensitive?: boolean;
  repost?: PublicRepost;
  edited?: boolean;
  likes: number;
  comments: number;
};

function readAttachments(raw: unknown): PublicAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .flatMap((item): PublicAttachment[] => {
      // Encrypted media (`file`) never appears in a public post, and couldn't be served if it did.
      if (!isMxc(item.url) || (item.kind !== 'image' && item.kind !== 'video')) return [];
      const info = isRecord(item.info) ? item.info : {};
      const mimetype = typeof info.mimetype === 'string' ? info.mimetype : '';
      if (!mimetype.startsWith(`${item.kind}/`)) return [];
      return [
        {
          kind: item.kind,
          url: item.url,
          mimetype,
          ...(typeof info.w === 'number' && { w: info.w }),
          ...(typeof info.h === 'number' && { h: info.h }),
        },
      ];
    })
    .slice(0, 4);
}

/**
 * The custom emotes a formatted body uses, so a signed-out reader sees them. Only emotes: the
 * formatted body itself isn't passed on, because its mention links carry Matrix IDs of people
 * who may not have chosen to be public.
 */
export function readEmotes(formattedBody: unknown): PublicEmote[] {
  if (typeof formattedBody !== 'string') return [];
  const emotes = new Map<string, string>();
  for (const tag of formattedBody.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\bdata-mx-emoticon\b/i.test(tag)) continue;
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
    const name = (/\balt="([^"]*)"/i.exec(tag) ?? /\btitle="([^"]*)"/i.exec(tag))?.[1];
    const shortcode = name?.replace(/^:|:$/g, '');
    if (src && isMxc(src) && shortcode && /^[\w+-]{1,100}$/.test(shortcode)) emotes.set(shortcode, src);
  }
  return [...emotes].map(([shortcode, url]) => ({ shortcode, url }));
}

function readText(value: unknown, max = 5000): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function readWarning(content: Record<string, unknown>): { warning?: string; sensitive?: boolean } {
  const warning = readText(content[WARNING_KEY] ?? content.warning, 200).trim();
  const sensitive = content[SENSITIVE_KEY] === true || content.sensitive === true;
  return { ...(warning && { warning }), ...(sensitive && { sensitive }) };
}

function readRepost(raw: unknown): PublicRepost | undefined {
  if (!isRecord(raw) || !isRecord(raw.origin) || typeof raw.sender !== 'string') return undefined;
  if (raw.origin.kind !== 'global') return { kind: 'hidden' };
  const body = readText(raw.body);
  const attachments = readAttachments(raw.attachments);
  if (!body && attachments.length === 0) return undefined;
  return {
    kind: 'global',
    author: raw.sender,
    ts: typeof raw.ts === 'number' ? raw.ts : 0,
    body,
    ...(attachments.length > 0 && { attachments }),
    ...readWarning(raw),
  };
}

/** A post's public form from its (latest) content, or undefined if there's nothing to show. */
export function readPublicPostContent(content: Record<string, unknown>): Omit<PublicPost, 'eventId' | 'author' | 'ts' | 'likes' | 'comments'> | undefined {
  const body = readText(content.body);
  const attachments = readAttachments(content[ATTACHMENTS_KEY]);
  const repost = readRepost(content[REPOST_KEY]);
  if (!body && attachments.length === 0 && !repost) return undefined;
  const emotes = readEmotes(content.formatted_body);
  return {
    body,
    ...(emotes.length > 0 && { emotes }),
    ...(attachments.length > 0 && { attachments }),
    ...readWarning(content),
    ...(repost && { repost }),
  };
}

function relationOf(event: RawEvent): { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined {
  const relation = event.content?.['m.relates_to'];
  return isRecord(relation) ? relation : undefined;
}

/**
 * The owner's Global posts in one profile room, newest first, from a page of its timeline: edits
 * applied (only the author's own, newest wins), redacted posts gone, and likes and comments
 * counted from the same events.
 */
export function publicPostsFromTimeline(events: RawEvent[], owner: string): PublicPost[] {
  const edits = new Map<string, RawEvent>();
  const likes = new Map<string, Set<string>>();
  const comments = new Map<string, number>();
  for (const event of events) {
    const relation = relationOf(event);
    const target = typeof relation?.event_id === 'string' ? relation.event_id : undefined;
    if (!target) continue;
    if (event.type === POST_EVENT && relation?.rel_type === 'm.replace' && event.sender === owner) {
      const best = edits.get(target);
      if (!best || (event.origin_server_ts ?? 0) > (best.origin_server_ts ?? 0)) edits.set(target, event);
    } else if (event.type === 'm.reaction' && relation?.rel_type === 'm.annotation' && relation.key === LIKE_KEY && event.sender) {
      // One like per person, whatever the timeline holds.
      likes.set(target, (likes.get(target) ?? new Set()).add(event.sender));
    } else if (event.type === COMMENT_EVENT && relation?.rel_type === 'm.reference') {
      comments.set(target, (comments.get(target) ?? 0) + 1);
    }
  }

  const posts: PublicPost[] = [];
  for (const event of events) {
    if (event.type !== POST_EVENT || event.sender !== owner || !event.event_id || relationOf(event)?.rel_type === 'm.replace') continue;
    if (event.unsigned?.redacted_because) continue;
    const edit = edits.get(event.event_id);
    const newContent = edit?.content?.['m.new_content'];
    const content = isRecord(newContent) ? newContent : (event.content ?? {});
    const post = readPublicPostContent(content);
    if (!post) continue;
    posts.push({
      eventId: event.event_id,
      author: owner,
      ts: event.origin_server_ts ?? 0,
      ...post,
      ...(edit && { edited: true }),
      likes: likes.get(event.event_id)?.size ?? 0,
      comments: comments.get(event.event_id) ?? 0,
    });
  }
  return posts.sort((a, b) => b.ts - a.ts);
}

/** Newest first, then a page of `limit` older than `before` (a timestamp cursor). */
export function pageOfPosts(posts: PublicPost[], before: number | undefined, limit: number): { posts: PublicPost[]; next?: number } {
  const sorted = [...posts].sort((a, b) => b.ts - a.ts || (a.eventId < b.eventId ? 1 : -1));
  const older = before === undefined ? sorted : sorted.filter((post) => post.ts < before);
  const page = older.slice(0, limit);
  return { posts: page, ...(older.length > limit && { next: page[page.length - 1].ts }) };
}

// --- Which media may be served ------------------------------------------------------------------

/**
 * Sound a page's music block may hold: the web client's `MUSIC_AUDIO_TYPES`
 * (apps/web/src/matrix/profilePage.ts), which this list must match.
 */
export const AUDIO_TYPES: readonly string[] = [
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
];

function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** Kinds of file the media endpoint passes on: pictures, video and the allowed sound, nothing a browser runs. */
export function isServableMediaType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  if (type === 'image/svg+xml') return false;
  if (type.startsWith('audio/')) return AUDIO_TYPES.includes(type);
  return /^(image|video)\/[a-z0-9.+-]+$/.test(type);
}

/** Sound and video: served from a local copy, so a player can seek with range requests. */
export function isSeekableMediaType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return isServableMediaType(type) && (type.startsWith('audio/') || type.startsWith('video/'));
}

/**
 * Where a file the public web may serve came from. `post`: a Global post (public whatever the
 * owner's page switch says). `page`: their profile page (public only while they're opted in).
 * `profile`: their avatar or banner, as shown beside their posts or on their page.
 */
export type MediaSource = { owner: string; kind: 'post' | 'page' | 'profile' };

/**
 * The files named by a stored page, from the fields the page format has and nothing else, so an
 * owner can't get the media route to serve a file by tucking its URL into a field no page draws.
 * Music tracks count only with an allowed sound type.
 */
export function pageMedia(content: Record<string, unknown> | undefined, options: { includeMature?: boolean } = {}): Set<string> {
  const urls = new Set<string>();
  if (!content) return urls;
  const add = (value: unknown) => {
    if (isMxc(value)) urls.add(value);
  };
  const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
  const style = isRecord(content.style) ? content.style : {};
  if (isRecord(style.background) && style.background.kind === 'image') add(style.background.url);
  for (const block of records(content.blocks)) {
    switch (block.type) {
      case 'image':
        add(block.url);
        break;
      case 'gallery':
        records(block.images).forEach((image) => add(image.url));
        break;
      case 'links':
        records(block.items).forEach((item) => add(item.emote));
        break;
      case 'spaces':
        records(block.spaces).forEach((space) => add(space.avatarUrl));
        break;
      case 'divider':
        add(block.emote);
        break;
      case 'art':
        // Mature pieces are for people who said they're over 18, which nobody signed out has.
        records(block.albums).forEach((album) =>
          records(album.pieces).forEach((piece) => {
            if (options.includeMature || piece.rating !== 'mature') add(piece.url);
          })
        );
        break;
      case 'music':
        records(block.tracks).forEach((track) => {
          if (typeof track.mimetype === 'string' && AUDIO_TYPES.includes(mediaType(track.mimetype))) add(track.url);
        });
        break;
    }
  }
  return urls;
}

/**
 * The files the public web may hand out, and whose they are. The snapshot is rebuilt from the
 * profile rooms on every feed refresh, so a file stops being served within a minute of the post
 * being deleted or the owner switching their page off. Avatars and banners, which come from
 * profiles rather than rooms, are added as answers name them and kept for `profileTtlMs`.
 * Anything else, including media from Space posts and DMs on the same homeserver, is refused,
 * so the media endpoint can't be used to fetch arbitrary files by guessing their IDs.
 */
export class MediaIndex {
  private snapshot = new Map<string, MediaSource[]>();
  private profiles = new Map<string, { owner: string; kind: MediaSource['kind']; until: number }>();

  constructor(
    private readonly profileTtlMs = 6 * 60 * 60 * 1000,
    private readonly maxProfiles = 20_000
  ) {}

  setSnapshot(snapshot: Map<string, MediaSource[]>): void {
    this.snapshot = snapshot;
  }

  /** An avatar (`profile`), or a banner, which only a page shows (`page`). */
  allowProfile(urls: Iterable<string>, owner: string, kind: 'profile' | 'page' = 'profile', now = Date.now()): void {
    for (const url of urls) {
      if (!isMxc(url)) continue;
      this.profiles.delete(url);
      this.profiles.set(url, { owner, kind, until: now + this.profileTtlMs });
    }
    while (this.profiles.size > this.maxProfiles) this.profiles.delete(this.profiles.keys().next().value!);
  }

  sources(url: string, now = Date.now()): MediaSource[] {
    const found = [...(this.snapshot.get(url) ?? [])];
    const profile = this.profiles.get(url);
    if (profile && profile.until >= now) found.push({ owner: profile.owner, kind: profile.kind });
    else if (profile) this.profiles.delete(url);
    return found;
  }

  /** Every file the public web serves for one person now: what a takedown of "everything" covers. */
  ownedBy(owner: string, now = Date.now()): string[] {
    const urls = new Set<string>();
    for (const [url, sources] of this.snapshot) if (sources.some((source) => source.owner === owner)) urls.add(url);
    for (const [url, profile] of this.profiles) if (profile.owner === owner && profile.until >= now) urls.add(url);
    return [...urls];
  }
}

/** One profile room's contribution to the media snapshot. */
export function addRoomMedia(
  snapshot: Map<string, MediaSource[]>,
  room: { owner: string; posts: PublicPost[]; state: RawEvent[] }
): void {
  const add = (url: string, kind: MediaSource['kind']) => {
    const sources = snapshot.get(url) ?? [];
    if (!sources.some((source) => source.owner === room.owner && source.kind === kind)) sources.push({ owner: room.owner, kind });
    snapshot.set(url, sources);
  };
  collectMxc(room.posts).forEach((url) => add(url, 'post'));
  if (readPublicWeb(room.state)) pageMedia(readPageContent(room.state)).forEach((url) => add(url, 'page'));
}

/** What the admin has said about who and what may be public (`purrlor pages` and `takedown`). */
export type AdminLists = { hidden: Set<string>; publicOff: Set<string>; blockedMedia: Set<string> };

/**
 * Whether the media route may serve a file now: never a blocked file; otherwise if any of its
 * sources still allows it. A hidden person's files go with them. A page's files (and banner) need
 * the page to be public right now: its owner opted in (`publicPages`, from the latest snapshot)
 * and no admin forcing that switch off.
 */
export function mayServeMedia(url: string, sources: MediaSource[], lists: AdminLists, publicPages: ReadonlySet<string>): boolean {
  if (lists.blockedMedia.has(url)) return false;
  return sources.some(
    (source) =>
      !lists.hidden.has(source.owner) && (source.kind !== 'page' || (publicPages.has(source.owner) && !lists.publicOff.has(source.owner)))
  );
}

/**
 * A `Range` header against a file of `size` bytes: the one range to send, `unsatisfiable` (416),
 * or undefined to send the whole file. Only a single range is honoured; a list of them gets the
 * whole file, which the spec allows.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

// --- Admin hiding -------------------------------------------------------------------------------

/** The hidden-pages file: one user ID per line; blank lines and `#` comments ignored. */
export function parseHiddenList(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => USER_ID.test(line))
  );
}

// --- Link previews ------------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export type LinkCard = { title: string; description: string; url: string; image?: string; themeColor?: string; siteName: string };

/**
 * A tiny HTML page carrying a link's preview tags, for the bots that unfurl links (Discord,
 * Bluesky, iMessage…); nginx sends only those here, and people get the app. Every value is
 * escaped, and the description is cut short.
 */
export function linkCardHtml(card: LinkCard): string {
  const description = card.description.length > 200 ? `${card.description.slice(0, 197)}…` : card.description;
  const meta = (property: string, content: string) => `<meta property="${property}" content="${escapeHtml(content)}">`;
  const tags = [
    meta('og:type', 'profile'),
    meta('og:site_name', card.siteName),
    meta('og:title', card.title),
    meta('og:description', description),
    meta('og:url', card.url),
    ...(card.image ? [meta('og:image', card.image), '<meta name="twitter:card" content="summary">'] : []),
    ...(card.themeColor && /^#[0-9a-f]{6}$/i.test(card.themeColor) ? [`<meta name="theme-color" content="${card.themeColor}">`] : []),
  ];
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(card.title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    ...tags,
    `</head><body><a href="${escapeHtml(card.url)}">${escapeHtml(card.title)}</a></body></html>`,
  ].join('\n');
}

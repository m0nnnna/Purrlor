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
 * - **Media** is served only if a public answer handed it out recently (MediaAllowlist).
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

// --- Media allowlist ----------------------------------------------------------------------------

/**
 * The media this service may hand out: what its public answers referenced in the last `ttlMs`.
 * Anything else, including media from Space posts and DMs on the same homeserver, is refused,
 * so the media endpoint can't be used to fetch arbitrary files by guessing their IDs.
 */
export class MediaAllowlist {
  private entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxEntries = 50_000
  ) {}

  allow(urls: Iterable<string>, now = Date.now()): void {
    for (const url of urls) {
      if (!isMxc(url)) continue;
      this.entries.delete(url);
      this.entries.set(url, now + this.ttlMs);
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  has(url: string, now = Date.now()): boolean {
    const until = this.entries.get(url);
    if (until === undefined) return false;
    if (until < now) {
      this.entries.delete(url);
      return false;
    }
    return true;
  }
}

/** Kinds of file the media endpoint passes on: pictures, video and sound, nothing a browser runs. */
export function isServableMediaType(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') return false;
  return /^(image|video|audio)\/[a-z0-9.+-]+$/.test(type);
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

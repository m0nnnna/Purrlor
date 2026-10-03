import { isDemoMode } from '../demo/demoMode';
import { isRemoteUser } from './homeServer';

/**
 * The public web's answers (services/token-server/src/publicWebRoutes.ts, docs/public-web.md),
 * served under the app's own address at /api/public by the deployment's nginx.
 */
const PUBLIC_API = '/api/public';

/**
 * Whether an admin hid this person's page (`purrlor pages hide`). A hidden page isn't drawn in the
 * app either, except for its owner, who's told. Unknown (no public web on this deployment, or it
 * didn't answer) counts as not hidden: hiding is a deployment's call, and without one there's
 * nothing to honour.
 */
export async function fetchPageHidden(userId: string): Promise<boolean> {
  if (isDemoMode()) return false;
  try {
    const response = await fetch(`${PUBLIC_API}/status/${encodeURIComponent(userId)}`);
    if (!response.ok) return false;
    const body = (await response.json()) as { hidden?: unknown };
    return body.hidden === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Signed-out views: the answers a visitor without an account gets (docs/public-web.md).
// ---------------------------------------------------------------------------------------------

export type PublicEmote = { shortcode: string; url: string };
export type PublicAttachment = { kind: 'image' | 'video' | 'audio' | 'file'; url: string; mimetype?: string; w?: number; h?: number };
export type PublicRepost =
  | { kind: 'hidden' }
  | { kind: 'global'; author: string; ts: number; body?: string; emotes?: PublicEmote[]; attachments?: PublicAttachment[] };

export type PublicPost = {
  eventId: string;
  author: string;
  ts: number;
  body: string;
  emotes?: PublicEmote[];
  attachments?: PublicAttachment[];
  warning?: string;
  sensitive?: boolean;
  edited?: boolean;
  repost?: PublicRepost;
  likes?: number;
  comments?: number;
};

export type PublicAuthor = { userId: string; avatarUrl?: string };
export type PublicPostsAnswer = { posts: PublicPost[]; authors: Record<string, PublicAuthor>; next?: number };

export type PublicPageAnswer = {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  avatarAnimated?: boolean;
  bannerUrl?: string;
  bio?: string;
  /** The stored page, unchecked: put it through `parseProfilePage` before drawing it. */
  page: unknown;
};

/** The service's answer for "no such page, not opted in, hidden, other server": all one. */
export type PublicResult<T> = { status: 'ok'; value: T } | { status: 'not_found' } | { status: 'error' };

async function getPublic<T>(path: string): Promise<PublicResult<T>> {
  try {
    const response = await fetch(`${PUBLIC_API}${path}`);
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) return { status: 'error' };
    return { status: 'ok', value: (await response.json()) as T };
  } catch {
    return { status: 'error' };
  }
}

/** This deployment's own description (`GET /api/public/instance`, docs/federation.md). */
export type InstanceAnswer = { serverName: string; name: string; url: string };

export async function fetchInstance(): Promise<InstanceAnswer | undefined> {
  if (isDemoMode()) return undefined;
  try {
    const response = await fetch(`${PUBLIC_API}/instance`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body.serverName === 'string' && body.serverName
      ? { serverName: body.serverName, name: typeof body.name === 'string' ? body.name : body.serverName, url: typeof body.url === 'string' ? body.url : '' }
      : undefined;
  } catch {
    return undefined;
  }
}

export const fetchPublicPage = (user: string) => getPublic<PublicPageAnswer>(`/pages/${encodeURIComponent(user)}`);

export function fetchPublicFeed(options: { before?: number; author?: string } = {}) {
  const query = new URLSearchParams();
  if (options.before !== undefined) query.set('before', String(options.before));
  if (options.author) query.set('author', options.author);
  const suffix = query.toString();
  return getPublic<PublicPostsAnswer>(`/feed${suffix ? `?${suffix}` : ''}`);
}

/** One Global post. `author` (the link's `/@name`) lets the service find one older than its feed reaches. */
export const fetchPublicPost = (eventId: string, author?: string) =>
  getPublic<PublicPostsAnswer>(`/posts/${encodeURIComponent(eventId)}${author ? `?author=${encodeURIComponent(author)}` : ''}`);

/** `mxc://server/id` as the public media route (a thumbnail when a size is given), or null. */
export function publicMediaUrl(mxcUrl: string, width?: number, height?: number): string | null {
  // The spec's server-name characters only: the result goes into CSS url() for a banner.
  const match = /^mxc:\/\/([A-Za-z0-9.\-:[\]]{1,255})\/([A-Za-z0-9_-]{1,255})$/.exec(mxcUrl);
  if (!match) return null;
  const size = width || height ? `?width=${Math.round(width ?? height ?? 0)}&height=${Math.round(height ?? width ?? 0)}` : '';
  return `${PUBLIC_API}/media/${encodeURIComponent(match[1])}/${match[2]}${size}`;
}

/**
 * Something on a page a link points at: a music album (and a track of it, numbered from 1), a
 * gallery album (and a piece of it, from 1), or a commission type. IDs are the page's own.
 */
export type PageTarget =
  | { kind: 'music'; album: string; track?: number }
  | { kind: 'art'; album: string; piece?: number }
  | { kind: 'commission'; type: string };

/** The address a visitor's browser is on, read as a public route: `/@name` (or a thing on that
 *  page, below), `/@name/post/$id` or `/feed`. */
export type PublicRoute =
  | { kind: 'feed' }
  | { kind: 'page'; user: string; target?: PageTarget }
  /** `roomId`: a Space post's link names its feed room (`?room=`), for members' apps to find it. */
  | { kind: 'post'; user: string; eventId: string; roomId?: string };

const ITEM_ID = /^[A-Za-z0-9_-]{1,16}$/;

function readTarget(kind: string, id: string, number: string | undefined): PageTarget | undefined {
  if (!ITEM_ID.test(id)) return undefined;
  const n = number === undefined ? undefined : Number(number);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 1000)) return undefined;
  if (kind === 'music') return { kind: 'music', album: id, ...(n && { track: n }) };
  if (kind === 'art') return { kind: 'art', album: id, ...(n && { piece: n }) };
  return number === undefined ? { kind: 'commission', type: id } : undefined;
}

export function parsePublicRoute(pathname: string, search = ''): PublicRoute | undefined {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/feed') return { kind: 'feed' };
  try {
    const post = /^\/@([^/]+)\/post\/([^/]+)$/.exec(path);
    if (post) {
      const roomId = new URLSearchParams(search).get('room');
      return {
        kind: 'post',
        user: decodeURIComponent(post[1]),
        eventId: decodeURIComponent(post[2]),
        ...(roomId && /^![^\s/]{1,255}$/.test(roomId) && { roomId }),
      };
    }
    const page = /^\/@([^/]+)$/.exec(path);
    if (page) return { kind: 'page', user: decodeURIComponent(page[1]) };
    const item = /^\/@([^/]+)\/(music|art|commissions)\/([^/]+)(?:\/(\d+))?$/.exec(path);
    const target = item && readTarget(item[2], item[3], item[4]);
    if (item && target) return { kind: 'page', user: decodeURIComponent(item[1]), target };
  } catch {
    return undefined;
  }
  return undefined;
}

/** `/@name` for this server's people, `/@name:server` for a federated instance's (homeServer.ts). */
export function publicPagePath(user: string): string {
  const id = user.startsWith('@') ? user : `@${user}`;
  const name = isRemoteUser(id) ? id.slice(1) : id.slice(1).replace(/:.*$/, '');
  // A colon is fine in a path, and reads better than %3A.
  return `/@${encodeURIComponent(name).replace(/%3A/gi, ':')}`;
}

/** The path of a thing on someone's page, as `parsePublicRoute` reads it. */
export function pageTargetPath(user: string, target: PageTarget): string {
  const page = publicPagePath(user);
  switch (target.kind) {
    case 'music':
      return `${page}/music/${target.album}${target.track ? `/${target.track}` : ''}`;
    case 'art':
      return `${page}/art/${target.album}${target.piece ? `/${target.piece}` : ''}`;
    case 'commission':
      return `${page}/commissions/${target.type}`;
  }
}

/** A full link to someone's page, or a thing on it, on this deployment. */
export function pageLink(user: string, target?: PageTarget): string {
  return `${window.location.origin}${target ? pageTargetPath(user, target) : publicPagePath(user)}`;
}

/**
 * A full link to a post: `/@name/post/<id>`, which anyone can open for a Global post. A Space
 * post's link also names its room (`?room=`): only the Space's members can open it, and anyone
 * else, signed in or out, is told to sign in, with nothing about the post.
 */
export function postLink(author: string, postId: string, spaceRoomId?: string): string {
  const path = `${publicPagePath(author)}/post/${encodeURIComponent(postId)}`;
  return `${window.location.origin}${path}${spaceRoomId ? `?room=${encodeURIComponent(spaceRoomId)}` : ''}`;
}

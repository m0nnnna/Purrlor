import { isDemoMode } from '../demo/demoMode';

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

export const fetchPublicPage = (user: string) => getPublic<PublicPageAnswer>(`/pages/${encodeURIComponent(user)}`);

export function fetchPublicFeed(options: { before?: number; author?: string } = {}) {
  const query = new URLSearchParams();
  if (options.before !== undefined) query.set('before', String(options.before));
  if (options.author) query.set('author', options.author);
  const suffix = query.toString();
  return getPublic<PublicPostsAnswer>(`/feed${suffix ? `?${suffix}` : ''}`);
}

export const fetchPublicPost = (eventId: string) => getPublic<PublicPostsAnswer>(`/posts/${encodeURIComponent(eventId)}`);

/** `mxc://server/id` as the public media route (a thumbnail when a size is given), or null. */
export function publicMediaUrl(mxcUrl: string, width?: number, height?: number): string | null {
  const match = /^mxc:\/\/([^/\s]+)\/([A-Za-z0-9_-]+)$/.exec(mxcUrl);
  if (!match) return null;
  const size = width || height ? `?width=${Math.round(width ?? height ?? 0)}&height=${Math.round(height ?? width ?? 0)}` : '';
  return `${PUBLIC_API}/media/${encodeURIComponent(match[1])}/${match[2]}${size}`;
}

/** The address a visitor's browser is on, read as a public route: `/@name`, `/@name/post/$id` or `/feed`. */
export type PublicRoute =
  | { kind: 'feed' }
  | { kind: 'page'; user: string }
  | { kind: 'post'; user: string; eventId: string };

export function parsePublicRoute(pathname: string): PublicRoute | undefined {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/feed') return { kind: 'feed' };
  const post = /^\/@([^/]+)\/post\/([^/]+)$/.exec(path);
  if (post) {
    try {
      return { kind: 'post', user: decodeURIComponent(post[1]), eventId: decodeURIComponent(post[2]) };
    } catch {
      return undefined;
    }
  }
  const page = /^\/@([^/]+)$/.exec(path);
  if (page) {
    try {
      return { kind: 'page', user: decodeURIComponent(page[1]) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const publicPagePath = (user: string) => `/@${encodeURIComponent(user.replace(/^@/, '').replace(/:.*$/, ''))}`;

import { guardedJson } from './embedFetch.js';
import { plainText } from './embedHtml.js';

/**
 * Site-specific resolvers (docs/embeds.md, "How a link is resolved"), each from the site's own
 * public API. Each returns a draft of the embed: its fields, plus the addresses of pictures and
 * files still to fetch. Anything a site's answer doesn't have is left out, never guessed.
 */

export type EmbedKind = 'card' | 'post' | 'player' | 'image' | 'video' | 'audio';

export type Draft = {
  url: string;
  kind: EmbedKind;
  site?: { name?: string; color?: string };
  title?: string;
  description?: string;
  author?: { name?: string; handle?: string; url?: string };
  player?: { provider: string; id: string };
  published?: number;
  sensitive?: true;
  /** A picture to fetch for `image` (the card's, or the image itself). */
  imageUrl?: string;
  /** A file to fetch for `media` (video, audio). */
  mediaUrl?: string;
  /** The author's avatar to fetch. */
  avatarUrl?: string;
};

export type Provider = {
  name: string;
  /** Whether this provider handles the URL; returns what it needs from it. */
  match: (url: URL) => Record<string, string> | undefined;
  resolve: (url: URL, params: Record<string, string>) => Promise<Draft | undefined>;
  /** Fill in from the page's OpenGraph when the provider's own answer has nothing. */
  fallbackToPage?: (url: URL, params: Record<string, string>) => Partial<Draft>;
};

const str = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const host = (url: URL) => url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');

async function oembed(endpoint: string, url: string): Promise<Record<string, unknown> | undefined> {
  const answer = await guardedJson(`${endpoint}${endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`);
  return isRecord(answer) ? answer : undefined;
}

// --- Players -------------------------------------------------------------------------------------

const youtube: Provider = {
  name: 'youtube',
  match(url) {
    const h = host(url);
    let id: string | null | undefined;
    if (h === 'youtu.be') id = url.pathname.split('/')[1];
    else if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
      id = url.searchParams.get('v') ?? /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(url.pathname)?.[1];
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { id } : undefined;
  },
  async resolve(_url, { id }) {
    const watch = `https://www.youtube.com/watch?v=${id}`;
    const answer = await oembed('https://www.youtube.com/oembed?format=json', watch);
    if (!answer) return undefined;
    return {
      url: '',
      kind: 'player',
      site: { name: 'YouTube', color: '#ff0000' },
      title: str(answer.title, 256),
      author: { name: str(answer.author_name, 128), url: httpsUrl(answer.author_url) },
      player: { provider: 'youtube', id },
      imageUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  },
};

const vimeo: Provider = {
  name: 'vimeo',
  match(url) {
    const id = host(url) === 'vimeo.com' ? /^\/(?:video\/)?(\d{1,12})(?:\/|$)/.exec(url.pathname)?.[1] : undefined;
    return id ? { id } : undefined;
  },
  async resolve(url, { id }) {
    const answer = await oembed('https://vimeo.com/api/oembed.json', url.toString());
    if (!answer) return undefined;
    return {
      url: '',
      kind: 'player',
      site: { name: 'Vimeo', color: '#1ab7ea' },
      title: str(answer.title, 256),
      author: { name: str(answer.author_name, 128), url: httpsUrl(answer.author_url) },
      player: { provider: 'vimeo', id },
      imageUrl: httpsUrl(answer.thumbnail_url),
    };
  },
};

const spotify: Provider = {
  name: 'spotify',
  match(url) {
    const m = host(url) === 'open.spotify.com' ? /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})/.exec(url.pathname) : null;
    return m ? { id: `${m[1]}/${m[2]}` } : undefined;
  },
  async resolve(_url, { id }) {
    const answer = await oembed('https://open.spotify.com/oembed', `https://open.spotify.com/${id}`);
    if (!answer) return undefined;
    return {
      url: '',
      kind: 'player',
      site: { name: 'Spotify', color: '#1db954' },
      title: str(answer.title, 256),
      player: { provider: 'spotify', id },
      imageUrl: httpsUrl(answer.thumbnail_url),
    };
  },
};

const soundcloud: Provider = {
  name: 'soundcloud',
  match(url) {
    const path = url.pathname.replace(/^\/|\/$/g, '').toLowerCase();
    return host(url) === 'soundcloud.com' && /^[a-z0-9_-]+\/(sets\/)?[a-z0-9_-]+$/.test(path) ? { id: path } : undefined;
  },
  async resolve(_url, { id }) {
    const answer = await oembed('https://soundcloud.com/oembed?format=json', `https://soundcloud.com/${id}`);
    if (!answer) return undefined;
    return {
      url: '',
      kind: 'player',
      site: { name: 'SoundCloud', color: '#ff5500' },
      title: str(answer.title, 256),
      author: { name: str(answer.author_name, 128), url: httpsUrl(answer.author_url) },
      player: { provider: 'soundcloud', id },
      imageUrl: httpsUrl(answer.thumbnail_url),
    };
  },
};

const streamable: Provider = {
  name: 'streamable',
  match(url) {
    const id = host(url) === 'streamable.com' ? /^\/(?:e\/)?([a-z0-9]{3,12})$/.exec(url.pathname)?.[1] : undefined;
    return id ? { id } : undefined;
  },
  async resolve(_url, { id }) {
    const answer = await oembed('https://api.streamable.com/oembed.json', `https://streamable.com/${id}`);
    if (!answer) return undefined;
    return {
      url: '',
      kind: 'player',
      site: { name: 'Streamable', color: '#0f90fa' },
      title: str(answer.title, 256),
      player: { provider: 'streamable', id },
      imageUrl: httpsUrl(answer.thumbnail_url),
    };
  },
};

/** Twitch has no keyless API: the player is from the URL, the rest from the page (resolveEmbed). */
const twitch: Provider = {
  name: 'twitch',
  match(url) {
    const h = host(url);
    const clip = h === 'clips.twitch.tv' ? /^\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1] : h === 'twitch.tv' ? /^\/[^/]+\/clip\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] : undefined;
    if (clip) return { provider: 'twitch-clip', id: clip };
    const video = h === 'twitch.tv' ? /^\/videos\/(\d+)/.exec(url.pathname)?.[1] : undefined;
    return video ? { provider: 'twitch-video', id: video } : undefined;
  },
  async resolve() {
    return undefined;
  },
  fallbackToPage: (_url, { provider, id }) => ({ kind: 'player', site: { name: 'Twitch', color: '#9146ff' }, player: { provider, id } }),
};

// --- Posts ---------------------------------------------------------------------------------------

const tiktok: Provider = {
  name: 'tiktok',
  match(url) {
    const h = host(url);
    return h === 'tiktok.com' && /^\/@[^/]+\/video\/\d+/.test(url.pathname) ? {} : h === 'vm.tiktok.com' || h === 'vt.tiktok.com' ? {} : undefined;
  },
  async resolve(url) {
    const answer = await oembed('https://www.tiktok.com/oembed', url.toString());
    if (!answer) return undefined;
    const authorUrl = httpsUrl(answer.author_url);
    return {
      url: '',
      kind: 'post',
      site: { name: 'TikTok', color: '#fe2c55' },
      description: text(answer.title, 1000),
      author: { name: str(answer.author_name, 128), handle: authorUrl ? str(/\/(@[^/?#]+)/.exec(authorUrl)?.[1], 128) : undefined, url: authorUrl },
      imageUrl: httpsUrl(answer.thumbnail_url),
    };
  },
};

/** X's oEmbed answers with a blockquote: its first paragraph is the text, its last link the date. */
export function readTweetHtml(html: string): { text?: string; published?: number } {
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  const links = [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/gi)];
  const date = links.length ? Date.parse(links[links.length - 1][1]) : NaN;
  return { text: paragraph ? plainText(paragraph) : undefined, published: Number.isFinite(date) ? date : undefined };
}

const twitter: Provider = {
  name: 'x',
  match(url) {
    const h = host(url);
    const m = h === 'twitter.com' || h === 'x.com' ? /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/.exec(url.pathname) : null;
    return m ? { user: m[1], id: m[2] } : undefined;
  },
  async resolve(_url, { user, id }) {
    const answer = await oembed('https://publish.twitter.com/oembed?omit_script=1&dnt=true', `https://twitter.com/${user}/status/${id}`);
    if (!answer || typeof answer.html !== 'string') return undefined;
    const { text: body, published } = readTweetHtml(answer.html);
    if (!body) return undefined;
    return {
      url: '',
      kind: 'post',
      site: { name: 'X', color: '#000000' },
      description: body.slice(0, 1000),
      author: { name: str(answer.author_name, 128), handle: `@${user}`, url: httpsUrl(answer.author_url) },
      ...(published && { published }),
    };
  },
  fallbackToPage: () => ({ kind: 'post', site: { name: 'X', color: '#000000' } }),
};

const BLUESKY_SENSITIVE = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);

const bluesky: Provider = {
  name: 'bluesky',
  match(url) {
    const m = host(url) === 'bsky.app' ? /^\/profile\/([^/]+)\/post\/([a-z0-9]+)$/i.exec(url.pathname) : null;
    return m ? { actor: m[1], rkey: m[2] } : undefined;
  },
  async resolve(_url, { actor, rkey }) {
    const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
    const answer = await guardedJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?depth=0&parentHeight=0&uri=${encodeURIComponent(uri)}`);
    const post = isRecord(answer) && isRecord(answer.thread) && isRecord(answer.thread.post) ? answer.thread.post : undefined;
    if (!post || !isRecord(post.author) || !isRecord(post.record)) return undefined;
    const embed = isRecord(post.embed) ? post.embed : undefined;
    const media = embed && isRecord(embed.media) ? embed.media : embed;
    const images = media && Array.isArray(media.images) ? media.images.filter(isRecord) : [];
    const external = media && isRecord(media.external) ? media.external : undefined;
    const labels = Array.isArray(post.labels) ? post.labels.filter(isRecord).map((l) => l.val) : [];
    const created = typeof post.record.createdAt === 'string' ? Date.parse(post.record.createdAt) : NaN;
    const handle = str(post.author.handle, 128);
    return {
      url: '',
      kind: 'post',
      site: { name: 'Bluesky', color: '#1185fe' },
      description: text(post.record.text, 1000),
      author: { name: str(post.author.displayName, 128) ?? handle, handle: handle && `@${handle}`, url: handle ? `https://bsky.app/profile/${handle}` : undefined },
      avatarUrl: httpsUrl(post.author.avatar),
      imageUrl: httpsUrl(images[0]?.fullsize) ?? httpsUrl(images[0]?.thumb) ?? httpsUrl(external?.thumb),
      ...(Number.isFinite(created) && { published: created }),
      ...(labels.some((l) => typeof l === 'string' && BLUESKY_SENSITIVE.has(l)) && { sensitive: true as const }),
    };
  },
};

const mastodon: Provider = {
  name: 'mastodon',
  match(url) {
    const id = /^\/@[A-Za-z0-9_.-]+(?:@[^/]+)?\/(\d{1,20})$/.exec(url.pathname)?.[1] ?? /^\/users\/[A-Za-z0-9_.-]+\/statuses\/(\d{1,20})$/.exec(url.pathname)?.[1];
    return id ? { id } : undefined;
  },
  async resolve(url, { id }) {
    const status = await guardedJson(`${url.origin}/api/v1/statuses/${id}`);
    if (!isRecord(status) || !isRecord(status.account) || typeof status.content !== 'string') return undefined;
    const account = status.account;
    const attachments = Array.isArray(status.media_attachments) ? status.media_attachments.filter(isRecord) : [];
    const picture = attachments.find((a) => a.type === 'image' || a.type === 'gifv' || a.type === 'video');
    const created = typeof status.created_at === 'string' ? Date.parse(status.created_at) : NaN;
    const acct = str(account.acct, 128);
    const spoiler = str(status.spoiler_text, 200);
    return {
      url: '',
      kind: 'post',
      site: { name: url.hostname },
      ...(spoiler && { title: spoiler }),
      description: plainText(status.content).slice(0, 1000) || undefined,
      author: { name: str(account.display_name, 128) ?? acct, handle: acct && `@${acct.includes('@') ? acct : `${acct}@${url.hostname}`}`, url: httpsUrl(account.url) },
      avatarUrl: httpsUrl(account.avatar_static) ?? httpsUrl(account.avatar),
      imageUrl: picture ? (picture.type === 'image' ? httpsUrl(picture.url) : httpsUrl(picture.preview_url)) : undefined,
      ...(Number.isFinite(created) && { published: created }),
      ...((status.sensitive === true || !!spoiler) && { sensitive: true as const }),
    };
  },
};

const reddit: Provider = {
  name: 'reddit',
  match(url) {
    const h = host(url).replace(/^(old|new|np)\./, '');
    const id = h === 'reddit.com' ? /^\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(url.pathname)?.[1] : undefined;
    return id ? { id } : undefined;
  },
  async resolve(_url, { id }) {
    const answer = await guardedJson(`https://www.reddit.com/comments/${id}.json?raw_json=1&limit=1`, 2 * 1024 * 1024);
    const listing = Array.isArray(answer) && isRecord(answer[0]) && isRecord(answer[0].data) ? answer[0].data : undefined;
    const child = listing && Array.isArray(listing.children) && isRecord(listing.children[0]) ? listing.children[0] : undefined;
    const post = child && isRecord(child.data) ? child.data : undefined;
    if (!post || typeof post.title !== 'string') return undefined;
    const preview = isRecord(post.preview) && Array.isArray(post.preview.images) && isRecord(post.preview.images[0]) ? post.preview.images[0] : undefined;
    const source = preview && isRecord(preview.source) ? preview.source : undefined;
    const author = str(post.author, 64);
    return {
      url: '',
      kind: 'post',
      site: { name: str(post.subreddit_name_prefixed, 64) ?? 'Reddit', color: '#ff4500' },
      title: str(post.title, 256),
      description: text(post.selftext, 1000),
      author: { name: author && `u/${author}`, url: author ? `https://www.reddit.com/user/${author}` : undefined },
      imageUrl: httpsUrl(source?.url),
      ...(typeof post.created_utc === 'number' && { published: Math.round(post.created_utc * 1000) }),
      ...(post.over_18 === true && { sensitive: true as const }),
    };
  },
  fallbackToPage: () => ({ kind: 'card', site: { name: 'Reddit', color: '#ff4500' } }),
};

/** Image and GIF hosts whose pages are mostly one picture: the picture itself (resolveEmbed). */
export const MEDIA_PAGE_HOSTS = new Set(['imgur.com', 'giphy.com', 'tenor.com']);

export const PROVIDERS: Provider[] = [youtube, vimeo, spotify, soundcloud, streamable, twitch, tiktok, twitter, bluesky, reddit, mastodon];

export function findProvider(url: URL): { provider: Provider; params: Record<string, string> } | undefined {
  for (const provider of PROVIDERS) {
    const params = provider.match(url);
    if (params) return { provider, params };
  }
  return undefined;
}

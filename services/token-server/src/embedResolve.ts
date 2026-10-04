import { randomBytes } from 'node:crypto';
import { FetchRefused, guardedGet } from './embedFetch.js';
import { decodePage, readPageMeta } from './embedHtml.js';
import { findProvider, MEDIA_PAGE_HOSTS, type Draft, type EmbedKind } from './embedProviders.js';
import { urlProblem } from './embedGuard.js';

/**
 * Resolves a link someone is about to post into an embed (docs/embeds.md): the site's own API
 * when there's a provider for it, else the page's OpenGraph, else the file the link is. Pictures
 * and files come back as short-lived file IDs for the client to fetch and upload itself.
 */

const PAGE_BYTES = 1024 * 1024;
const IMAGE_BYTES = 8 * 1024 * 1024;
const MEDIA_BYTES = 25 * 1024 * 1024;
/** File types handed back. Never anything a browser would run (HTML, SVG): they're served from the app's origin. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-m4a']);

export type FileRef = { id: string; mimetype: string; size: number };
export type ResolvedEmbed = {
  embed: Omit<Draft, 'imageUrl' | 'mediaUrl' | 'avatarUrl'>;
  files: { image?: FileRef; media?: FileRef; avatar?: FileRef };
};

const baseType = (contentType: string) => contentType.split(';')[0].trim().toLowerCase();

// --- Files ---------------------------------------------------------------------------------------

const FILE_TTL_MS = 15 * 60_000;
const FILES_MAX_BYTES = 200 * 1024 * 1024;

/** The bytes resolves found, by unguessable ID, for 15 minutes, at most FILES_MAX_BYTES in all. */
export class FileStore {
  private files = new Map<string, { bytes: Buffer; mimetype: string; at: number }>();
  private total = 0;

  constructor(private readonly ttlMs = FILE_TTL_MS, private readonly maxBytes = FILES_MAX_BYTES) {}

  put(bytes: Buffer, mimetype: string, now = Date.now()): FileRef {
    this.expire(now);
    while (this.total + bytes.length > this.maxBytes && this.files.size > 0) this.drop(this.files.keys().next().value!);
    const id = randomBytes(18).toString('base64url');
    this.files.set(id, { bytes, mimetype, at: now });
    this.total += bytes.length;
    return { id, mimetype, size: bytes.length };
  }

  get(id: string, now = Date.now()): { bytes: Buffer; mimetype: string } | undefined {
    this.expire(now);
    return this.files.get(id);
  }

  private drop(id: string) {
    const file = this.files.get(id);
    if (!file) return;
    this.total -= file.bytes.length;
    this.files.delete(id);
  }

  private expire(now: number) {
    for (const [id, file] of this.files) {
      if (now - file.at < this.ttlMs) break; // in insertion order, so the rest are newer
      this.drop(id);
    }
  }
}

export const embedFiles = new FileStore();

// --- Fetching ------------------------------------------------------------------------------------

function limitFor(contentType: string): number {
  const type = baseType(contentType);
  if (type === 'text/html' || type === 'application/xhtml+xml') return PAGE_BYTES;
  if (IMAGE_TYPES.has(type)) return IMAGE_BYTES;
  if (VIDEO_TYPES.has(type) || AUDIO_TYPES.has(type)) return MEDIA_BYTES;
  return 0;
}

function kindOfFile(contentType: string): EmbedKind | undefined {
  const type = baseType(contentType);
  if (IMAGE_TYPES.has(type)) return 'image';
  if (VIDEO_TYPES.has(type)) return 'video';
  if (AUDIO_TYPES.has(type)) return 'audio';
  return undefined;
}

/** A picture for a card, kept if it's a picture this answers with. */
async function fetchImage(url: string | undefined): Promise<FileRef | undefined> {
  if (!url || urlProblem(url)) return undefined;
  try {
    const res = await guardedGet(url, { accept: 'image/*', limitFor: (type) => (IMAGE_TYPES.has(baseType(type)) ? IMAGE_BYTES : 0) });
    if (res.status !== 200 || res.truncated || res.body.length === 0) return undefined;
    return embedFiles.put(res.body, baseType(res.contentType));
  } catch {
    return undefined;
  }
}

async function fetchMedia(url: string | undefined): Promise<FileRef | undefined> {
  if (!url || urlProblem(url)) return undefined;
  try {
    const res = await guardedGet(url, { limitFor: (type) => (kindOfFile(type) ? limitFor(type) : 0) });
    if (res.status !== 200 || res.truncated || res.body.length === 0) return undefined;
    return embedFiles.put(res.body, baseType(res.contentType));
  } catch {
    return undefined;
  }
}

function fileName(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  return last.slice(0, 256) || new URL(url).hostname;
}

/** The page (or file) a link is, as a draft; undefined when it has nothing worth showing. */
async function fromPage(link: string, base: Partial<Draft> = {}): Promise<{ draft: Draft; file?: FileRef } | undefined> {
  const res = await guardedGet(link, { accept: 'text/html,application/xhtml+xml,image/*,video/*,audio/*;q=0.8', limitFor, keepStart: (type) => limitFor(type) === PAGE_BYTES });
  if (res.status !== 200) return undefined;
  const fileKind = kindOfFile(res.contentType);
  const host = new URL(res.url).hostname;
  if (fileKind) {
    // A direct file: the file itself, or a card naming it when it's too big to copy.
    if (res.truncated) return { draft: { url: link, kind: 'card', site: { name: host }, title: fileName(res.url) } };
    return { draft: { url: link, kind: fileKind }, file: embedFiles.put(res.body, baseType(res.contentType)) };
  }
  if (limitFor(res.contentType) !== PAGE_BYTES) return undefined;
  const meta = readPageMeta(decodePage(res.body, res.contentType));
  const pageUrl = (relative: string | undefined) => {
    if (!relative) return undefined;
    try {
      return new URL(relative, res.url).toString();
    } catch {
      return undefined;
    }
  };
  // Image and GIF hosts: the picture (or its video) rather than a card about it.
  if (MEDIA_PAGE_HOSTS.has(host.replace(/^(www|i|media)\./, ''))) {
    const image = pageUrl(meta.image);
    const video = pageUrl(meta.video);
    if (image && /\.gif(\?|$)/i.test(image)) return { draft: { url: link, kind: 'image', imageUrl: image, title: meta.title } };
    if (video && /mp4|webm/i.test(meta.videoType ?? video)) return { draft: { url: link, kind: 'video', mediaUrl: video, imageUrl: image, title: meta.title } };
    if (image) return { draft: { url: link, kind: 'image', imageUrl: image, title: meta.title } };
  }
  const title = meta.title;
  if (!title && !base.kind) return undefined;
  return {
    draft: {
      url: link,
      kind: base.kind ?? 'card',
      ...base,
      site: { name: meta.siteName ?? host.replace(/^www\./, ''), ...(meta.color && { color: meta.color }), ...base.site },
      ...(title && { title }),
      ...(meta.description && { description: meta.description }),
      imageUrl: pageUrl(meta.image),
      ...(meta.adult && { sensitive: true as const }),
    },
  };
}

function clean(draft: Draft): ResolvedEmbed['embed'] {
  const { imageUrl: _image, mediaUrl: _media, avatarUrl: _avatar, ...embed } = draft;
  const author = embed.author && Object.fromEntries(Object.entries(embed.author).filter(([, v]) => v !== undefined));
  const site = embed.site && Object.fromEntries(Object.entries(embed.site).filter(([, v]) => v !== undefined));
  return Object.fromEntries(
    Object.entries({ ...embed, author: author && Object.keys(author).length ? author : undefined, site: site && Object.keys(site).length ? site : undefined }).filter(
      ([, v]) => v !== undefined && v !== ''
    )
  ) as ResolvedEmbed['embed'];
}

/** Resolves one link, uncached. Throws FetchRefused for a link the guard won't fetch. */
export async function resolveUncached(link: string): Promise<ResolvedEmbed | undefined> {
  const problem = urlProblem(link);
  if (problem) throw new FetchRefused(problem);
  const url = new URL(link);
  let draft: Draft | undefined;
  let file: FileRef | undefined;

  const found = findProvider(url);
  if (found) {
    draft = await found.provider.resolve(url, found.params).catch(() => undefined);
    if (!draft && found.provider.fallbackToPage) {
      const page = await fromPage(link, found.provider.fallbackToPage(url, found.params)).catch(() => undefined);
      draft = page?.draft;
    }
    if (draft) draft.url = link;
  }
  if (!draft) {
    const page = await fromPage(link);
    if (!page) return undefined;
    draft = page.draft;
    file = page.file;
  }
  if (!draft.title && !draft.description && draft.kind !== 'image' && draft.kind !== 'video' && draft.kind !== 'audio') return undefined;

  const [image, media, avatar] = await Promise.all([
    draft.kind === 'image' && file ? Promise.resolve(file) : fetchImage(draft.imageUrl),
    (draft.kind === 'video' || draft.kind === 'audio') && file ? Promise.resolve(file) : draft.mediaUrl ? fetchMedia(draft.mediaUrl) : Promise.resolve(undefined),
    fetchImage(draft.avatarUrl),
  ]);
  // A file kind without its file is nothing to show.
  if (draft.kind === 'image' && !image) return undefined;
  if ((draft.kind === 'video' || draft.kind === 'audio') && !media) return undefined;
  return { embed: clean(draft), files: { ...(image && { image }), ...(media && { media }), ...(avatar && { avatar }) } };
}

// --- Caching -------------------------------------------------------------------------------------

const HIT_TTL_MS = FILE_TTL_MS - 60_000; // its files must still be there when the client asks
const MISS_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 2000;

/** Per URL: a link posted many times (or retyped while composing) is fetched once. */
export class EmbedCache {
  private entries = new Map<string, { at: number; pending: boolean; hit: boolean; result: Promise<ResolvedEmbed | undefined> }>();

  constructor(private readonly resolve: (link: string) => Promise<ResolvedEmbed | undefined> = resolveUncached) {}

  get(link: string, now = Date.now()): Promise<ResolvedEmbed | undefined> {
    const entry = this.entries.get(link);
    if (entry && (entry.pending || now - entry.at < (entry.hit ? HIT_TTL_MS : MISS_TTL_MS))) return entry.result;
    const fresh = { at: now, pending: true, hit: false, result: this.resolve(link).catch(() => undefined) };
    void fresh.result.then((result) => {
      fresh.pending = false;
      fresh.hit = !!result;
    });
    this.entries.delete(link);
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(link, fresh);
    return fresh.result;
  }
}

export const embedCache = new EmbedCache();

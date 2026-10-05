import { encryptAttachment } from 'browser-encrypt-attachment';
import type { MatrixClient } from 'matrix-js-sdk';
import { getOpenIdTokenCached } from './openIdToken';
import type { EmbedFile, StoredEmbed } from './embeds';

/**
 * The sending half of link embeds (docs/embeds.md): the token server resolves a link into an
 * embed and hands back its pictures as short-lived files; this fetches those, uploads them to the
 * homeserver as the sender's own (encrypted in an encrypted room), and builds what's stored.
 */

const API = '/api/public/embeds';

type FileRef = { id: string; mimetype: string; size: number };
export type ResolvedLink = {
  embed: Omit<StoredEmbed, 'image' | 'media'>;
  files: { image?: FileRef; media?: FileRef; avatar?: FileRef };
};

// Per page load: the same link typed again (or edited around) isn't asked about again. A failure
// is forgotten after a minute so a link can get its embed once the site answers.
const resolved = new Map<string, { at: number; result: Promise<ResolvedLink | null> }>();
const FAILURE_TTL_MS = 60_000;
/** Links whose lookup failed (not "nothing to show": the token server couldn't be asked). */
const failed = new Set<string>();

async function askTokenServer(mx: MatrixClient, url: string): Promise<ResolvedLink | null> {
  const res = await fetch(`${API}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid_token: await getOpenIdTokenCached(mx), url }),
  });
  if (res.status !== 200) {
    if (res.status === 204) return null;
    throw new Error(`Resolving a link failed: ${res.status}`);
  }
  const data = (await res.json()) as ResolvedLink;
  return data?.embed && typeof data.embed === 'object' ? data : null;
}

/** The token server's embed for a link, or null when there's none (or it couldn't be asked). */
export function resolveLink(mx: MatrixClient, url: string, now = Date.now()): Promise<ResolvedLink | null> {
  const known = resolved.get(url);
  if (known) return known.result;
  failed.delete(url);
  const result = askTokenServer(mx, url).catch(() => {
    // Asked again later: the token server may have been briefly unreachable.
    failed.add(url);
    setTimeout(() => {
      resolved.delete(url);
      failed.delete(url);
    }, FAILURE_TTL_MS);
    return null;
  });
  resolved.set(url, { at: now, result });
  return result;
}

/** Tests only. */
export function forgetResolvedLinks(): void {
  resolved.clear();
  failed.clear();
}

async function fetchFile(ref: FileRef): Promise<Blob | null> {
  const res = await fetch(`${API}/files/${encodeURIComponent(ref.id)}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Blob([blob], { type: ref.mimetype });
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return undefined;
  }
}

async function upload(mx: MatrixClient, blob: Blob, encrypt: boolean): Promise<Pick<EmbedFile, 'url' | 'file'>> {
  if (encrypt) {
    const { data, info } = await encryptAttachment(await blob.arrayBuffer());
    const { content_uri: url } = await mx.uploadContent(new Blob([data]), { type: 'application/octet-stream', includeFilename: false });
    return { file: { ...info, url } };
  }
  const { content_uri: url } = await mx.uploadContent(blob, { includeFilename: false });
  return { url };
}

/** Uploads one of a resolve's files; `gone` when the token server no longer has it. */
async function storeFile(mx: MatrixClient, ref: FileRef | undefined, encrypt: boolean): Promise<{ file?: EmbedFile; gone?: true }> {
  if (!ref) return {};
  const blob = await fetchFile(ref);
  if (!blob) return { gone: true };
  const size = ref.mimetype.startsWith('image/') ? await imageSize(blob) : undefined;
  const location = await upload(mx, blob, encrypt);
  return { file: { ...location, info: { mimetype: ref.mimetype, size: blob.size, ...size } } };
}

/**
 * What's stored for one resolved link: its pictures uploaded as the sender's (encrypted when
 * `encrypt`). `stale` when some of its files had already expired on the token server.
 */
export async function storeResolved(mx: MatrixClient, link: ResolvedLink, encrypt: boolean): Promise<{ embed?: StoredEmbed; stale: boolean }> {
  const [image, media, avatar] = await Promise.all([
    storeFile(mx, link.files.image, encrypt),
    storeFile(mx, link.files.media, encrypt),
    storeFile(mx, link.files.avatar, encrypt),
  ]);
  const stale = !!(image.gone || media.gone || avatar.gone);
  const { embed } = link;
  if (embed.kind === 'image' && !image.file) return { stale };
  if ((embed.kind === 'video' || embed.kind === 'audio') && !media.file) return { stale };
  return {
    stale,
    embed: {
      ...embed,
      ...(image.file && { image: image.file }),
      ...(media.file && { media: media.file }),
      ...(embed.author && { author: { ...embed.author, ...(avatar.file && { avatar: avatar.file }) } }),
    },
  };
}

/**
 * The embeds to send for these links (in order), given what each resolved to: each stored as the
 * sender's. A link whose files have expired (a draft left open a long time) is asked about again
 * once. Never throws: a link that can't be embedded is left out, and the message still sends.
 * `anyFailed`: some lookup couldn't be made at all (as opposed to a site with nothing to show).
 */
export async function prepareEmbedsReporting(mx: MatrixClient, links: string[], encrypt: boolean): Promise<{ embeds: StoredEmbed[]; anyFailed: boolean }> {
  const embeds = await prepareEmbeds(mx, links, encrypt);
  return { embeds, anyFailed: links.some((url) => failed.has(url)) };
}

export async function prepareEmbeds(mx: MatrixClient, links: string[], encrypt: boolean): Promise<StoredEmbed[]> {
  const stored = await Promise.all(
    links.map(async (url) => {
      try {
        const first = await resolveLink(mx, url);
        if (!first) return undefined;
        const result = await storeResolved(mx, first, encrypt);
        if (!result.stale) return result.embed;
        resolved.delete(url);
        const again = await resolveLink(mx, url);
        return again ? (await storeResolved(mx, again, encrypt)).embed : result.embed;
      } catch {
        return undefined;
      }
    })
  );
  return stored.filter((embed): embed is StoredEmbed => !!embed);
}

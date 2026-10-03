import { decryptAttachment, type EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { getStoredThemeCss } from '../app/theme';
import { getExtendedProfile } from './extendedProfile';
import { POST_EVENT_TYPE, readFeedMarker, readPrivatePosts } from './feed';
import { needsMediaAuthentication } from './mediaAuth';
import { COMMENT_EVENT_TYPE } from './postInteractions';
import { isRedacted, readOwnEvents } from './ownEvents';
import { getOwnProfileRoomId } from './profileFeed';
import { readProfilePage, readProfilePageDraft } from './profilePageStore';
import { findParentSpaceId } from './spaceChildren';
import { buildZip, type ZipEntry } from './zip';

/**
 * "Download my data" (Account Settings → Your data): everything this account put into Purrlor, as a
 * ZIP built here in the browser. Nothing is sent anywhere to make it, and this is the only place
 * an encrypted room's messages can be read at all.
 *
 * What's in it (README.txt in the ZIP says the same, for whoever opens it):
 * - account.json: your user ID, profile, sessions, and your account settings (account data)
 * - profile-page.json: your profile page as published, and any unpublished draft
 * - posts/: your Global posts, and your posts in each Space
 * - private-posts.json: posts you kept private
 * - messages/: every message you sent, one file per channel or conversation
 * - comments.json: your comments on other people's posts
 * - media/ (if asked for): the files you uploaded, decrypted
 * - theme.css: your custom theme, if you have one
 *
 * Only what you sent: other people's messages are theirs. Encryption keys aren't included; the
 * messages are already decrypted here, and another Matrix app signs in with your recovery key.
 */

export type ExportProgress = { step: 'profile' | 'rooms' | 'files' | 'packing'; done: number; total: number };

export type ExportOptions = {
  includeFiles: boolean;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
};

export type ExportResult = {
  blob: Blob;
  fileName: string;
  /** How much went in, for the person to see before they download it. */
  counts: { messages: number; posts: number; comments: number; files: number; filesFailed: number; undecryptable: number };
};

/** Account data that is only key material, encrypted with the recovery key: no use to anyone reading an export. */
const KEY_MATERIAL = /^(m\.secret_storage\.|m\.cross_signing\.|m\.megolm_backup\.|io\.element\.msc4|org\.matrix\.msc3814)/;

/** Event types that are something you said or posted, after decryption. */
const MESSAGE_TYPES = new Set<string>([EventType.RoomMessage, EventType.Sticker, 'm.poll.start', 'org.matrix.msc3381.poll.start']);

type ExportedEvent = {
  id: string;
  sentAt: string;
  type: string;
  /** The message's text, when it has some. */
  text?: string;
  /** This replaces (edits) an earlier one of yours. */
  edits?: string;
  /** This session couldn't decrypt it (no keys for it here). */
  undecryptable?: true;
  content?: Record<string, unknown>;
};

export function exportedEvent(event: MatrixEvent): ExportedEvent | undefined {
  if (isRedacted(event)) return undefined;
  const base = { id: event.getId() ?? '', sentAt: new Date(event.getTs()).toISOString(), type: event.getType() };
  if (event.isDecryptionFailure()) return { ...base, undecryptable: true };
  const content = event.getContent();
  const relation = content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined;
  const edits = relation?.rel_type === 'm.replace' ? relation.event_id : undefined;
  // An edit's real text is in m.new_content; its body is the "* fallback".
  const shown = (edits && (content['m.new_content'] as Record<string, unknown> | undefined)) || content;
  return {
    ...base,
    ...(typeof shown.body === 'string' && { text: shown.body }),
    ...(edits && { edits }),
    content,
  };
}

/** A file this account uploaded, and how to read it back. */
export type MediaRef = { mxc: string; encrypted?: EncryptedAttachmentInfo; name?: string; mimetype?: string };

const MXC = /^mxc:\/\/[^/\s]+\/[^/\s?#]+$/;

function isEncryptedFile(value: Record<string, unknown>): value is Record<string, unknown> & EncryptedAttachmentInfo & { url: string } {
  return typeof value.url === 'string' && typeof value.key === 'object' && typeof value.iv === 'string' && typeof value.hashes === 'object';
}

/**
 * Every file named anywhere in `value`: plain `mxc://` links, and encrypted attachments (an object
 * with the file's key, which is read with that key rather than saved as the ciphertext).
 */
export function collectMedia(value: unknown, into: MediaRef[] = [], context: { name?: string; mimetype?: string } = {}): MediaRef[] {
  if (typeof value === 'string') {
    if (MXC.test(value)) into.push({ mxc: value, ...context });
    return into;
  }
  if (!value || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) collectMedia(item, into);
    return into;
  }
  const object = value as Record<string, unknown>;
  if (isEncryptedFile(object)) {
    into.push({ mxc: object.url, encrypted: object, ...context });
    return into;
  }
  // A message's body is its file name; its info says the type.
  const info = object.info as { mimetype?: unknown } | undefined;
  const here = {
    ...(typeof object.body === 'string' && ('url' in object || 'file' in object) ? { name: object.body } : {}),
    ...(typeof info?.mimetype === 'string' && { mimetype: info.mimetype }),
  };
  for (const [key, child] of Object.entries(object)) {
    collectMedia(child, into, key === 'url' || key === 'file' ? here : {});
  }
  return into;
}

/** A file or folder name anyone's computer accepts: no slashes or reserved characters, not too long. */
export function safeName(name: string, fallback = 'file'): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** `name` made unique among `taken` (adding " (2)", " (3)"… before the extension). */
export function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function directRoomIds(mx: MatrixClient): Set<string> {
  const content = mx.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  return new Set(Object.values(content).flat());
}

type RoomKind = 'profile' | 'own-feed' | 'others-feed' | 'space' | 'direct' | 'channel';

function kindOf(mx: MatrixClient, room: Room, me: string, direct: Set<string>, profileRoomId: string | undefined): RoomKind {
  if (room.roomId === profileRoomId) return 'profile';
  if (room.isSpaceRoom()) return 'space';
  const marker = readFeedMarker(room);
  if (marker) return marker.owner === me ? (marker.profile ? 'profile' : 'own-feed') : 'others-feed';
  return direct.has(room.roomId) ? 'direct' : 'channel';
}

function roomLabel(mx: MatrixClient, room: Room, kind: RoomKind): string {
  if (kind === 'direct') return `DM with ${room.name || room.roomId}`;
  const spaceId = findParentSpaceId(mx, room.roomId);
  const space = spaceId ? mx.getRoom(spaceId) : null;
  return space ? `${space.name} - ${room.name || room.roomId}` : room.name || room.roomId;
}

async function fetchMediaBytes(mx: MatrixClient, ref: MediaRef): Promise<Uint8Array> {
  const useAuth = await needsMediaAuthentication(mx);
  const url = mx.mxcUrlToHttp(ref.mxc, undefined, undefined, undefined, undefined, undefined, useAuth);
  if (!url) throw new Error('Not a file link');
  const res = await fetch(url, useAuth ? { headers: { Authorization: `Bearer ${mx.getAccessToken()}` } } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  return ref.encrypted ? new Uint8Array(await decryptAttachment(bytes, ref.encrypted)) : new Uint8Array(bytes);
}

const README = (userId: string, date: string) => `Your Purrlor data
=================

Account: ${userId}
Exported: ${date}

account.json        Your user ID, profile, sessions (devices) and account settings.
profile-page.json   Your profile page as published, and any draft you hadn't published.
posts/              Your Global posts, and your posts in each Space.
private-posts.json  Posts you kept private.
messages/           Every message you sent, one file per channel or conversation, oldest first.
                    Edits are listed after the message they change ("edits" names it).
comments.json       Your comments on other people's posts.
media/              The files you uploaded (only if you asked for them).
theme.css           Your custom theme, if you made one.

Only what you sent is here: other people's messages are theirs to export.

Messages in encrypted conversations are here as text, decrypted by the browser that made this
file. Any marked "undecryptable" were sent from a session whose keys this one never received.

Encryption keys aren't included. To read your encrypted messages in another Matrix app, sign in
there and enter your recovery key.

Everything here is JSON (open it in any text editor, or a JSON viewer). Times are UTC.
`;

export async function buildDataExport(mx: MatrixClient, { includeFiles, onProgress, signal }: ExportOptions): Promise<ExportResult> {
  const me = mx.getUserId();
  if (!me) throw new Error('Not signed in');
  const now = new Date();
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const entries: ZipEntry[] = [];
  const media: MediaRef[] = [];
  const counts = { messages: 0, posts: 0, comments: 0, files: 0, filesFailed: 0, undecryptable: 0 };
  const taken = new Set<string>();

  // Profile, settings and page.
  onProgress?.({ step: 'profile', done: 0, total: 1 });
  const profileRoomId = getOwnProfileRoomId(mx);
  const [profile, extended, devices, page] = await Promise.all([
    mx.getProfileInfo(me).catch(() => ({})),
    getExtendedProfile(mx, me).catch(() => undefined),
    mx.getDevices().then((res) => res.devices).catch(() => []),
    profileRoomId ? readProfilePage(mx, profileRoomId).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const accountData = Object.fromEntries(
    [...mx.store.accountData.values()]
      .filter((event) => !KEY_MATERIAL.test(event.getType()))
      .map((event) => [event.getType(), event.getContent()])
  );
  entries.push({
    name: 'account.json',
    data: json({
      userId: me,
      homeserver: mx.getHomeserverUrl(),
      exportedAt: now.toISOString(),
      profile,
      ...(extended && { extendedProfile: extended }),
      sessions: devices,
      accountData,
    }),
  });
  collectMedia(profile, media);
  const draft = readProfilePageDraft(mx);
  if (page || draft) {
    entries.push({ name: 'profile-page.json', data: json({ published: page ?? null, draft: draft ?? null }) });
    collectMedia(page, media);
    collectMedia(draft, media);
  }
  const privatePosts = readPrivatePosts(mx);
  if (privatePosts.length) entries.push({ name: 'private-posts.json', data: json(privatePosts) });
  collectMedia(privatePosts, media);
  const theme = getStoredThemeCss();
  if (theme) entries.push({ name: 'theme.css', data: theme });

  // Every room you're in: what you sent there.
  const direct = directRoomIds(mx);
  const rooms = mx.getRooms().filter((room) => room.getMyMembership() === 'join');
  const comments: (ExportedEvent & { room: string })[] = [];
  for (const [index, room] of rooms.entries()) {
    signal?.throwIfAborted();
    onProgress?.({ step: 'rooms', done: index, total: rooms.length });
    const kind = kindOf(mx, room, me, direct, profileRoomId);
    if (kind === 'space') continue;
    const events = await readOwnEvents(mx, room.roomId, { signal }).catch((err) => {
      if (signal?.aborted) throw err;
      return [];
    });
    const label = roomLabel(mx, room, kind);
    const isFeed = kind === 'profile' || kind === 'own-feed' || kind === 'others-feed';
    // In a feed: your posts (only your own feeds have them) and your comments. Elsewhere: messages.
    const kept: ExportedEvent[] = [];
    for (const event of events) {
      const type = event.getType();
      const exported =
        type === COMMENT_EVENT_TYPE || (isFeed ? type === POST_EVENT_TYPE : MESSAGE_TYPES.has(type) || event.isDecryptionFailure())
          ? exportedEvent(event)
          : undefined;
      if (!exported) continue;
      if (exported.undecryptable) counts.undecryptable += 1;
      collectMedia(exported.content, media);
      if (type === COMMENT_EVENT_TYPE) {
        comments.push({ ...exported, room: label });
        counts.comments += 1;
      } else {
        kept.push(exported);
      }
    }
    if (kept.length === 0) continue;
    if (isFeed) {
      const name = kind === 'profile' ? 'Global' : (mx.getRoom(readFeedMarker(room)?.spaceId ?? '')?.name ?? label);
      entries.push({ name: `posts/${uniqueName(`${safeName(name, 'posts')}.json`, taken)}`, data: json({ where: name, roomId: room.roomId, posts: kept }) });
      counts.posts += kept.length;
    } else {
      entries.push({
        name: `messages/${uniqueName(`${safeName(label, 'conversation')}.json`, taken)}`,
        data: json({ conversation: label, kind, roomId: room.roomId, messages: kept }),
      });
      counts.messages += kept.length;
    }
  }
  if (comments.length) entries.push({ name: 'comments.json', data: json(comments) });

  // The files, each once.
  if (includeFiles) {
    const unique = [...new Map(media.map((ref) => [ref.mxc, ref])).values()];
    const failed: string[] = [];
    for (const [index, ref] of unique.entries()) {
      signal?.throwIfAborted();
      onProgress?.({ step: 'files', done: index, total: unique.length });
      try {
        const bytes = await fetchMediaBytes(mx, ref);
        const mediaId = ref.mxc.slice(ref.mxc.lastIndexOf('/') + 1);
        entries.push({ name: `media/${uniqueName(safeName(ref.name ?? mediaId, mediaId), taken)}`, data: bytes });
        counts.files += 1;
      } catch (err) {
        if (signal?.aborted) throw err;
        failed.push(`${ref.mxc}  (${(err as Error).message})`);
      }
    }
    counts.filesFailed = failed.length;
    if (failed.length) entries.push({ name: 'media/could-not-download.txt', data: `${failed.join('\n')}\n` });
  }

  onProgress?.({ step: 'packing', done: 0, total: 1 });
  entries.unshift({ name: 'README.txt', data: README(me, now.toISOString()) });
  const blob = await buildZip(entries.map((entry) => ({ ...entry, modified: now })));
  const localpart = me.slice(1, me.indexOf(':') > 0 ? me.indexOf(':') : undefined);
  return { blob, fileName: `purrlor-${safeName(localpart, 'account')}-${now.toISOString().slice(0, 10)}.zip`, counts };
}

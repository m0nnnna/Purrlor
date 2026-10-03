import { encryptAttachment, type EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import { MsgType, type MatrixClient } from 'matrix-js-sdk';
import type {
  AudioContent,
  FileContent,
  ImageContent,
  MediaEventContent,
  VideoContent,
} from 'matrix-js-sdk/lib/@types/media';
import { buildVoiceMessageContent, type VoiceMessageLocation } from './voiceMessage';
import { buildReplyRelation } from './replies';

type MediaLocation = { url: string } | { file: EncryptedAttachmentInfo & { url: string } };

/**
 * Uploads raw bytes (a `File` or an in-memory `Blob`, e.g. a MediaRecorder recording) the same
 * way for every attachment kind: encrypted client-side and uploaded without its real filename in
 * an E2EE room (matching Element's convention — the filename is only safe inside the
 * already-encrypted event body), or uploaded as-is otherwise. Shared by sendFileMessage (composer
 * file/image/video attachments) and sendVoiceMessage (recorded voice messages) so the two don't
 * duplicate the encrypt-or-not branching.
 */
async function uploadAttachmentBytes(mx: MatrixClient, roomId: string, bytes: File | Blob): Promise<MediaLocation> {
  if (mx.isRoomEncrypted(roomId)) {
    const { data, info: encryptInfo } = await encryptAttachment(await bytes.arrayBuffer());
    const { content_uri: mxcUrl } = await mx.uploadContent(new Blob([data]), {
      type: 'application/octet-stream',
      includeFilename: false,
    });
    return { file: { ...encryptInfo, url: mxcUrl } };
  }

  const { content_uri: mxcUrl } = await mx.uploadContent(bytes);
  return { url: mxcUrl };
}

function buildMediaContent(
  mimetype: string,
  body: string,
  location: MediaLocation,
  info: { mimetype: string; size: number; w?: number; h?: number }
): MediaEventContent {
  if (mimetype.startsWith('image/')) return { msgtype: MsgType.Image, body, ...location, info } as ImageContent;
  if (mimetype.startsWith('video/')) return { msgtype: MsgType.Video, body, ...location, info } as VideoContent;
  if (mimetype.startsWith('audio/')) return { msgtype: MsgType.Audio, body, ...location, info } as AudioContent;
  return { msgtype: MsgType.File, body, ...location, info } as FileContent;
}

/** Best-effort pixel dimensions for an image file, so the sent event carries `info.w`/`info.h`
 *  up front the same way received images do — that's what lets ImageMessage reserve the right
 *  aspect ratio before the bytes round-trip back down. Skipped for non-images or anything that
 *  fails to decode; the message still sends fine either way. */
async function readImageDimensions(file: File): Promise<{ w: number; h: number } | undefined> {
  if (!file.type.startsWith('image/')) return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return undefined;
  }
}

/**
 * Uploads a local file and sends it as a room message — the composer's counterpart to how
 * ImageMessage/useAttachmentUrl already receive attachments, just running the same encrypted-
 * attachments spec in reverse. In an encrypted room the file bytes are encrypted client-side
 * (browser-encrypt-attachment, the same library the receive path decrypts with) before upload,
 * and the ciphertext blob is uploaded without its real filename (`includeFilename: false`,
 * matching Element's convention) since the filename itself is only safe inside the already-
 * encrypted event body, not as unencrypted upload metadata. `replyTo` makes it a reply to that event.
 */
export async function sendFileMessage(
  mx: MatrixClient,
  roomId: string,
  threadId: string | null,
  file: File,
  replyTo?: string
): Promise<void> {
  const mimetype = file.type || 'application/octet-stream';
  const dimensions = await readImageDimensions(file);
  const info = { mimetype, size: file.size, ...dimensions };
  const location = await uploadAttachmentBytes(mx, roomId, file);
  const content = buildMediaContent(mimetype, file.name, location, info);
  await mx.sendMessage(roomId, threadId, replyTo ? { ...content, 'm.relates_to': buildReplyRelation(replyTo) } : content);
}

/**
 * Uploads a recorded voice message and sends it as an `m.audio` event carrying the MSC3245
 * voice-message extensions — the composer's voice-recorder counterpart to sendFileMessage above,
 * sharing the same upload/encryption path (see uploadAttachmentBytes) but building its event
 * content via buildVoiceMessageContent instead of buildMediaContent, since a voice message needs
 * the extra org.matrix.msc1767.audio/org.matrix.msc3245.voice blocks a generic audio attachment
 * doesn't. `replyTo` makes it a reply to that event.
 */
export async function sendVoiceMessage(
  mx: MatrixClient,
  roomId: string,
  threadId: string | null,
  blob: Blob,
  mimetype: string,
  durationMs: number,
  waveform: number[],
  replyTo?: string
): Promise<void> {
  const location: VoiceMessageLocation = await uploadAttachmentBytes(mx, roomId, blob);
  const content = {
    ...buildVoiceMessageContent({ location, mimetype, size: blob.size, durationMs, waveform }),
    ...(replyTo && { 'm.relates_to': buildReplyRelation(replyTo) }),
  };
  // matrix-js-sdk's RoomMessageEventContent union has no slot for the MSC1767/MSC3245 voice
  // fields (same reason every other custom-namespaced event in this codebase needs a cast — see
  // eslint.config.js's note on @typescript-eslint/no-explicit-any). The content is still a
  // perfectly valid m.audio event; the SDK's types just don't know about its extra keys.
  await mx.sendMessage(roomId, threadId, content as unknown as AudioContent);
}

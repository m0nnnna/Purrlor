import type { MatrixClient } from 'matrix-js-sdk';
import { formatBytes, getUploadLimit } from './postMedia';
import { LIMITS, MUSIC_AUDIO_TYPES, readAudioType, type MusicAudioType, type MusicTrack } from './profilePage';

/** The most a public file may weigh: the public media route refuses anything larger
 *  (PUBLIC_MEDIA_MAX_BYTES, docs/public-web.md), so a track over it would never play for visitors. */
export const PUBLIC_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** For the file picker's `accept` attribute. */
export const MUSIC_ACCEPT = [...MUSIC_AUDIO_TYPES, '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm', '.flac', '.wav'].join(',');

const BY_EXTENSION: Record<string, MusicAudioType> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  webm: 'audio/webm',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

/**
 * What kind of sound a picked file is, as one of the allowed types, or undefined if it isn't one.
 * Browsers often report nothing, or a variant like `audio/mp3`, for files they play fine, so for
 * those the extension decides. A file whose declared type is something else (a video, a web page)
 * is refused whatever it's called.
 */
export function audioTypeOf(file: { type: string; name: string }): MusicAudioType | undefined {
  const declared = readAudioType(file.type);
  if (declared) return declared;
  if (file.type !== '' && !file.type.toLowerCase().startsWith('audio/')) return undefined;
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  return extension ? BY_EXTENSION[extension] : undefined;
}

/** A track's starting title from its file name: no extension, underscores as spaces, one line. */
export function titleFromFileName(name: string): string {
  const title = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.trackTitle)
    .trim();
  return title || 'Untitled';
}

/** `3:05`, or `1:02:03` for an hour or more. Anything that isn't a time is `0:00`. */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** How long a sound file runs, read from its own header; undefined if the browser can't tell in a few seconds. */
export function measureDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let done = false;
    const finish = (value: number | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 8000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration) : undefined);
    audio.onerror = () => finish(undefined);
    audio.src = url;
  });
}

/**
 * Uploads one track for a page and gives back the track to put in the music block. Plain (not
 * encrypted), since the page it goes on is public; the homeserver's upload limit applies, and so
 * does the public route's. Throws a sentence for the builder to show.
 */
export async function uploadTrack(mx: MatrixClient, file: File): Promise<MusicTrack> {
  const mimetype = audioTypeOf(file);
  if (!mimetype) throw new Error(`${file.name} isn’t a sound Purrlor can play (MP3, M4A, AAC, OGG, Opus, WebM, FLAC or WAV).`);
  const limit = Math.min((await getUploadLimit(mx)) ?? Infinity, PUBLIC_FILE_MAX_BYTES);
  if (file.size > limit) throw new Error(`${file.name} is ${formatBytes(file.size)}; a track can be up to ${formatBytes(limit)}.`);
  const [duration, uploaded] = await Promise.all([measureDuration(file), mx.uploadContent(file, { type: mimetype, name: file.name })]);
  return {
    url: uploaded.content_uri,
    mimetype,
    title: titleFromFileName(file.name),
    size: file.size,
    ...(duration && duration <= LIMITS.trackDuration && { duration }),
  };
}

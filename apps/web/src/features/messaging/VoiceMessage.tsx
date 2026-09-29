import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { EncryptedAttachmentInfo } from 'browser-encrypt-attachment';
import { Icon } from '../../components/Icon';
import { useAttachmentUrl } from '../../matrix/hooks/useAttachmentUrl';
import { formatElapsed } from './voiceRecording';
import './VoiceMessage.css';

type VoiceMessageProps = {
  body: string;
  url?: string;
  file?: (EncryptedAttachmentInfo & { url: string }) | undefined;
  mimetype?: string;
  /** From `info.duration` (ms) — shown before playback starts and used as a fallback if the
   *  decoded `<audio>` element never reports its own duration (some Opus-in-Ogg files don't). */
  durationMs?: number;
  /** ~100 ints, 0–1024, from `org.matrix.msc1767.audio.waveform`. */
  waveform?: number[];
};

/** Bars are drawn from a fixed-height container; each bar's height is this fraction of the
 *  container at minimum, so even a silent bucket still reads as a bar rather than vanishing. */
const MIN_BAR_HEIGHT_FRACTION = 0.08;

/**
 * Compact player for `m.audio` messages that carry `org.matrix.msc3245.voice` — a play/pause
 * button plus a waveform scrubber, replacing FileMessage's plain `<audio controls>` for anything
 * recorded as a voice message (see Composer's mic button / matrix/upload.ts's
 * sendVoiceMessage). Plain `m.audio` files with no voice marker keep using FileMessage as before.
 */
export function VoiceMessage({ body, url, file, mimetype, durationMs, waveform }: VoiceMessageProps) {
  const src = useAttachmentUrl({ url, file, mimetype });
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [knownDurationMs, setKnownDurationMs] = useState<number | undefined>(durationMs);

  // Reset playback position/state when the underlying src actually changes (e.g. this row is
  // reused for a different event) rather than on every render.
  useEffect(() => {
    setPlaying(false);
    setCurrentTimeMs(0);
  }, [src]);

  const totalDurationMs = knownDurationMs ?? durationMs ?? 0;
  const bars = waveform && waveform.length > 0 ? waveform : new Array(40).fill(0);
  const progress = totalDurationMs > 0 ? Math.min(1, currentTimeMs / totalDurationMs) : 0;
  const progressBarIndex = Math.floor(progress * bars.length);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  const seekToFraction = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(1, fraction)) * audio.duration;
  };

  const handleWaveformClick = (evt: MouseEvent<HTMLDivElement>) => {
    const rect = evt.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekToFraction((evt.clientX - rect.left) / rect.width);
  };

  if (!src) {
    return (
      <div className="nu-voice-message nu-voice-message--loading" data-nu-role="timeline-voice-message">
        Loading {body || 'voice message'}…
      </div>
    );
  }

  return (
    <div className="nu-voice-message" data-nu-role="timeline-voice-message">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTimeMs(0);
        }}
        onTimeUpdate={(evt) => setCurrentTimeMs(evt.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(evt) => {
          const duration = evt.currentTarget.duration;
          if (Number.isFinite(duration) && duration > 0) setKnownDurationMs(duration * 1000);
        }}
      />
      <button
        type="button"
        className="nu-voice-message__toggle"
        data-nu-role="timeline-voice-toggle"
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={togglePlayback}
      >
        <Icon name={playing ? 'pause' : 'play'} size={16} filled />
      </button>
      <div
        className="nu-voice-message__waveform"
        data-nu-role="timeline-voice-waveform"
        onClick={handleWaveformClick}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        onKeyDown={(evt) => {
          if (evt.key === 'ArrowLeft') seekToFraction(progress - 0.05);
          else if (evt.key === 'ArrowRight') seekToFraction(progress + 0.05);
        }}
      >
        {bars.map((peak, i) => (
          <span
            key={i}
            className={i < progressBarIndex ? 'nu-voice-message__bar nu-voice-message__bar--played' : 'nu-voice-message__bar'}
            style={{ height: `${Math.max(MIN_BAR_HEIGHT_FRACTION, peak / 1024) * 100}%` }}
          />
        ))}
      </div>
      <span className="nu-voice-message__time" data-nu-role="timeline-voice-time">
        {formatElapsed(playing || currentTimeMs > 0 ? currentTimeMs : totalDurationMs)}
      </span>
    </div>
  );
}

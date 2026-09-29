import { Icon } from '../../components/Icon';
import { formatElapsed, MAX_RECORDING_MS } from './voiceRecording';
import './VoiceRecorderBar.css';

/**
 * Replaces the composer's normal input row while a voice message is being recorded (or the mic
 * permission prompt is pending) — a pulsing dot, elapsed time, and exactly the cancel + send
 * pair the spec calls for, no separate stop control.
 */
export function VoiceRecorderBar({
  elapsedMs,
  requesting,
  sending,
  onCancel,
  onSend,
}: {
  /** Elapsed recording time in ms; ignored (shows a "Requesting microphone…" label instead)
   *  while `requesting`. */
  elapsedMs: number;
  requesting?: boolean;
  sending?: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div className="nu-voice-recorder" data-nu-role="composer-voice-recorder">
      <button
        type="button"
        className="nu-voice-recorder__cancel"
        data-nu-role="composer-voice-cancel"
        title="Cancel recording"
        aria-label="Cancel recording"
        onClick={onCancel}
        disabled={sending}
      >
        <Icon name="x" size={16} />
      </button>
      <div className="nu-voice-recorder__status" data-nu-role="composer-voice-status">
        <span className="nu-voice-recorder__dot" aria-hidden="true" />
        {requesting ? (
          <span className="nu-voice-recorder__label">Requesting microphone…</span>
        ) : (
          <>
            <span className="nu-voice-recorder__time">{formatElapsed(elapsedMs)}</span>
            {elapsedMs >= MAX_RECORDING_MS && (
              <span className="nu-voice-recorder__capped">Max length reached</span>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="nu-voice-recorder__send"
        data-nu-role="composer-voice-send"
        title="Send voice message"
        aria-label="Send voice message"
        onClick={onSend}
        disabled={requesting || sending}
      >
        {sending ? <span className="nu-voice-recorder__send-spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={18} />}
      </button>
    </div>
  );
}

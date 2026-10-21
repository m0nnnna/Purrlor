import { readAudioSettings, type MessageSoundStyle } from '../voice/audioSettings';
import { getAudioContext } from '../voice/voiceSounds';

/**
 * The in-tab message cues: one when a message of yours is sent, one when a message that would
 * notify you comes in. Pure Web Audio like voiceSounds.ts, so they need no desktop notification
 * permission, only the tab. Settings → Voice & Audio picks the style and volume, mutes either,
 * and can keep the incoming one for when Purrlor isn't the window in front (audioSettings.ts).
 */

type Note = {
  freq: number;
  endFreq?: number;
  at?: number;
  duration: number;
  gain?: number;
  wave?: OscillatorType;
  /** An overtone at `ratio` × freq, `level` loud, dying away `decay` × as fast: a struck sound. */
  overtone?: { ratio: number; level: number; decay: number };
};

const STYLES: Record<MessageSoundStyle, { sent: Note[]; received: Note[] }> = {
  // A soft, low bubble.
  pop: {
    sent: [{ freq: 380, endFreq: 560, duration: 0.07 }],
    received: [{ freq: 520, endFreq: 400, duration: 0.09 }],
  },
  // Two gentle bell notes.
  chime: {
    sent: [{ freq: 784, duration: 0.2, gain: 0.6 }],
    received: [
      { freq: 659, duration: 0.22, gain: 0.6 },
      { freq: 988, at: 0.1, duration: 0.28, gain: 0.5 },
    ],
  },
  // A falling droplet.
  drop: {
    sent: [{ freq: 700, endFreq: 360, duration: 0.09 }],
    received: [{ freq: 1100, endFreq: 480, duration: 0.13 }],
  },
  // Barely there: a short click.
  tick: {
    sent: [{ freq: 1600, duration: 0.02, gain: 0.5 }],
    received: [
      { freq: 1300, duration: 0.025, gain: 0.5 },
      { freq: 1300, at: 0.07, duration: 0.025, gain: 0.5 },
    ],
  },
  // A quick upward bloop.
  bubble: {
    sent: [{ freq: 300, endFreq: 700, duration: 0.05, gain: 0.8 }],
    received: [
      { freq: 350, endFreq: 800, duration: 0.05, gain: 0.8 },
      { freq: 450, endFreq: 1000, at: 0.07, duration: 0.05, gain: 0.6 },
    ],
  },
  // A wooden mallet: the default.
  marimba: {
    sent: [{ freq: 523, duration: 0.25, overtone: { ratio: 4, level: 0.3, decay: 3 } }],
    received: [
      { freq: 440, duration: 0.25, overtone: { ratio: 4, level: 0.3, decay: 3 } },
      { freq: 660, at: 0.09, duration: 0.3, overtone: { ratio: 4, level: 0.3, decay: 3 } },
    ],
  },
  // A dull tap on wood.
  knock: {
    sent: [{ freq: 180, endFreq: 140, duration: 0.06, wave: 'triangle' }],
    received: [
      { freq: 200, endFreq: 150, duration: 0.06, wave: 'triangle' },
      { freq: 200, endFreq: 150, at: 0.11, duration: 0.06, wave: 'triangle' },
    ],
  },
  // A thin glassy ping.
  glass: {
    sent: [{ freq: 1568, duration: 0.3, gain: 0.35, overtone: { ratio: 2.76, level: 0.2, decay: 2 } }],
    received: [
      { freq: 1319, duration: 0.35, gain: 0.35, overtone: { ratio: 2.76, level: 0.2, decay: 2 } },
      { freq: 1760, at: 0.12, duration: 0.4, gain: 0.3, overtone: { ratio: 2.76, level: 0.2, decay: 2 } },
    ],
  },
  // Two soft low notes.
  hum: {
    sent: [{ freq: 262, duration: 0.15, gain: 0.8 }],
    received: [
      { freq: 220, duration: 0.2, gain: 0.8 },
      { freq: 294, at: 0.12, duration: 0.22, gain: 0.7 },
    ],
  },
};

/** The loudest a cue gets at full volume: well under the call sounds. */
const MAX_GAIN = 0.25;

function playNotes(notes: Note[], volume: number) {
  if (volume <= 0) return;
  try {
    const ctx = getAudioContext();
    const tone = (freq: number, endFreq: number | undefined, wave: OscillatorType, peak: number, start: number, end: number) => {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, start);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, end);
      // A few milliseconds' fade in, so it doesn't start with a click.
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end);
    };
    for (const note of notes) {
      const start = ctx.currentTime + (note.at ?? 0);
      const end = start + note.duration;
      const peak = MAX_GAIN * volume * (note.gain ?? 1);
      tone(note.freq, note.endFreq, note.wave ?? 'sine', peak, start, end);
      const o = note.overtone;
      if (o) {
        const overtoneEnd = start + Math.max(0.02, note.duration / (1 + o.decay));
        tone(note.freq * o.ratio, note.endFreq && note.endFreq * o.ratio, 'sine', peak * o.level, start, overtoneEnd);
      }
    }
  } catch {
    // Audio context unavailable — silently ignore
  }
}

/** Plays a cue as it would sound, mute switches aside: the Settings preview. */
export function previewMessageSound(kind: 'sent' | 'received', style: MessageSoundStyle, volume: number) {
  playNotes(STYLES[style][kind], volume);
}

export function playMessageSentSound() {
  const s = readAudioSettings();
  if (!s.messageSentSound) return;
  playNotes(STYLES[s.messageSoundStyle].sent, s.messageSoundVolume);
}

export function playMessageReceivedSound() {
  const s = readAudioSettings();
  if (!s.messageReceivedSound) return;
  if (s.messageReceivedOnlyAway && document.hasFocus()) return;
  playNotes(STYLES[s.messageSoundStyle].received, s.messageSoundVolume);
}

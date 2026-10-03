import type { LocalParticipant } from 'livekit-client';

/** Mute and deafen, shared by the call's buttons (VoiceCallBody) and its keybinds (CallHotkeys). */

export function toggleDeafen(localParticipant: LocalParticipant, deafened: boolean, setDeafened: (d: boolean) => void): void {
  const next = !deafened;
  setDeafened(next);
  // LiveKit has no built-in "deafened" concept — broadcast it ourselves via participant
  // attributes so other participants (and the channel-list occupancy view) can show it too.
  void localParticipant.setAttributes({ deafened: String(next) });
  if (next && localParticipant.isMicrophoneEnabled) {
    void localParticipant.setMicrophoneEnabled(false);
  }
}

export function toggleMute(localParticipant: LocalParticipant, deafened: boolean, setDeafened: (d: boolean) => void): void {
  if (deafened) {
    // Unmuting while deafened undeafens too: you can't talk to people you can't hear.
    setDeafened(false);
    void localParticipant.setAttributes({ deafened: 'false' });
  }
  void localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled);
}

import type { RemoteParticipant, Room } from 'livekit-client';
import { readAudioSettings } from './audioSettings';

/**
 * What each person in the call plays at: their own "volume for me" slider times your overall
 * volume (Settings → Voice & Audio). Both go through RemoteParticipant.setVolume, so they have to
 * be combined here; setting either one directly would undo the other. The per-person levels last
 * for this page load, by participant identity.
 */
const personal = new Map<string, number>();

export function personVolume(identity: string): number {
  return personal.get(identity) ?? 1;
}

export function setPersonVolume(participant: RemoteParticipant, volume: number): void {
  personal.set(participant.identity, volume);
  participant.setVolume(volume * readAudioSettings().outputVolume);
}

/** Re-applies every remote participant's level: after the overall volume changes, or someone joins. */
export function applyCallVolumes(room: Room): void {
  const overall = readAudioSettings().outputVolume;
  for (const participant of room.remoteParticipants.values()) {
    participant.setVolume(personVolume(participant.identity) * overall);
  }
}

const VOLUME_KEY = 'nekous_listen_together_volume';

/** Your own volume for music: Listen Together's card and a profile page's music block share it, so
 *  turning it down in one stays down in the other. 0.6 until you've chosen. */
export function readListenVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : 0.6;
  } catch {
    return 0.6;
  }
}

export function saveListenVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Not remembered this time; it still applies now.
  }
}

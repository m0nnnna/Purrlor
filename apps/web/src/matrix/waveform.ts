/**
 * MSC1767 waveform support for voice messages: a compact amplitude preview (Element renders it
 * as bars behind the scrubber) sent alongside `org.matrix.msc1767.audio`. The spec calls for
 * "approximately 100" integers in the range 0–1024.
 *
 * Split into a pure downsampling step (unit-tested, no browser APIs) and a thin decode step
 * (`computeWaveform`, needs a real `AudioContext` — jsdom doesn't implement Web Audio, so that
 * half only gets exercised by hand in a real browser).
 */

const DEFAULT_BUCKETS = 100;
const PEAK_MAX = 1024;

/**
 * Downsamples raw PCM samples (any typed/plain array of -1..1 floats, e.g. one channel of
 * `AudioBuffer.getChannelData`) into `buckets` peak-amplitude integers scaled to 0–1024, the
 * range MSC1767 waveforms use.
 *
 * Peak (not average/RMS) per bucket, matching how Element computes its own waveform previews —
 * it keeps transients (a knock, a consonant) visible instead of averaging them away.
 */
export function downsamplePeaks(samples: ArrayLike<number>, buckets: number = DEFAULT_BUCKETS): number[] {
  const total = samples.length;
  if (total === 0 || buckets <= 0) return [];

  const bucketSize = total / buckets;
  const peaks: number[] = new Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * bucketSize);
    const end = b === buckets - 1 ? total : Math.max(start + 1, Math.floor((b + 1) * bucketSize));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const amplitude = Math.abs(samples[i]);
      if (amplitude > peak) peak = amplitude;
    }
    // Samples are nominally -1..1, but a hot/clipped recording can exceed that slightly — clamp
    // before scaling so a stray outlier can't push a bucket past the spec's 0–1024 ceiling.
    peaks[b] = Math.round(Math.min(1, peak) * PEAK_MAX);
  }

  return peaks;
}

/**
 * Decodes a recorded audio blob and returns its MSC1767 waveform. Mixes all channels down to
 * one (simple average) before downsampling — a waveform preview doesn't need stereo detail, and
 * voice recordings are mono in practice anyway.
 *
 * Needs a real `AudioContext`/`decodeAudioData`; not covered by the jsdom test environment.
 */
export async function computeWaveform(blob: Blob, buckets: number = DEFAULT_BUCKETS): Promise<number[]> {
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return [];

  const context = new AudioContextCtor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mixed = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mixed[i] += data[i] / channels;
    }
    return downsamplePeaks(mixed, buckets);
  } finally {
    void context.close();
  }
}

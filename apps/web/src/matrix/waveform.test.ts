import { describe, expect, it } from 'vitest';
import { downsamplePeaks } from './waveform';

describe('downsamplePeaks', () => {
  it('returns an empty array for empty input', () => {
    expect(downsamplePeaks([], 100)).toEqual([]);
  });

  it('downsamples to the requested number of buckets', () => {
    const samples = new Array(1000).fill(0).map((_, i) => Math.sin(i));
    expect(downsamplePeaks(samples, 100)).toHaveLength(100);
  });

  it('scales peak amplitude 0..1 to integers 0..1024', () => {
    const samples = [0, 0.5, -1, 0.25];
    // One bucket covering everything — the peak absolute value is 1 (from -1).
    expect(downsamplePeaks(samples, 1)).toEqual([1024]);
  });

  it('takes the peak (not the average) within each bucket', () => {
    // First half is quiet, second half has one loud spike — a peak-based bucket for the second
    // half should read as loud, not washed out by the surrounding silence.
    const samples = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    const peaks = downsamplePeaks(samples, 2);
    expect(peaks[0]).toBe(0);
    expect(peaks[1]).toBe(1024);
  });

  it('clamps amplitudes beyond -1..1 instead of overflowing past 1024', () => {
    expect(downsamplePeaks([1.5, -2], 1)).toEqual([1024]);
  });

  it('handles fewer samples than buckets by giving every sample its own bucket span', () => {
    // Input shorter than the bucket count would otherwise produce empty (0) buckets past the
    // sample count if `end` were computed naively — every bucket should still get at least the
    // one sample nearest it.
    const samples = [0.1, 0.9, 0.3];
    const peaks = downsamplePeaks(samples, 10);
    expect(peaks).toHaveLength(10);
    expect(peaks.some((p) => p > 0)).toBe(true);
  });

  it('defaults to ~100 buckets when none is given', () => {
    const samples = new Array(500).fill(0.5);
    expect(downsamplePeaks(samples)).toHaveLength(100);
  });

  it('produces a reasonable amplitude for a full-scale sine wave', () => {
    const samples = new Array(2000).fill(0).map((_, i) => Math.sin((i / 2000) * Math.PI * 20));
    const peaks = downsamplePeaks(samples, 50);
    // A sine wave hits its peak (amplitude 1) somewhere in most buckets across 10 full cycles.
    expect(Math.max(...peaks)).toBeGreaterThan(900);
    expect(peaks.every((p) => p >= 0 && p <= 1024)).toBe(true);
  });
});

import { centsBetween, estimatePitch, signalStats } from "../../src/synth/analysis.ts";
import { decodeWav } from "../../src/wav.ts";

export function stats(samples: Float32Array): { peak: number; rms: number; finite: boolean } {
  const result = signalStats(samples);
  return { peak: result.peak, rms: result.rms, finite: result.finite };
}

export function wavStats(wav: Uint8Array): { peak: number; rms: number; finite: boolean; frames: number } {
  const decoded = decodeWav(wav);
  return { ...stats(decoded.samples), frames: decoded.samples.length };
}

export function pitchCents(
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  targetHz: number,
): { hz: number; cents: number; clarity: number } {
  const estimate = estimatePitch(samples, sampleRate, from, to, 40, 1500);
  return {
    hz: estimate.hz,
    cents: estimate.hz > 0 ? centsBetween(estimate.hz, targetHz) : Number.NaN,
    clarity: estimate.clarity,
  };
}

export function rmsBetween(samples: Float32Array, from: number, to: number): number {
  return signalStats(samples, from, to).rms;
}

export function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let max = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) max = Math.max(max, Math.abs((a[index] ?? 0) - (b[index] ?? 0)));
  return Math.max(max, a.length === b.length ? 0 : 1);
}

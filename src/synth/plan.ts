import type { Diagnostic } from "../errors.ts";
import type { Phoneme } from "../text/mora.ts";
import type { ReadingPlan } from "../text/reading.ts";
import type { VoiceProfile } from "./voice.ts";

export const PARAM_COUNT: number = 24;
export const P_F1: number = 0;
export const P_F2: number = 1;
export const P_F3: number = 2;
export const P_F4: number = 3;
export const P_F5: number = 4;
export const P_B1: number = 5;
export const P_B2: number = 6;
export const P_B3: number = 7;
export const P_B4: number = 8;
export const P_B5: number = 9;
export const P_AV: number = 10;
export const P_AH: number = 11;
export const P_AF: number = 12;
export const P_RD: number = 13;
export const P_NMIX: number = 14;
export const P_NPOLE: number = 15;
export const P_NZERO: number = 16;
export const P_FF1: number = 17;
export const P_FB1: number = 18;
export const P_FG1: number = 19;
export const P_FF2: number = 20;
export const P_FB2: number = 21;
export const P_FG2: number = 22;
export const P_FHP: number = 23;

export const PARAM_NAMES: readonly string[] = [
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "b1",
  "b2",
  "b3",
  "b4",
  "b5",
  "av",
  "ah",
  "af",
  "rd",
  "nasalMix",
  "nasalPole",
  "nasalZero",
  "fricF1",
  "fricB1",
  "fricG1",
  "fricF2",
  "fricB2",
  "fricG2",
  "fricHp",
];

export interface Keyframe {
  readonly at: number;
  readonly values: Float64Array;
}

export type Articulation = "onset" | "continue" | "rearticulate";

export interface PlannedSegment {
  readonly id: number;
  readonly phoneme: Phoneme;
  readonly start: number;
  readonly end: number;
  readonly voiced: boolean;
  readonly keyframes: readonly Keyframe[];
  readonly moraIndex: number | null;
  readonly phraseIndex: number | null;
  readonly noteId: string | null;
  readonly sustainId: number | null;
  readonly articulation: Articulation;
}

export interface PitchPoint {
  readonly sample: number;
  readonly hz: number;
}

export interface VibratoRegion {
  readonly start: number;
  readonly end: number;
  readonly delaySeconds: number;
  readonly fadeSeconds: number;
  readonly depthCents: number;
  readonly rateHz: number;
}

export interface MoraMarker {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly phraseIndex: number;
  readonly phonemes: readonly Phoneme[];
}

export interface PhraseMarker {
  readonly index: number;
  readonly text: string;
  readonly kana: string;
  readonly accent: number;
  readonly start: number;
  readonly end: number;
  readonly boundary: string;
}

export interface NoteMarker {
  readonly id: string;
  readonly index: number;
  readonly key: number | null;
  readonly hz: number | null;
  readonly lyric: string;
  readonly start: number;
  readonly end: number;
  readonly vowelStart: number | null;
  readonly sustainId: number | null;
  readonly continuation: "none" | "tie" | "melisma";
  readonly articulation: Articulation;
}

export interface Adjustment {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly noteId?: string;
  readonly before?: number;
  readonly after?: number;
}

export interface SynthesisPlan {
  readonly planVersion: number;
  readonly engineVersion: string;
  readonly kind: "speech" | "song";
  readonly sampleRate: number;
  readonly seed: number;
  readonly frames: number;
  readonly voice: VoiceProfile;
  readonly volume: number;
  readonly jitter: number;
  readonly shimmerDb: number;
  readonly flutter: number;
  readonly segments: readonly PlannedSegment[];
  readonly pitch: readonly PitchPoint[];
  readonly vibrato: readonly VibratoRegion[];
  readonly moras: readonly MoraMarker[];
  readonly phrases: readonly PhraseMarker[];
  readonly notes: readonly NoteMarker[];
  readonly reading: ReadingPlan | null;
  readonly warnings: readonly Diagnostic[];
  readonly adjustments: readonly Adjustment[];
  readonly f0Min: number;
  readonly f0Max: number;
}

export function keyframeToObject(frame: Keyframe): Record<string, number> {
  const out: Record<string, number> = { at: Math.round(frame.at * 1e5) / 1e5 };
  for (const [index, name] of PARAM_NAMES.entries()) {
    const value = frame.values[index] ?? 0;
    out[name] = Math.round(value * 1000) / 1000;
  }
  return out;
}

export function interpolatePitchLog(points: readonly PitchPoint[], sample: number, cursor: { index: number }): number {
  if (points.length === 0) return 0;
  let index = cursor.index;
  while (index + 1 < points.length && (points[index + 1]?.sample ?? Infinity) <= sample) index += 1;
  while (index > 0 && (points[index]?.sample ?? 0) > sample) index -= 1;
  cursor.index = index;
  const current = points[index] ?? points[0];
  const next = points[index + 1];
  if (current === undefined) return 0;
  if (next === undefined || sample <= current.sample) return current.hz;
  const span = next.sample - current.sample;
  if (span <= 0) return next.hz;
  const t = (sample - current.sample) / span;
  return Math.exp(Math.log(current.hz) + (Math.log(next.hz) - Math.log(current.hz)) * t);
}

import type { Phoneme } from "../text/mora.ts";
import type { FricationSpec, PhonemeSpec } from "./phonemes.ts";
import { MORAIC_NASAL_TARGETS, PHONEMES, isVowelPhoneme, moraicNasalPlace } from "./phonemes.ts";
import type { Articulation, Keyframe, PlannedSegment } from "./plan.ts";
import {
  PARAM_COUNT,
  P_AF,
  P_AH,
  P_AV,
  P_B1,
  P_B2,
  P_B3,
  P_B4,
  P_B5,
  P_F1,
  P_F2,
  P_F3,
  P_F4,
  P_F5,
  P_FB1,
  P_FB2,
  P_FF1,
  P_FF2,
  P_FG1,
  P_FG2,
  P_FHP,
  P_NMIX,
  P_NPOLE,
  P_NZERO,
  P_RD,
} from "./plan.ts";
import type { VoiceProfile } from "./voice.ts";

export interface PhoneDraft {
  readonly phoneme: Phoneme;
  readonly seconds: number;
  readonly moraIndex: number | null;
  readonly phraseIndex: number | null;
  readonly noteId: string | null;
  readonly sustainId: number | null;
  readonly articulation: Articulation;
  readonly gainDb: number;
  readonly rdOffset: number;
  readonly boundaryBefore: boolean;
  readonly boundaryAfter: boolean;
  readonly sustain: boolean;
  readonly emphasis: number;
}

export interface CompiledSegments {
  readonly segments: readonly PlannedSegment[];
  readonly frames: number;
  readonly boundaries: readonly number[];
}

const OFF = -120;

interface Context {
  readonly voice: VoiceProfile;
  readonly sampleRate: number;
}

type Triple = readonly [number, number, number];

function scaledFormants(context: Context, f: Triple): Triple {
  const s = context.voice.formantScale;
  return [f[0] * s, f[1] * s, f[2] * s];
}

function scaledBandwidths(context: Context, bw: Triple, factor: number = 1): Triple {
  const s = context.voice.bandwidthScale * factor;
  return [bw[0] * s, bw[1] * s, bw[2] * s];
}

class Params {
  public readonly values: Float64Array;

  private constructor(values: Float64Array) {
    this.values = values;
  }

  public static of(context: Context, spec: PhonemeSpec): Params {
    const values = new Float64Array(PARAM_COUNT);
    const f = scaledFormants(context, spec.f);
    const bw = scaledBandwidths(context, spec.bw);
    values[P_F1] = f[0];
    values[P_F2] = f[1];
    values[P_F3] = f[2];
    values[P_F4] = context.voice.f4 * context.voice.formantScale;
    values[P_F5] = context.voice.f5 * context.voice.formantScale;
    values[P_B1] = bw[0];
    values[P_B2] = bw[1];
    values[P_B3] = bw[2];
    values[P_B4] = 260 * context.voice.bandwidthScale;
    values[P_B5] = 320 * context.voice.bandwidthScale;
    values[P_AV] = OFF;
    values[P_AH] = OFF;
    values[P_AF] = OFF;
    values[P_RD] = context.voice.rd;
    values[P_NMIX] = 0;
    values[P_NPOLE] = 270 * context.voice.formantScale;
    values[P_NZERO] = 1000 * context.voice.formantScale;
    const fric = spec.fric ?? PHONEMES.s.fric;
    values[P_FF1] = fric?.f1 ?? 6000;
    values[P_FB1] = fric?.bw1 ?? 1000;
    values[P_FG1] = fric?.g1 ?? 1;
    values[P_FF2] = fric?.f2 ?? 8000;
    values[P_FB2] = fric?.bw2 ?? 2000;
    values[P_FG2] = fric?.g2 ?? 0.5;
    values[P_FHP] = fric?.hp ?? 3000;
    return new Params(values);
  }

  public clone(): Params {
    return new Params(new Float64Array(this.values));
  }

  public formants(f: Triple): this {
    this.values[P_F1] = f[0];
    this.values[P_F2] = f[1];
    this.values[P_F3] = f[2];
    return this;
  }

  public bandwidths(bw: Triple): this {
    this.values[P_B1] = bw[0];
    this.values[P_B2] = bw[1];
    this.values[P_B3] = bw[2];
    return this;
  }

  public set(index: number, value: number): this {
    this.values[index] = value;
    return this;
  }

  public fric(spec: FricationSpec): this {
    this.values[P_FF1] = spec.f1;
    this.values[P_FB1] = spec.bw1;
    this.values[P_FG1] = spec.g1;
    this.values[P_FF2] = spec.f2;
    this.values[P_FB2] = spec.bw2;
    this.values[P_FG2] = spec.g2;
    this.values[P_FHP] = spec.hp;
    return this;
  }

  public getFormants(): Triple {
    return [this.values[P_F1] ?? 0, this.values[P_F2] ?? 0, this.values[P_F3] ?? 0];
  }
}

function mixTriple(a: Triple, b: Triple, t: number): Triple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function locusLambda(phoneme: Phoneme): number {
  switch (phoneme) {
    case "k":
    case "ky":
    case "kw":
    case "g":
    case "gy":
    case "gw":
      return 0.55;
    case "p":
    case "py":
    case "b":
    case "by":
    case "m":
    case "my":
    case "f":
    case "v":
    case "w":
      return 0.42;
    case "h":
      return 1;
    default:
      return 0.5;
  }
}

function steadyFormants(context: Context, phoneme: Phoneme, next: Phoneme | undefined): Triple {
  const spec = PHONEMES[phoneme];
  if (spec.kind === "moraic-nasal") return scaledFormants(context, MORAIC_NASAL_TARGETS[moraicNasalPlace(next)].f);
  return scaledFormants(context, spec.f);
}

function nasalZeroFor(context: Context, phoneme: Phoneme, next: Phoneme | undefined): number {
  const spec = PHONEMES[phoneme];
  if (spec.kind === "moraic-nasal")
    return MORAIC_NASAL_TARGETS[moraicNasalPlace(next)].zero * context.voice.formantScale;
  return (spec.nasalZero > 0 ? spec.nasalZero : 1000) * context.voice.formantScale;
}

function vowelFormantsOf(context: Context, phoneme: Phoneme | undefined): Triple | undefined {
  if (phoneme === undefined) return undefined;
  const spec = PHONEMES[phoneme];
  if (spec.kind === "vowel" || spec.kind === "devoiced") return scaledFormants(context, spec.f);
  return undefined;
}

function onsetFormantsFrom(
  context: Context,
  previous: PhoneDraft | undefined,
  steady: Triple,
  phoneme: Phoneme,
): Triple {
  if (previous === undefined) return steady;
  const spec = PHONEMES[previous.phoneme];
  switch (spec.kind) {
    case "vowel":
    case "devoiced":
      return scaledFormants(context, spec.f);
    case "glide":
    case "nasal":
    case "moraic-nasal":
    case "flap":
      return steadyFormants(context, previous.phoneme, phoneme);
    case "stop":
    case "fricative":
    case "affricate": {
      if (spec.locus === null) return steady;
      const locus = scaledFormants(context, spec.locus);
      const lambda = locusLambda(previous.phoneme);
      const onset = mixTriple(locus, steady, lambda);
      return [Math.min(onset[0], steady[0]), onset[1], onset[2]];
    }
    default:
      return steady;
  }
}

function offsetFormantsToward(context: Context, next: PhoneDraft | undefined, steady: Triple): Triple {
  if (next === undefined) return steady;
  const spec = PHONEMES[next.phoneme];
  switch (spec.kind) {
    case "vowel":
    case "devoiced":
      return mixTriple(steady, scaledFormants(context, spec.f), 0.3);
    case "glide":
    case "nasal":
    case "moraic-nasal":
    case "flap":
      return mixTriple(steady, steadyFormants(context, next.phoneme, undefined), 0.5);
    case "stop":
    case "fricative":
    case "affricate": {
      if (spec.locus === null) return steady;
      const locus = scaledFormants(context, spec.locus);
      const mixed = mixTriple(steady, locus, 1 - locusLambda(next.phoneme));
      return [Math.min(mixed[0], steady[0]), mixed[1], mixed[2]];
    }
    default:
      return steady;
  }
}

function keyframe(at: number, params: Params): Keyframe {
  return { at, values: params.values };
}

function buildVowel(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  next: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const steady = scaledFormants(context, spec.f);
  const base = Params.of(context, spec);
  const gain = spec.av + draft.gainDb + draft.emphasis * 1.5;
  const rd = Math.max(0.3, Math.min(2.7, context.voice.rd + draft.rdOffset - draft.emphasis * 0.1));
  base.set(P_RD, rd).set(P_AH, context.voice.aspirationDb + draft.gainDb);
  const continuing = draft.articulation === "continue";
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const nextSpec = next === undefined ? undefined : PHONEMES[next.phoneme];
  const onsetFormants = continuing ? steady : onsetFormantsFrom(context, previous, steady, draft.phoneme);
  const prevIsVowel = prevSpec?.kind === "vowel";
  const onsetTime = continuing
    ? 0
    : Math.min(prevIsVowel ? 0.06 : (prevSpec?.transition ?? 0.03), Math.max(0.006, duration * 0.42));
  const anticipates = nextSpec !== undefined && nextSpec.kind !== "silence" && nextSpec.kind !== "closure";
  const offsetTime = anticipates && !draft.sustain ? Math.min(0.045, Math.max(0.004, duration * 0.33)) : 0;
  const offsetFormants = anticipates ? offsetFormantsToward(context, next, steady) : steady;
  const frames: Keyframe[] = [];
  const start = base.clone().formants(onsetFormants);
  let startAv = gain;
  if (continuing) startAv = gain;
  else if (draft.articulation === "rearticulate") startAv = gain - 18;
  else if (draft.boundaryBefore || previous === undefined || prevSpec?.kind === "silence") startAv = gain - 26;
  else if (prevSpec !== undefined && !prevSpec.voiced) startAv = gain - 10;
  else if (prevSpec?.kind === "closure") startAv = gain - 14;
  start.set(P_AV, startAv);
  if (prevSpec?.kind === "nasal" || prevSpec?.kind === "moraic-nasal") {
    start.set(P_NMIX, 0.55).set(P_NZERO, nasalZeroFor(context, previous?.phoneme ?? "n", draft.phoneme));
  }
  if (previous?.phoneme === "h" || previous?.phoneme === "hy") start.set(P_AH, context.voice.aspirationDb + 14);
  frames.push(keyframe(0, start));
  const attackTime = continuing
    ? 0
    : draft.articulation === "rearticulate"
      ? Math.min(0.05, duration * 0.4)
      : Math.min(0.018, duration * 0.3);
  if (attackTime > 0 && attackTime < onsetTime) {
    const attack = base
      .clone()
      .formants(mixTriple(onsetFormants, steady, attackTime / onsetTime))
      .set(P_AV, gain);
    if (prevSpec?.kind === "nasal" || prevSpec?.kind === "moraic-nasal") {
      attack
        .set(P_NMIX, 0.55 * (1 - attackTime / onsetTime))
        .set(P_NZERO, nasalZeroFor(context, previous?.phoneme ?? "n", draft.phoneme));
    }
    frames.push(keyframe(attackTime, attack));
  }
  const steadyStart = Math.max(onsetTime, attackTime);
  if (steadyStart > 0) frames.push(keyframe(steadyStart, base.clone().formants(steady).set(P_AV, gain)));
  const steadyEnd = Math.max(steadyStart, duration - offsetTime);
  if (steadyEnd > steadyStart + 1e-6) frames.push(keyframe(steadyEnd, base.clone().formants(steady).set(P_AV, gain)));
  const end = base.clone().formants(offsetFormants);
  let endAv = gain;
  if (draft.sustain) endAv = gain;
  else if (draft.boundaryAfter || next === undefined || nextSpec?.kind === "silence") endAv = gain - 12;
  else if (next?.articulation === "rearticulate") endAv = gain - 14;
  else if (nextSpec?.kind === "closure") endAv = gain - 10;
  else if (nextSpec !== undefined && !nextSpec.voiced) endAv = gain - 6;
  end.set(P_AV, endAv);
  if (next?.articulation === "rearticulate") end.set(P_RD, Math.min(2.7, rd + 0.3));
  if (nextSpec?.kind === "nasal" || nextSpec?.kind === "moraic-nasal") {
    end.set(P_NMIX, 0.5).set(P_NZERO, nasalZeroFor(context, next?.phoneme ?? "n", undefined));
  }
  if (draft.boundaryAfter && !draft.sustain) end.set(P_RD, Math.min(2.7, rd + 0.35));
  frames.push(keyframe(duration, end));
  return frames;
}

function buildDevoiced(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const base = Params.of(context, spec).bandwidths(scaledBandwidths(context, spec.bw, 1.6));
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const level = -13 + draft.gainDb;
  const frames: Keyframe[] = [];
  const start = base
    .clone()
    .set(P_AH, prevSpec?.kind === "fricative" || prevSpec?.kind === "affricate" ? level : level - 10);
  frames.push(keyframe(0, start));
  const rise = Math.min(0.012, duration * 0.3);
  frames.push(keyframe(rise, base.clone().set(P_AH, level)));
  const fall = Math.max(rise, duration - Math.min(0.02, duration * 0.3));
  frames.push(keyframe(fall, base.clone().set(P_AH, level)));
  frames.push(keyframe(duration, base.clone().set(P_AH, level - 16)));
  return frames;
}

function buildNasal(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  next: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const steady = steadyFormants(context, draft.phoneme, next?.phoneme);
  const zero = nasalZeroFor(context, draft.phoneme, next?.phoneme);
  const base = Params.of(context, spec)
    .formants(steady)
    .set(P_NMIX, 1)
    .set(P_NZERO, zero)
    .set(P_RD, Math.max(0.3, Math.min(2.7, context.voice.rd + draft.rdOffset)))
    .set(P_AH, context.voice.aspirationDb + draft.gainDb - 6);
  const gain = spec.av + draft.gainDb;
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const onsetFormants = onsetFormantsFrom(context, previous, steady, draft.phoneme);
  const onsetTime = Math.min(0.02, duration * 0.3);
  const frames: Keyframe[] = [];
  const startAv =
    draft.boundaryBefore || previous === undefined || prevSpec?.kind === "silence"
      ? gain - 24
      : prevSpec !== undefined && !prevSpec.voiced
        ? gain - 10
        : gain;
  frames.push(keyframe(0, base.clone().formants(onsetFormants).set(P_AV, startAv)));
  frames.push(keyframe(onsetTime, base.clone().set(P_AV, gain)));
  const nextSpec = next === undefined ? undefined : PHONEMES[next.phoneme];
  const endAv = draft.boundaryAfter || next === undefined || nextSpec?.kind === "silence" ? gain - 10 : gain;
  frames.push(keyframe(duration, base.clone().set(P_AV, endAv)));
  return frames;
}

function buildGlide(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  next: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const steady = scaledFormants(context, spec.f);
  const base = Params.of(context, spec)
    .formants(steady)
    .set(P_RD, Math.max(0.3, Math.min(2.7, context.voice.rd + draft.rdOffset)))
    .set(P_AH, context.voice.aspirationDb + draft.gainDb);
  const gain = spec.av + draft.gainDb;
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const onsetFormants = onsetFormantsFrom(context, previous, steady, draft.phoneme);
  const onsetTime = Math.min(0.025, duration * 0.4);
  const frames: Keyframe[] = [];
  const startAv =
    draft.boundaryBefore || previous === undefined || prevSpec?.kind === "silence"
      ? gain - 24
      : prevSpec !== undefined && !prevSpec.voiced
        ? gain - 8
        : gain;
  frames.push(keyframe(0, base.clone().formants(onsetFormants).set(P_AV, startAv)));
  frames.push(keyframe(onsetTime, base.clone().set(P_AV, gain)));
  const nextVowel = vowelFormantsOf(context, next?.phoneme);
  const end = base.clone().set(P_AV, gain);
  if (nextVowel !== undefined) end.formants(mixTriple(steady, nextVowel, 0.25));
  frames.push(keyframe(duration, end));
  return frames;
}

function buildFlap(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  next: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const steady = scaledFormants(context, spec.f);
  const base = Params.of(context, spec)
    .formants(steady)
    .set(P_RD, Math.max(0.3, Math.min(2.7, context.voice.rd + draft.rdOffset)))
    .set(P_AH, context.voice.aspirationDb + draft.gainDb);
  const gain = draft.gainDb;
  const prevVowel = vowelFormantsOf(context, previous?.phoneme);
  const nextVowel = vowelFormantsOf(context, next?.phoneme);
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const startAv = draft.boundaryBefore || previous === undefined || prevSpec?.kind === "silence" ? gain - 20 : gain - 2;
  const frames: Keyframe[] = [];
  frames.push(
    keyframe(
      0,
      base
        .clone()
        .formants(prevVowel === undefined ? steady : mixTriple(prevVowel, steady, 0.5))
        .set(P_AV, startAv),
    ),
  );
  frames.push(keyframe(duration * 0.35, base.clone().set(P_AV, spec.av + gain)));
  frames.push(keyframe(duration * 0.65, base.clone().set(P_AV, spec.av + gain)));
  frames.push(
    keyframe(
      duration,
      base
        .clone()
        .formants(nextVowel === undefined ? steady : mixTriple(steady, nextVowel, 0.5))
        .set(P_AV, gain - 2),
    ),
  );
  return frames;
}

function requiredFrication(phoneme: Phoneme): FricationSpec {
  const fric = PHONEMES[phoneme].fric;
  if (fric === null) throw new Error(`phoneme table: ${phoneme} has no frication spectrum`);
  return fric;
}

function burstSpecFor(phoneme: Phoneme, next: Phoneme | undefined): FricationSpec {
  const spec = PHONEMES[phoneme];
  const fallback = spec.fric ?? requiredFrication("k");
  if ((phoneme === "k" || phoneme === "g") && next !== undefined) {
    const vowel = next.toLowerCase();
    if (vowel === "i" || vowel === "e") return PHONEMES.ky.fric ?? fallback;
  }
  return fallback;
}

function buildStop(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  next: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const nominal = spec.closure + spec.burst + spec.aspiration;
  const scale = duration / nominal;
  const burstTime = Math.max(0.005, Math.min(spec.burst * scale, duration * 0.4));
  const aspirationTime = Math.max(0, Math.min(spec.aspiration * scale, duration - burstTime - 0.004));
  const closureTime = Math.max(0.002, duration - burstTime - aspirationTime);
  const locus = scaledFormants(context, spec.locus ?? spec.f);
  const nextVowel = vowelFormantsOf(context, next?.phoneme);
  const release = nextVowel === undefined ? locus : mixTriple(locus, nextVowel, locusLambda(draft.phoneme) * 0.6);
  const base = Params.of(context, spec)
    .formants(locus)
    .fric(burstSpecFor(draft.phoneme, next?.phoneme))
    .set(P_RD, Math.max(0.3, Math.min(2.7, context.voice.rd + draft.rdOffset)))
    .set(P_AH, OFF);
  const voiceBar = spec.voiced ? spec.av + draft.gainDb : OFF;
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const closure = base
    .clone()
    .bandwidths(scaledBandwidths(context, [150, 700, 700]))
    .set(P_AV, voiceBar);
  const frames: Keyframe[] = [];
  const startAv =
    prevSpec !== undefined && prevSpec.voiced && spec.voiced ? voiceBar : spec.voiced ? voiceBar - 8 : OFF;
  frames.push(keyframe(0, closure.clone().set(P_AV, startAv)));
  frames.push(
    keyframe(
      closureTime,
      closure
        .clone()
        .set(P_AV, voiceBar)
        .set(P_AF, spec.af + draft.gainDb + draft.emphasis * 2),
    ),
  );
  const afterBurst = base
    .clone()
    .formants(release)
    .set(P_AF, spec.af + draft.gainDb - 9);
  if (spec.voiced) afterBurst.set(P_AV, voiceBar + 6);
  else afterBurst.set(P_AH, -6 + draft.gainDb);
  frames.push(keyframe(closureTime + burstTime, afterBurst));
  const end = base.clone().formants(release).set(P_AF, OFF);
  if (spec.voiced) end.set(P_AV, draft.gainDb - 4);
  else end.set(P_AH, -10 + draft.gainDb);
  frames.push(keyframe(duration, end));
  return frames;
}

function buildFricative(
  context: Context,
  draft: PhoneDraft,
  previous: PhoneDraft | undefined,
  next: PhoneDraft | undefined,
  duration: number,
): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const locus = scaledFormants(context, spec.locus ?? spec.f);
  const nextVowel = vowelFormantsOf(context, next?.phoneme);
  const isH = draft.phoneme === "h";
  const shaped = isH && nextVowel !== undefined ? nextVowel : locus;
  const base = Params.of(context, spec)
    .formants(shaped)
    .set(P_RD, Math.max(0.3, Math.min(2.7, context.voice.rd + draft.rdOffset)))
    .set(P_AH, OFF);
  if (spec.fric !== null) base.fric(spec.fric);
  if (isH) base.bandwidths(scaledBandwidths(context, PHONEMES.a.bw, 1.7));
  const level = spec.af + draft.gainDb + draft.emphasis;
  const voiced = spec.voiced ? spec.av + draft.gainDb : OFF;
  const frames: Keyframe[] = [];
  const closureTime = spec.closure > 0 ? Math.min(spec.closure * (duration / spec.duration), duration * 0.45) : 0;
  const prevSpec = previous === undefined ? undefined : PHONEMES[previous.phoneme];
  const rise = Math.min(0.015, Math.max(0.003, (duration - closureTime) * 0.25));
  const fall = Math.min(0.02, Math.max(0.003, (duration - closureTime) * 0.25));
  const noiseParam = isH ? P_AH : P_AF;
  const hLevel = -26 + draft.gainDb + draft.emphasis;
  const target = isH ? hLevel : level;
  if (closureTime > 0) {
    const closure = base.clone().bandwidths(scaledBandwidths(context, [150, 700, 700]));
    frames.push(
      keyframe(
        0,
        closure.clone().set(P_AV, spec.voiced ? (prevSpec?.voiced === true ? voiced - 6 : voiced - 12) : OFF),
      ),
    );
    frames.push(
      keyframe(
        closureTime,
        closure
          .clone()
          .set(P_AV, spec.voiced ? voiced - 4 : OFF)
          .set(noiseParam, target + 2),
      ),
    );
  } else {
    frames.push(
      keyframe(
        0,
        base
          .clone()
          .set(noiseParam, target - 12)
          .set(P_AV, spec.voiced ? voiced - 8 : OFF),
      ),
    );
  }
  const plateauStart = closureTime + rise;
  frames.push(keyframe(Math.min(plateauStart, duration), base.clone().set(noiseParam, target).set(P_AV, voiced)));
  const plateauEnd = Math.max(plateauStart, duration - fall);
  if (plateauEnd > plateauStart + 1e-6)
    frames.push(keyframe(plateauEnd, base.clone().set(noiseParam, target).set(P_AV, voiced)));
  const end = base
    .clone()
    .set(noiseParam, target - 10)
    .set(P_AV, spec.voiced ? voiced - 2 : OFF);
  if (nextVowel !== undefined && !isH) end.formants(mixTriple(locus, nextVowel, 0.35));
  frames.push(keyframe(duration, end));
  return frames;
}

function buildClosure(context: Context, draft: PhoneDraft, next: PhoneDraft | undefined, duration: number): Keyframe[] {
  const spec = PHONEMES[draft.phoneme];
  const nextSpec = next === undefined ? undefined : PHONEMES[next.phoneme];
  const base = Params.of(context, spec);
  if (
    nextSpec !== undefined &&
    (nextSpec.kind === "fricative" || nextSpec.kind === "affricate") &&
    nextSpec.fric !== null &&
    next?.phoneme !== "h"
  ) {
    const level = nextSpec.af + draft.gainDb - 3;
    const shaped = base
      .clone()
      .fric(nextSpec.fric)
      .formants(scaledFormants(context, nextSpec.locus ?? nextSpec.f));
    const isH = false;
    const param = isH ? P_AH : P_AF;
    return [
      keyframe(0, shaped.clone().set(param, level - 12)),
      keyframe(Math.min(0.015, duration * 0.3), shaped.clone().set(param, level)),
      keyframe(duration, shaped.clone().set(param, level)),
    ];
  }
  const silent = base.clone().set(P_AV, OFF).set(P_AF, OFF).set(P_AH, OFF);
  return [keyframe(0, silent), keyframe(duration, silent.clone())];
}

function buildSilence(context: Context, draft: PhoneDraft, duration: number): Keyframe[] {
  const base = Params.of(context, PHONEMES[draft.phoneme]).set(P_AV, OFF).set(P_AF, OFF).set(P_AH, OFF);
  return [keyframe(0, base), keyframe(duration, base.clone())];
}

function buildKeyframes(context: Context, drafts: readonly PhoneDraft[], index: number, duration: number): Keyframe[] {
  const draft = drafts[index];
  if (draft === undefined) return [];
  const previous = drafts[index - 1];
  const next = drafts[index + 1];
  const spec = PHONEMES[draft.phoneme];
  switch (spec.kind) {
    case "vowel":
      return buildVowel(context, draft, previous, next, duration);
    case "devoiced":
      return buildDevoiced(context, draft, previous, duration);
    case "nasal":
    case "moraic-nasal":
      return buildNasal(context, draft, previous, next, duration);
    case "glide":
      return buildGlide(context, draft, previous, next, duration);
    case "flap":
      return buildFlap(context, draft, previous, next, duration);
    case "stop":
      return buildStop(context, draft, previous, next, duration);
    case "fricative":
    case "affricate":
      return buildFricative(context, draft, previous, next, duration);
    case "closure":
      return buildClosure(context, draft, next, duration);
    default:
      return buildSilence(context, draft, duration);
  }
}

function sanitize(frames: Keyframe[], duration: number): Keyframe[] {
  const sorted = frames
    .map((frame) => ({ at: Math.min(duration, Math.max(0, frame.at)), values: frame.values }))
    .sort((a, b) => a.at - b.at);
  const out: Keyframe[] = [];
  for (const frame of sorted) {
    const last = out.at(-1);
    if (last !== undefined && frame.at - last.at < 1e-6) {
      out[out.length - 1] = frame;
      continue;
    }
    out.push(frame);
  }
  return out;
}

export function compileSegments(
  drafts: readonly PhoneDraft[],
  voice: VoiceProfile,
  sampleRate: number,
): CompiledSegments {
  const context: Context = { voice, sampleRate };
  const segments: PlannedSegment[] = [];
  const boundaries: number[] = [0];
  let cursor = 0;
  let seconds = 0;
  const kept: { draft: PhoneDraft; start: number; end: number }[] = [];
  for (const draft of drafts) {
    seconds += Math.max(0, draft.seconds);
    const end = Math.round(seconds * sampleRate);
    if (end <= cursor) continue;
    kept.push({ draft, start: cursor, end });
    cursor = end;
    boundaries.push(cursor);
  }
  const keptDrafts = kept.map((entry) => entry.draft);
  for (const [index, entry] of kept.entries()) {
    const duration = (entry.end - entry.start) / sampleRate;
    const frames = sanitize(buildKeyframes(context, keptDrafts, index, duration), duration);
    const spec = PHONEMES[entry.draft.phoneme];
    segments.push({
      id: index,
      phoneme: entry.draft.phoneme,
      start: entry.start,
      end: entry.end,
      voiced: spec.voiced,
      keyframes: frames,
      moraIndex: entry.draft.moraIndex,
      phraseIndex: entry.draft.phraseIndex,
      noteId: entry.draft.noteId,
      sustainId: entry.draft.sustainId,
      articulation: entry.draft.articulation,
    });
  }
  return { segments, frames: cursor, boundaries };
}

export function phoneDraft(phoneme: Phoneme, seconds: number, partial: Partial<PhoneDraft> = {}): PhoneDraft {
  return {
    phoneme,
    seconds,
    moraIndex: null,
    phraseIndex: null,
    noteId: null,
    sustainId: null,
    articulation: "onset",
    gainDb: 0,
    rdOffset: 0,
    boundaryBefore: false,
    boundaryAfter: false,
    sustain: false,
    emphasis: 0,
    ...partial,
  };
}

export function isVowelOrDevoiced(phoneme: Phoneme): boolean {
  return isVowelPhoneme(phoneme) || PHONEMES[phoneme].kind === "devoiced";
}

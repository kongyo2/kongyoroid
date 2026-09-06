import { checkAbort, invalid } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import type { Consonant, KanaUnit, Phoneme, UnvoicedVowel, Vowel } from "./mora.ts";
import { kanaToUnits } from "./mora.ts";
import type { AccentPhrase, NotationMora } from "./notation.ts";
import { parseKanaNotation } from "./notation.ts";
import { midiToHz } from "./pitch.ts";
import type { OperationOptions, ResolvedRequest, ResolvedSong, ResolvedSpeech } from "./types.ts";
import { encodeWav } from "./wav.ts";

type TimbreKind = "vowel" | "nasal" | "stop" | "fricative" | "affricate" | "glide" | "flap" | "silence";

interface Timbre {
  readonly f: readonly [number, number, number, number];
  readonly bw: readonly [number, number, number, number];
  readonly amp: readonly [number, number, number, number];
  readonly voiced: number;
  readonly noise: number;
  readonly level: number;
  readonly kind: TimbreKind;
  readonly duration: number;
}

function vowel(f: readonly [number, number, number, number], amp: readonly [number, number, number, number]): Timbre {
  return { f, bw: [80, 110, 170, 230], amp, voiced: 1, noise: 0.02, level: 1, kind: "vowel", duration: 0.1 };
}

function whisper(base: Timbre): Timbre {
  return { ...base, voiced: 0, noise: 1, level: 0.22, bw: [140, 180, 240, 300] };
}

function nasal(f: readonly [number, number, number, number], duration: number): Timbre {
  return {
    f,
    bw: [90, 220, 280, 320],
    amp: [1, 0.22, 0.09, 0.03],
    voiced: 1,
    noise: 0.01,
    level: 0.72,
    kind: "nasal",
    duration,
  };
}

function stop(
  f: readonly [number, number, number, number],
  amp: readonly [number, number, number, number],
  voiced: number,
  level: number,
  duration: number,
): Timbre {
  return { f, bw: [220, 320, 420, 520], amp, voiced, noise: 1, level, kind: "stop", duration };
}

function fricative(
  f: readonly [number, number, number, number],
  bw: readonly [number, number, number, number],
  amp: readonly [number, number, number, number],
  voiced: number,
  level: number,
  duration: number,
  kind: "fricative" | "affricate" = "fricative",
): Timbre {
  return { f, bw, amp, voiced, noise: 1, level, kind, duration };
}

function glide(f: readonly [number, number, number, number], amp: readonly [number, number, number, number]): Timbre {
  return { f, bw: [70, 120, 180, 240], amp, voiced: 1, noise: 0.02, level: 0.82, kind: "glide", duration: 0.045 };
}

function palatal(base: Timbre): Timbre {
  return { ...base, f: [base.f[0], Math.max(base.f[1], 2100), Math.max(base.f[2], 2900), base.f[3]] };
}

function labial(base: Timbre): Timbre {
  return { ...base, f: [base.f[0], Math.min(base.f[1], 900), base.f[2], base.f[3]] };
}

const A = vowel([750, 1200, 2600, 3500], [1, 0.5, 0.25, 0.1]);
const I = vowel([290, 2250, 3000, 3600], [1, 0.32, 0.2, 0.08]);
const U = vowel([330, 1300, 2350, 3400], [1, 0.28, 0.16, 0.06]);
const E = vowel([500, 1900, 2550, 3500], [1, 0.45, 0.25, 0.1]);
const O = vowel([520, 900, 2500, 3400], [1, 0.45, 0.18, 0.07]);
const SILENCE: Timbre = {
  f: [500, 1500, 2500, 3500],
  bw: [200, 200, 200, 200],
  amp: [0, 0, 0, 0],
  voiced: 0,
  noise: 0,
  level: 0,
  kind: "silence",
  duration: 0.08,
};
const K = stop([1500, 2500, 3500, 4500], [0.4, 1, 0.6, 0.3], 0, 0.7, 0.065);
const G = stop([400, 1800, 2600, 3400], [0.7, 1, 0.5, 0.25], 0.45, 0.65, 0.05);
const T = stop([1000, 3500, 4500, 5500], [0.3, 1, 0.7, 0.4], 0, 0.7, 0.06);
const D = stop([350, 2000, 3000, 4000], [0.8, 1, 0.5, 0.25], 0.5, 0.65, 0.045);
const P = stop([600, 1300, 2500, 3500], [1, 0.6, 0.3, 0.15], 0, 0.55, 0.065);
const B = stop([300, 1000, 2300, 3300], [1, 0.6, 0.3, 0.15], 0.55, 0.6, 0.045);
const S = fricative([4500, 6000, 7500, 9000], [800, 900, 1000, 1200], [0.6, 1, 0.8, 0.5], 0, 0.45, 0.085);
const SH = fricative([2600, 3800, 5200, 7000], [500, 600, 800, 1000], [0.8, 1, 0.7, 0.4], 0, 0.5, 0.085);
const H = fricative([900, 1900, 2800, 3600], [300, 400, 500, 600], [0.7, 0.8, 0.5, 0.3], 0, 0.32, 0.07);
const F = fricative([1100, 2100, 3200, 4500], [600, 700, 800, 900], [0.7, 0.8, 0.6, 0.4], 0, 0.3, 0.075);
const NASAL_N = nasal([280, 1300, 2300, 3300], 0.055);
const M = nasal([250, 950, 2200, 3200], 0.06);
const R: Timbre = {
  f: [380, 1400, 2300, 3300],
  bw: [100, 150, 200, 250],
  amp: [1, 0.45, 0.2, 0.08],
  voiced: 1,
  noise: 0.02,
  level: 0.6,
  kind: "flap",
  duration: 0.026,
};
const Y = glide([280, 2100, 2900, 3500], [1, 0.35, 0.2, 0.08]);
const W = glide([300, 700, 2300, 3300], [1, 0.4, 0.15, 0.06]);

const TIMBRES: Readonly<Record<Phoneme, Timbre>> = {
  a: A,
  i: I,
  u: U,
  e: E,
  o: O,
  A: whisper(A),
  I: whisper(I),
  U: whisper(U),
  E: whisper(E),
  O: whisper(O),
  N: nasal([280, 1100, 2300, 3300], 0.085),
  cl: SILENCE,
  pau: SILENCE,
  k: K,
  ky: palatal(K),
  kw: labial(K),
  g: G,
  gy: palatal(G),
  gw: labial(G),
  t: T,
  ty: palatal(T),
  d: D,
  dy: palatal(D),
  p: P,
  py: palatal(P),
  b: B,
  by: palatal(B),
  s: S,
  sh: SH,
  z: fricative(S.f, S.bw, S.amp, 0.6, 0.5, 0.07),
  j: fricative(SH.f, SH.bw, SH.amp, 0.6, 0.5, 0.075, "affricate"),
  ch: fricative(SH.f, SH.bw, SH.amp, 0, 0.55, 0.085, "affricate"),
  ts: fricative(S.f, S.bw, S.amp, 0, 0.5, 0.085, "affricate"),
  h: H,
  hy: palatal(H),
  f: F,
  v: fricative(F.f, F.bw, F.amp, 0.7, 0.45, 0.06),
  n: NASAL_N,
  ny: palatal(NASAL_N),
  m: M,
  my: palatal(M),
  r: R,
  ry: palatal(R),
  y: Y,
  w: W,
};

const PALATALIZED: ReadonlySet<Consonant> = new Set(["ky", "gy", "ty", "dy", "py", "by", "hy", "ny", "my", "ry"]);
const LABIALIZED: ReadonlySet<Consonant> = new Set(["kw", "gw"]);

export interface Segment {
  readonly phoneme: Phoneme;
  readonly frames: number;
  readonly f0Start: number;
  readonly f0End: number;
  readonly amplitude: number;
  readonly vibrato: boolean;
  readonly rampIn: boolean;
  readonly rampOut: boolean;
}

export interface FormantPlan {
  readonly sampleRate: number;
  readonly seed: number;
  readonly volume: number;
  readonly vibratoDepth: number;
  readonly vibratoRate: number;
  readonly segments: readonly Segment[];
  readonly frames: number;
}

interface Draft {
  phoneme: Phoneme;
  seconds: number;
  f0Start: number;
  f0End: number;
  amplitude: number;
  vibrato: boolean;
}

const BASE_F0 = 150;

function isVoicedSustain(phoneme: Phoneme): boolean {
  const kind = TIMBRES[phoneme].kind;
  return (kind === "vowel" || kind === "nasal" || kind === "glide" || kind === "flap") && TIMBRES[phoneme].voiced > 0;
}

function finalize(
  drafts: readonly Draft[],
  sampleRate: number,
  plan: Omit<FormantPlan, "segments" | "frames">,
): FormantPlan {
  const segments: Segment[] = [];
  let cursor = 0;
  let seconds = 0;
  for (const [index, draft] of drafts.entries()) {
    seconds += draft.seconds;
    const end = Math.round(seconds * sampleRate);
    const frames = end - cursor;
    if (frames <= 0) continue;
    cursor = end;
    const previous = drafts[index - 1];
    const next = drafts[index + 1];
    segments.push({
      phoneme: draft.phoneme,
      frames,
      f0Start: draft.f0Start,
      f0End: draft.f0End,
      amplitude: draft.amplitude,
      vibrato: draft.vibrato,
      rampIn: previous === undefined || !isVoicedSustain(previous.phoneme),
      rampOut: next === undefined || !isVoicedSustain(next.phoneme),
    });
  }
  if (cursor > LIMITS.audioSeconds * sampleRate) {
    invalid("$", `Audio would last ${(cursor / sampleRate).toFixed(1)} s; the limit is ${LIMITS.audioSeconds} s.`);
  }
  return { ...plan, segments, frames: cursor };
}

function consonantDrafts(consonant: Consonant | null, seconds: number, f0Start: number, f0End: number): Draft[] {
  if (consonant === null) return [];
  const out: Draft[] = [{ phoneme: consonant, seconds, f0Start, f0End, amplitude: 1, vibrato: false }];
  if (PALATALIZED.has(consonant))
    out.push({ phoneme: "y", seconds: 0.03, f0Start: f0End, f0End, amplitude: 0.9, vibrato: false });
  if (LABIALIZED.has(consonant))
    out.push({ phoneme: "w", seconds: 0.03, f0Start: f0End, f0End, amplitude: 0.9, vibrato: false });
  return out;
}

function shapePitch(hz: number, pitch: number, intonation: number): number {
  const mean = Math.log(BASE_F0 * 1.08);
  const scaled = mean + (Math.log(hz) - mean) * intonation;
  return Math.exp(scaled * 2 ** pitch);
}

interface HeuristicPhrase {
  readonly phrase: AccentPhrase;
  readonly pauseWeight: number;
}

function heuristicPhrases(units: readonly KanaUnit[]): readonly HeuristicPhrase[] {
  const phrases: HeuristicPhrase[] = [];
  let moras: NotationMora[] = [];
  const flush = (pauseWeight: number, interrogative: boolean): void => {
    if (moras.length === 0) {
      const last = phrases.at(-1);
      if (last !== undefined && pauseWeight > 0) {
        phrases[phrases.length - 1] = {
          phrase: { ...last.phrase, pause: true, interrogative: last.phrase.interrogative || interrogative },
          pauseWeight: last.pauseWeight + pauseWeight,
        };
      }
      return;
    }
    phrases.push({ phrase: { moras, accent: moras.length, pause: pauseWeight > 0, interrogative }, pauseWeight });
    moras = [];
  };
  for (const unit of units) {
    if (unit.kind === "pause") {
      flush(unit.weight, unit.text === "?");
      continue;
    }
    moras.push({ text: unit.text, consonant: unit.consonant, vowel: unit.vowel });
    if (moras.length >= 7) flush(0, false);
  }
  flush(0, false);
  return phrases;
}

export function planSpeech(request: ResolvedSpeech, sampleRate: number): FormantPlan {
  const phrases: readonly HeuristicPhrase[] =
    request.kana === undefined
      ? heuristicPhrases(kanaToUnits(request.text, "$.text"))
      : parseKanaNotation(request.kana, "$.kana").map((phrase) => ({ phrase, pauseWeight: 1 }));
  if (phrases.length === 0) invalid("$.text", "Text contains no readable kana.");
  const speed = request.speed;
  const drafts: Draft[] = [];
  const rest = (seconds: number): void => {
    drafts.push({ phoneme: "pau", seconds, f0Start: 0, f0End: 0, amplitude: 0, vibrato: false });
  };
  rest(request.prePause);
  let previousHz = shapePitch(BASE_F0, request.pitch, request.intonation);
  for (const [phraseIndex, { phrase, pauseWeight }] of phrases.entries()) {
    const declination = Math.max(0.85, 1 - 0.04 * phraseIndex);
    const count = phrase.moras.length;
    for (const [moraIndex, mora] of phrase.moras.entries()) {
      const position = moraIndex + 1;
      const high = phrase.accent === 1 ? position === 1 : position >= 2 && position <= phrase.accent;
      const slope = high ? 1.22 - (0.1 * moraIndex) / Math.max(1, count - 1) : 0.97;
      const targetHz = shapePitch(BASE_F0 * slope * declination, request.pitch, request.intonation);
      const last = moraIndex === count - 1;
      const endHz = phrase.interrogative && last ? targetHz * 1.35 : targetHz * 0.985;
      const timbre = TIMBRES[mora.vowel];
      const consonant = mora.consonant;
      const consonantSeconds = consonant === null ? 0 : TIMBRES[consonant].duration / speed;
      drafts.push(...consonantDrafts(consonant, consonantSeconds, previousHz, targetHz));
      const vowelSeconds =
        (mora.vowel === "cl"
          ? 0.08
          : mora.vowel === "N"
            ? 0.085
            : timbre.kind === "vowel" && timbre.voiced === 0
              ? 0.07
              : consonant === null
                ? 0.12
                : 0.095) / speed;
      drafts.push({
        phoneme: mora.vowel,
        seconds: vowelSeconds,
        f0Start: targetHz,
        f0End: endHz,
        amplitude: 1,
        vibrato: false,
      });
      previousHz = endHz;
    }
    if (phrase.pause) {
      const base = request.pauseLength ?? 0.18 * pauseWeight;
      rest((base * request.pauseScale) / speed);
    } else if (phraseIndex < phrases.length - 1) {
      rest(0.02 / speed);
    }
  }
  rest(request.postPause);
  return finalize(drafts, sampleRate, {
    sampleRate,
    seed: request.seed,
    volume: request.volume,
    vibratoDepth: 0,
    vibratoRate: 0,
  });
}

export function planSong(request: ResolvedSong, sampleRate: number): FormantPlan {
  const secondsPerBeat = 60 / request.tempo;
  const notes = request.notes;
  const drafts: Draft[] = [];
  const rest = (seconds: number): void => {
    drafts.push({ phoneme: "pau", seconds, f0Start: 0, f0End: 0, amplitude: 0, vibrato: false });
  };
  const leadIn = notes[0]?.key === null ? 0 : request.leadIn;
  const durations = notes.map((note) => note.beats * secondsPerBeat);
  const consonantOf = (index: number): { consonant: Consonant | null; seconds: number } => {
    const note = notes[index];
    if (note === undefined || note.key === null) return { consonant: null, seconds: 0 };
    const units = kanaToUnits(note.lyric, `$.notes[${index}].lyric`);
    const unit = units[0];
    if (unit === undefined || unit.kind !== "mora" || unit.consonant === null) return { consonant: null, seconds: 0 };
    const nominal =
      TIMBRES[unit.consonant].duration + (PALATALIZED.has(unit.consonant) || LABIALIZED.has(unit.consonant) ? 0.03 : 0);
    const available = index === 0 ? leadIn : (durations[index - 1] ?? 0) * 0.4;
    return { consonant: unit.consonant, seconds: Math.min(nominal, available) };
  };
  let previousHz = 0;
  const first = consonantOf(0);
  if (leadIn > 0) rest(leadIn - first.seconds);
  for (const [index, note] of notes.entries()) {
    const duration = durations[index] ?? 0;
    const own = consonantOf(index);
    const following = consonantOf(index + 1);
    if (note.key === null) {
      rest(Math.max(0, duration - following.seconds));
      continue;
    }
    const hz = midiToHz(note.key);
    const vowelUnit = kanaToUnits(note.lyric, `$.notes[${index}].lyric`)[0];
    const vowelPhoneme: Vowel | UnvoicedVowel =
      vowelUnit !== undefined && vowelUnit.kind === "mora" ? vowelUnit.vowel : "a";
    if (own.consonant !== null && own.seconds > 0) {
      const glideSeconds =
        PALATALIZED.has(own.consonant) || LABIALIZED.has(own.consonant) ? Math.min(0.03, own.seconds * 0.4) : 0;
      const parts = consonantDrafts(own.consonant, own.seconds - glideSeconds, previousHz || hz, hz);
      for (const part of parts) if (part.phoneme === "y" || part.phoneme === "w") part.seconds = glideSeconds;
      drafts.push(...parts);
    }
    const vowelSeconds = Math.max(0.01, duration - following.seconds);
    const previous = drafts.at(-1);
    if (
      previous !== undefined &&
      previous.phoneme === vowelPhoneme &&
      previous.vibrato &&
      previous.f0End === hz &&
      own.consonant === null
    ) {
      previous.seconds += vowelSeconds;
    } else {
      drafts.push({
        phoneme: vowelPhoneme,
        seconds: vowelSeconds,
        f0Start: previousHz === 0 ? hz : previousHz,
        f0End: hz,
        amplitude: 1,
        vibrato: true,
      });
    }
    previousHz = hz;
  }
  if (notes.at(-1)?.key !== null) rest(request.leadOut);
  return finalize(drafts, sampleRate, {
    sampleRate,
    seed: request.seed,
    volume: request.volume,
    vibratoDepth: request.vibratoDepth ?? 25,
    vibratoRate: request.vibratoRate,
  });
}

class Resonator {
  private a1: number = 0;
  private a2: number = 0;
  private b: number = 0;
  private y1: number = 0;
  private y2: number = 0;
  private x1: number = 0;
  private x2: number = 0;

  public tune(frequency: number, width: number, rate: number): void {
    const radius = Math.exp((-Math.PI * width) / rate);
    this.a1 = 2 * radius * Math.cos((2 * Math.PI * Math.min(rate * 0.45, frequency)) / rate);
    this.a2 = radius * radius;
    this.b = (1 - radius) * 0.5;
  }

  public step(x: number): number {
    const y = this.b * (x - this.x2) + this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function polyBlep(t: number, step: number): number {
  if (t < step) {
    const x = t / step;
    return x + x - x * x - 1;
  }
  if (t > 1 - step) {
    const x = (t - 1) / step;
    return x * x + x + x + 1;
  }
  return 0;
}

const CONTROL = 32;

class FormantRenderer {
  private readonly plan: FormantPlan;
  private readonly filters: readonly Resonator[] = [new Resonator(), new Resonator(), new Resonator(), new Resonator()];
  private readonly frequencies: Float64Array = new Float64Array([500, 1500, 2500, 3500]);
  private readonly widths: Float64Array = new Float64Array([100, 150, 200, 250]);
  private readonly gains: Float64Array = new Float64Array(4);
  private segmentIndex: number = 0;
  private segmentStart: number = 0;
  private cursor: number = 0;
  private phase: number = 0;
  private random: number;
  private source: number = 0;
  private dcIn: number = 0;
  private dcOut: number = 0;
  private pitchStep: number = 0;
  private voiced: number = 0;
  private noise: number = 0;
  private level: number = 0;
  private envelope: number = 0;
  private lastHz: number = BASE_F0;

  public constructor(plan: FormantPlan) {
    this.plan = plan;
    this.random = plan.seed >>> 0 || 1;
  }

  private nextRandom(): number {
    let r = this.random;
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    this.random = r >>> 0;
    return this.random / 2_147_483_648 - 1;
  }

  private control(segment: Segment, local: number, rate: number): void {
    const timbre = TIMBRES[segment.phoneme];
    const progress = local / Math.max(1, segment.frames);
    const seconds = local / rate;
    const tau = timbre.kind === "vowel" || timbre.kind === "nasal" || timbre.kind === "glide" ? 0.014 : 0.006;
    const mix = 1 - Math.exp(-CONTROL / (rate * tau));
    for (let band = 0; band < 4; band++) {
      const f = this.frequencies[band] ?? 500;
      const w = this.widths[band] ?? 100;
      const targetF = timbre.f[band] ?? f;
      const targetW = timbre.bw[band] ?? w;
      const nextF = f + (targetF - f) * mix;
      const nextW = w + (targetW - w) * mix;
      this.frequencies[band] = nextF;
      this.widths[band] = nextW;
      this.gains[band] = timbre.amp[band] ?? 0;
      this.filters[band]?.tune(nextF, nextW, rate);
    }
    let hz =
      segment.f0Start > 0 && segment.f0End > 0
        ? segment.f0Start + (segment.f0End - segment.f0Start) * Math.min(1, progress * 3)
        : this.lastHz;
    if (segment.f0End > 0) this.lastHz = segment.f0End;
    if (segment.vibrato && this.plan.vibratoDepth > 0) {
      const fade = Math.min(1, Math.max(0, (seconds - 0.12) / 0.18));
      const cents =
        this.plan.vibratoDepth * fade * Math.sin(2 * Math.PI * this.plan.vibratoRate * (this.cursor / rate));
      hz *= 2 ** (cents / 1200);
    }
    hz *= 1 + 0.004 * this.nextRandom();
    this.pitchStep = hz / rate;
    let voiced = timbre.voiced;
    let noise = timbre.noise;
    let level = timbre.level;
    switch (timbre.kind) {
      case "stop": {
        const closure = 0.6;
        if (progress < closure) {
          noise = 0;
          voiced = timbre.voiced > 0 ? 0.12 : 0;
          level = timbre.voiced > 0 ? 0.3 : 0;
        } else {
          const burst = (progress - closure) / (1 - closure);
          noise = Math.exp(-burst * 5);
          voiced = timbre.voiced * Math.min(1, burst * 3);
        }
        break;
      }
      case "affricate":
        if (progress < 0.3) {
          noise = 0;
          voiced = timbre.voiced * 0.2;
          level *= 0.3;
        }
        break;
      case "flap":
        level *= 0.5 + 0.5 * Math.abs(Math.cos(Math.PI * progress));
        break;
      default:
        break;
    }
    this.voiced = voiced;
    this.noise = noise;
    this.level = level * segment.amplitude;
  }

  public fill(buffer: Float32Array): void {
    const plan = this.plan;
    const rate = plan.sampleRate;
    const attack = Math.max(1, Math.round(rate * 0.008));
    const release = Math.max(1, Math.round(rate * 0.014));
    for (let i = 0; i < buffer.length; i++, this.cursor++) {
      let segment = plan.segments[this.segmentIndex];
      while (segment !== undefined && this.cursor >= this.segmentStart + segment.frames) {
        this.segmentStart += segment.frames;
        this.segmentIndex += 1;
        segment = plan.segments[this.segmentIndex];
      }
      if (segment === undefined) {
        buffer[i] = 0;
        continue;
      }
      const local = this.cursor - this.segmentStart;
      if (local % CONTROL === 0 || local === 0) this.control(segment, local, rate);
      const saw = 2 * this.phase - 1 - polyBlep(this.phase, this.pitchStep);
      this.phase += this.pitchStep;
      this.phase -= Math.floor(this.phase);
      this.source += 0.3 * (saw - this.source);
      const excitation = this.source * this.voiced + this.nextRandom() * this.noise * 0.6;
      let filtered = 0;
      for (let band = 0; band < 4; band++) {
        filtered += (this.gains[band] ?? 0) * (this.filters[band]?.step(excitation) ?? 0);
      }
      const dc = filtered - this.dcIn + 0.995 * this.dcOut;
      this.dcIn = filtered;
      this.dcOut = dc;
      const target =
        (segment.rampIn && local < attack ? local / attack : 1) *
        (segment.rampOut && segment.frames - local < release ? (segment.frames - local) / release : 1);
      this.envelope += 0.2 * (target - this.envelope);
      buffer[i] = Math.tanh(dc * 7) * this.level * this.envelope;
    }
  }
}

const LEVEL_TARGET: Readonly<Record<"vowel" | "nasal" | "glide", number>> = { vowel: 0.3, nasal: 0.22, glide: 0.26 };

function levelGain(segment: Segment, block: Float32Array, sung: boolean): number {
  const kind = TIMBRES[segment.phoneme].kind;
  if ((kind !== "vowel" && kind !== "nasal" && kind !== "glide") || TIMBRES[segment.phoneme].voiced === 0) return 1;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += (block[i] ?? 0) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, block.length));
  if (rms < 1e-4) return 1;
  const ratio = (LEVEL_TARGET[kind] * segment.amplitude) / rms;
  return Math.min(2, Math.max(0.5, ratio ** (sung ? 0.85 : 0.5)));
}

export interface StreamOptions extends OperationOptions {}

export function* renderChunks(plan: FormantPlan, options: StreamOptions = {}): Generator<Float32Array, void, void> {
  const renderer = new FormantRenderer(plan);
  const ramp = Math.max(1, Math.round(plan.sampleRate * 0.006));
  const sung = plan.vibratoDepth > 0;
  let previousGain = 1;
  for (const segment of plan.segments) {
    checkAbort(options.signal);
    const block = new Float32Array(segment.frames);
    renderer.fill(block);
    const gain = levelGain(segment, block, sung);
    for (let i = 0; i < block.length; i++) {
      const blend = i < ramp ? i / ramp : 1;
      const g = previousGain + (gain - previousGain) * blend;
      const value = (block[i] ?? 0) * g * plan.volume;
      block[i] = plan.volume > 1 ? Math.tanh(value) : value;
    }
    previousGain = gain;
    yield block;
  }
}

export function renderPlan(plan: FormantPlan, options: StreamOptions = {}): Float32Array {
  const pcm = new Float32Array(plan.frames);
  let offset = 0;
  for (const chunk of renderChunks(plan, options)) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return pcm;
}

export function planRequest(request: ResolvedRequest, sampleRate: number): FormantPlan {
  return request.kind === "speech" ? planSpeech(request, sampleRate) : planSong(request, sampleRate);
}

export function renderFormant(
  request: ResolvedRequest,
  sampleRate: number,
  options: OperationOptions = {},
): Uint8Array {
  return encodeWav(renderPlan(planRequest(request, sampleRate), options), sampleRate);
}

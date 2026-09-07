import type { Consonant, Phoneme, Vowel } from "../text/mora.ts";

export type PhonemeKind =
  | "vowel"
  | "devoiced"
  | "nasal"
  | "moraic-nasal"
  | "stop"
  | "fricative"
  | "affricate"
  | "glide"
  | "flap"
  | "closure"
  | "silence";

export interface FricationSpec {
  readonly f1: number;
  readonly bw1: number;
  readonly g1: number;
  readonly f2: number;
  readonly bw2: number;
  readonly g2: number;
  readonly hp: number;
}

export interface PhonemeSpec {
  readonly kind: PhonemeKind;
  readonly voiced: boolean;
  readonly f: readonly [number, number, number];
  readonly bw: readonly [number, number, number];
  readonly av: number;
  readonly duration: number;
  readonly locus: readonly [number, number, number] | null;
  readonly transition: number;
  readonly fric: FricationSpec | null;
  readonly af: number;
  readonly closure: number;
  readonly burst: number;
  readonly aspiration: number;
  readonly palatal: boolean;
  readonly labial: boolean;
  readonly nasalZero: number;
}

const NO_FRIC: FricationSpec | null = null;

function vowel(f: readonly [number, number, number], duration: number = 0.1): PhonemeSpec {
  return {
    kind: "vowel",
    voiced: true,
    f,
    bw: [70, 100, 160],
    av: 0,
    duration,
    locus: null,
    transition: 0.05,
    fric: NO_FRIC,
    af: -120,
    closure: 0,
    burst: 0,
    aspiration: 0,
    palatal: false,
    labial: false,
    nasalZero: 0,
  };
}

function devoiced(base: PhonemeSpec): PhonemeSpec {
  return { ...base, kind: "devoiced", voiced: false, av: -120, duration: 0.06, bw: [150, 220, 300] };
}

function nasal(
  f: readonly [number, number, number],
  zero: number,
  duration: number,
  kind: "nasal" | "moraic-nasal" = "nasal",
): PhonemeSpec {
  return {
    kind,
    voiced: true,
    f,
    bw: [110, 260, 320],
    av: -10,
    duration,
    locus: [f[0], f[1], f[2]],
    transition: 0.035,
    fric: NO_FRIC,
    af: -120,
    closure: 0,
    burst: 0,
    aspiration: 0,
    palatal: false,
    labial: false,
    nasalZero: zero,
  };
}

function stop(
  locus: readonly [number, number, number],
  fric: FricationSpec,
  voiced: boolean,
  closure: number,
  burst: number,
  aspiration: number,
  af: number,
): PhonemeSpec {
  return {
    kind: "stop",
    voiced,
    f: locus,
    bw: [120, 160, 220],
    av: voiced ? -16 : -120,
    duration: closure + burst + aspiration,
    locus,
    transition: 0.035,
    fric,
    af,
    closure,
    burst,
    aspiration,
    palatal: false,
    labial: false,
    nasalZero: 0,
  };
}

function fricative(
  locus: readonly [number, number, number],
  fric: FricationSpec,
  voiced: boolean,
  duration: number,
  af: number,
  kind: "fricative" | "affricate" = "fricative",
  closure: number = 0,
): PhonemeSpec {
  return {
    kind,
    voiced,
    f: locus,
    bw: [120, 160, 220],
    av: voiced ? -9 : -120,
    duration,
    locus,
    transition: 0.04,
    fric,
    af,
    closure,
    burst: 0,
    aspiration: 0,
    palatal: false,
    labial: false,
    nasalZero: 0,
  };
}

function glide(f: readonly [number, number, number], duration: number): PhonemeSpec {
  return {
    kind: "glide",
    voiced: true,
    f,
    bw: [90, 130, 200],
    av: -2.5,
    duration,
    locus: f,
    transition: 0.045,
    fric: NO_FRIC,
    af: -120,
    closure: 0,
    burst: 0,
    aspiration: 0,
    palatal: false,
    labial: false,
    nasalZero: 0,
  };
}

const FRIC_S: FricationSpec = { f1: 6200, bw1: 1300, g1: 1, f2: 8600, bw2: 2200, g2: 0.55, hp: 3200 };
const FRIC_SH: FricationSpec = { f1: 3300, bw1: 650, g1: 1, f2: 4900, bw2: 1300, g2: 0.5, hp: 1800 };
const FRIC_HY: FricationSpec = { f1: 3600, bw1: 800, g1: 1, f2: 5200, bw2: 1400, g2: 0.4, hp: 2400 };
const FRIC_F: FricationSpec = { f1: 1300, bw1: 1000, g1: 1, f2: 3800, bw2: 2200, g2: 0.45, hp: 500 };
const FRIC_H: FricationSpec = { f1: 1200, bw1: 900, g1: 1, f2: 2600, bw2: 1400, g2: 0.6, hp: 300 };
const BURST_K: FricationSpec = { f1: 1700, bw1: 600, g1: 1, f2: 2700, bw2: 900, g2: 0.7, hp: 500 };
const BURST_KY: FricationSpec = { f1: 3000, bw1: 700, g1: 1, f2: 4000, bw2: 1000, g2: 0.6, hp: 900 };
const BURST_T: FricationSpec = { f1: 4200, bw1: 1600, g1: 1, f2: 6200, bw2: 2200, g2: 0.7, hp: 1500 };
const BURST_P: FricationSpec = { f1: 900, bw1: 800, g1: 1, f2: 2200, bw2: 1800, g2: 0.45, hp: 200 };

const A = vowel([700, 1150, 2450]);
const I = vowel([290, 2250, 3000]);
const U = vowel([320, 1250, 2250]);
const E = vowel([480, 1850, 2500]);
const O = vowel([480, 800, 2400]);

const SILENCE: PhonemeSpec = {
  kind: "silence",
  voiced: false,
  f: [500, 1500, 2500],
  bw: [200, 200, 200],
  av: -120,
  duration: 0.08,
  locus: null,
  transition: 0.02,
  fric: NO_FRIC,
  af: -120,
  closure: 0,
  burst: 0,
  aspiration: 0,
  palatal: false,
  labial: false,
  nasalZero: 0,
};

const CLOSURE: PhonemeSpec = { ...SILENCE, kind: "closure", duration: 0.09 };

const K = stop([250, 1800, 2400], BURST_K, false, 0.05, 0.012, 0.028, 6);
const G = stop([220, 1800, 2400], BURST_K, true, 0.042, 0.01, 0.008, 3);
const T = stop([250, 1750, 2650], BURST_T, false, 0.045, 0.01, 0.022, 5);
const D = stop([220, 1750, 2650], BURST_T, true, 0.04, 0.009, 0.006, 2);
const P = stop([250, 850, 2300], BURST_P, false, 0.055, 0.01, 0.015, 2);
const B = stop([220, 850, 2300], BURST_P, true, 0.045, 0.009, 0.005, -2);
const S = fricative([300, 1750, 2650], FRIC_S, false, 0.095, 0);
const SH = fricative([280, 2100, 2800], FRIC_SH, false, 0.095, 4.5);
const Z = fricative([260, 1750, 2650], FRIC_S, true, 0.078, -6, "fricative", 0.02);
const J = fricative([260, 2100, 2800], FRIC_SH, true, 0.08, -1, "affricate", 0.03);
const CH = fricative([280, 2100, 2800], FRIC_SH, false, 0.1, 4.5, "affricate", 0.04);
const TS = fricative([300, 1750, 2650], FRIC_S, false, 0.1, 0, "affricate", 0.04);
const H = fricative([450, 1400, 2500], FRIC_H, false, 0.07, -8);
const HY = fricative([300, 2200, 2900], FRIC_HY, false, 0.075, 3);
const F = fricative([320, 1100, 2300], FRIC_F, false, 0.08, 7);
const V = fricative([300, 1100, 2300], FRIC_F, true, 0.065, 1);
const N_ALVEOLAR = nasal([270, 1450, 2350], 1500, 0.055);
const M = nasal([260, 1050, 2200], 1000, 0.06);
const Y = glide([260, 2200, 2900], 0.05);
const W = glide([300, 720, 2250], 0.05);
const R: PhonemeSpec = {
  kind: "flap",
  voiced: true,
  f: [380, 1450, 2400],
  bw: [100, 140, 220],
  av: -8,
  duration: 0.03,
  locus: [380, 1450, 2400],
  transition: 0.02,
  fric: NO_FRIC,
  af: -120,
  closure: 0,
  burst: 0,
  aspiration: 0,
  palatal: false,
  labial: false,
  nasalZero: 0,
};

function palatal(base: PhonemeSpec, fric?: FricationSpec): PhonemeSpec {
  const locus: readonly [number, number, number] =
    base.locus === null
      ? [base.f[0], Math.max(base.f[1], 2100), Math.max(base.f[2], 2900)]
      : [base.locus[0], Math.max(base.locus[1], 2100), Math.max(base.locus[2], 2900)];
  return {
    ...base,
    f: locus,
    locus,
    palatal: true,
    duration: base.duration + 0.02,
    ...(fric === undefined ? {} : { fric }),
  };
}

function labial(base: PhonemeSpec): PhonemeSpec {
  const locus: readonly [number, number, number] =
    base.locus === null
      ? [base.f[0], Math.min(base.f[1], 900), base.f[2]]
      : [base.locus[0], Math.min(base.locus[1], 900), base.locus[2]];
  return { ...base, f: locus, locus, labial: true, duration: base.duration + 0.02 };
}

export const PHONEMES: Readonly<Record<Phoneme, PhonemeSpec>> = {
  a: A,
  i: I,
  u: U,
  e: E,
  o: O,
  A: devoiced(A),
  I: devoiced(I),
  U: devoiced(U),
  E: devoiced(E),
  O: devoiced(O),
  N: nasal([280, 1200, 2300], 1200, 0.09, "moraic-nasal"),
  cl: CLOSURE,
  pau: SILENCE,
  k: K,
  ky: palatal(K, BURST_KY),
  kw: labial(K),
  g: G,
  gy: palatal(G, { ...BURST_KY, g1: 0.8 }),
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
  z: Z,
  j: J,
  ch: CH,
  ts: TS,
  h: H,
  hy: HY,
  f: F,
  v: V,
  n: N_ALVEOLAR,
  ny: palatal(N_ALVEOLAR),
  m: M,
  my: palatal(M),
  r: R,
  ry: palatal(R),
  y: Y,
  w: W,
};

export const VOWEL_PHONEMES: readonly Vowel[] = ["a", "i", "u", "e", "o"];

export function isVowelPhoneme(phoneme: Phoneme): phoneme is "a" | "i" | "u" | "e" | "o" {
  return phoneme === "a" || phoneme === "i" || phoneme === "u" || phoneme === "e" || phoneme === "o";
}

export function isConsonantPhoneme(phoneme: Phoneme): phoneme is Consonant {
  const kind = PHONEMES[phoneme].kind;
  return kind !== "vowel" && kind !== "devoiced" && kind !== "moraic-nasal" && kind !== "closure" && kind !== "silence";
}

export function isVoicedSustain(phoneme: Phoneme): boolean {
  const kind = PHONEMES[phoneme].kind;
  return kind === "vowel" || kind === "nasal" || kind === "moraic-nasal" || kind === "glide";
}

export const VOICELESS_CONSONANTS: ReadonlySet<Phoneme> = new Set<Phoneme>([
  "k",
  "ky",
  "kw",
  "s",
  "sh",
  "t",
  "ty",
  "ch",
  "ts",
  "h",
  "hy",
  "f",
  "p",
  "py",
]);

export type MoraicNasalPlace = "bilabial" | "alveolar" | "velar" | "uvular";

export function moraicNasalPlace(next: Phoneme | undefined): MoraicNasalPlace {
  switch (next) {
    case "m":
    case "my":
    case "p":
    case "py":
    case "b":
    case "by":
      return "bilabial";
    case "n":
    case "ny":
    case "t":
    case "ty":
    case "d":
    case "dy":
    case "r":
    case "ry":
    case "s":
    case "sh":
    case "z":
    case "j":
    case "ch":
    case "ts":
      return "alveolar";
    case "k":
    case "ky":
    case "kw":
    case "g":
    case "gy":
    case "gw":
      return "velar";
    default:
      return "uvular";
  }
}

export const MORAIC_NASAL_TARGETS: Readonly<
  Record<MoraicNasalPlace, { readonly f: readonly [number, number, number]; readonly zero: number }>
> = {
  bilabial: { f: [260, 1050, 2200], zero: 1000 },
  alveolar: { f: [270, 1450, 2350], zero: 1500 },
  velar: { f: [280, 1900, 2500], zero: 2300 },
  uvular: { f: [280, 1150, 2300], zero: 1200 },
};

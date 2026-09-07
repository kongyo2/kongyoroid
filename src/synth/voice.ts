import { createHash } from "node:crypto";
import { invalid } from "../errors.ts";

export interface SingingDefaults {
  readonly vibratoDepthCents: number;
  readonly vibratoRateHz: number;
  readonly vibratoDelaySeconds: number;
  readonly vibratoFadeSeconds: number;
  readonly portamentoSeconds: number;
  readonly jitter: number;
  readonly shimmerDb: number;
}

export interface VoiceProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly profileVersion: number;
  readonly baseF0: number;
  readonly f0Min: number;
  readonly f0Max: number;
  readonly formantScale: number;
  readonly bandwidthScale: number;
  readonly f4: number;
  readonly f5: number;
  readonly rd: number;
  readonly aspirationDb: number;
  readonly jitter: number;
  readonly shimmerDb: number;
  readonly flutter: number;
  readonly rateScale: number;
  readonly gainDb: number;
  readonly intonationScale: number;
  readonly singing: SingingDefaults;
}

const BASE_SINGING: SingingDefaults = {
  vibratoDepthCents: 30,
  vibratoRateHz: 5.5,
  vibratoDelaySeconds: 0.18,
  vibratoFadeSeconds: 0.25,
  portamentoSeconds: 0.06,
  jitter: 0.002,
  shimmerDb: 0.15,
};

function voice(
  partial: Omit<VoiceProfile, "profileVersion" | "singing"> & { readonly singing?: Partial<SingingDefaults> },
): VoiceProfile {
  return {
    profileVersion: 1,
    ...partial,
    singing: { ...BASE_SINGING, ...(partial.singing ?? {}) },
  };
}

const VOICES: readonly VoiceProfile[] = [
  voice({
    id: "neutral",
    name: "Neutral",
    description: "Androgynous mid voice; the default for notifications and verification.",
    baseF0: 170,
    f0Min: 70,
    f0Max: 900,
    formantScale: 1.09,
    bandwidthScale: 1,
    f4: 3400,
    f5: 4300,
    rd: 1.05,
    aspirationDb: -32,
    jitter: 0.006,
    shimmerDb: 0.3,
    flutter: 0.35,
    rateScale: 1,
    gainDb: 0,
    intonationScale: 1,
  }),
  voice({
    id: "female",
    name: "Female",
    description: "Higher voice with a shorter vocal tract and slightly breathier phonation.",
    baseF0: 225,
    f0Min: 110,
    f0Max: 1100,
    formantScale: 1.18,
    bandwidthScale: 1.1,
    f4: 3500,
    f5: 4400,
    rd: 1.3,
    aspirationDb: -30,
    jitter: 0.006,
    shimmerDb: 0.3,
    flutter: 0.35,
    rateScale: 1,
    gainDb: 0,
    intonationScale: 1.05,
    singing: { vibratoRateHz: 5.8 },
  }),
  voice({
    id: "male",
    name: "Male",
    description: "Lower voice with a longer vocal tract and a tenser glottal source.",
    baseF0: 115,
    f0Min: 55,
    f0Max: 700,
    formantScale: 1,
    bandwidthScale: 1,
    f4: 3300,
    f5: 4200,
    rd: 0.9,
    aspirationDb: -34,
    jitter: 0.006,
    shimmerDb: 0.3,
    flutter: 0.35,
    rateScale: 1,
    gainDb: 0,
    intonationScale: 0.95,
    singing: { vibratoRateHz: 5.2 },
  }),
  voice({
    id: "child",
    name: "Child",
    description: "Small vocal tract and high pitch.",
    baseF0: 290,
    f0Min: 150,
    f0Max: 1300,
    formantScale: 1.32,
    bandwidthScale: 1.2,
    f4: 3800,
    f5: 4800,
    rd: 1.2,
    aspirationDb: -30,
    jitter: 0.008,
    shimmerDb: 0.4,
    flutter: 0.4,
    rateScale: 1.05,
    gainDb: -1,
    intonationScale: 1.15,
    singing: { vibratoRateHz: 6 },
  }),
  voice({
    id: "soft",
    name: "Soft",
    description: "Breathy, relaxed phonation with gentle intonation; good for quiet notifications.",
    baseF0: 185,
    f0Min: 80,
    f0Max: 900,
    formantScale: 1.1,
    bandwidthScale: 1.25,
    f4: 3400,
    f5: 4300,
    rd: 1.9,
    aspirationDb: -22,
    jitter: 0.005,
    shimmerDb: 0.4,
    flutter: 0.3,
    rateScale: 0.95,
    gainDb: -2,
    intonationScale: 0.8,
    singing: { vibratoDepthCents: 22, vibratoRateHz: 5.2 },
  }),
  voice({
    id: "bright",
    name: "Bright",
    description: "Tense, clear phonation with lively intonation; carries well over noise.",
    baseF0: 215,
    f0Min: 100,
    f0Max: 1100,
    formantScale: 1.14,
    bandwidthScale: 0.9,
    f4: 3600,
    f5: 4500,
    rd: 0.65,
    aspirationDb: -36,
    jitter: 0.005,
    shimmerDb: 0.25,
    flutter: 0.3,
    rateScale: 1.05,
    gainDb: 0,
    intonationScale: 1.2,
    singing: { vibratoDepthCents: 35, vibratoRateHz: 6 },
  }),
  voice({
    id: "deep",
    name: "Deep",
    description: "Very low voice with a long vocal tract; calm and authoritative.",
    baseF0: 92,
    f0Min: 45,
    f0Max: 600,
    formantScale: 0.95,
    bandwidthScale: 1,
    f4: 3200,
    f5: 4100,
    rd: 0.95,
    aspirationDb: -34,
    jitter: 0.006,
    shimmerDb: 0.3,
    flutter: 0.3,
    rateScale: 0.95,
    gainDb: 0,
    intonationScale: 0.85,
    singing: { vibratoRateHz: 5 },
  }),
];

const VOICE_BY_ID: ReadonlyMap<string, VoiceProfile> = new Map(VOICES.map((profile) => [profile.id, profile]));

export const BUILTIN_VOICES: readonly VoiceProfile[] = VOICES;
export const DEFAULT_VOICE_ID: string = "neutral";

export function normalizeVoiceId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^builtin:/u, "");
}

export function isBuiltinVoiceId(value: string): boolean {
  return VOICE_BY_ID.has(normalizeVoiceId(value));
}

export function resolveVoice(value: string | undefined, path: string = "$.voice"): VoiceProfile {
  const profile = VOICE_BY_ID.get(normalizeVoiceId(value ?? DEFAULT_VOICE_ID));
  if (profile === undefined) {
    invalid(path, `Unknown built-in voice ${JSON.stringify(value)}.`, {
      hint: `Available voices: ${VOICES.map((v) => v.id).join(", ")}. Run: kongyoroid voices`,
    });
  }
  return profile;
}

export interface VoiceOverrides {
  readonly baseF0?: number;
  readonly formantScale?: number;
  readonly rd?: number;
  readonly aspirationDb?: number;
  readonly jitter?: number;
  readonly shimmerDb?: number;
  readonly flutter?: number;
  readonly gainDb?: number;
}

export function applyVoiceOverrides(profile: VoiceProfile, overrides: VoiceOverrides): VoiceProfile {
  return { ...profile, ...overrides };
}

export function voiceProfileHash(profile: VoiceProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
}

export function describeVoice(profile: VoiceProfile): {
  readonly id: string;
  readonly name: string;
  readonly engine: "formant";
  readonly description: string;
  readonly kinds: readonly ["speech", "song"];
  readonly profileVersion: number;
  readonly baseF0: number;
  readonly f0Range: { readonly min: number; readonly max: number };
  readonly formantScale: number;
  readonly hash: string;
} {
  return {
    id: profile.id,
    name: profile.name,
    engine: "formant",
    description: profile.description,
    kinds: ["speech", "song"],
    profileVersion: profile.profileVersion,
    baseF0: profile.baseF0,
    f0Range: { min: profile.f0Min, max: profile.f0Max },
    formantScale: profile.formantScale,
    hash: voiceProfileHash(profile),
  };
}

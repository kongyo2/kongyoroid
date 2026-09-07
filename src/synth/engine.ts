import { createHash } from "node:crypto";
import type { Diagnostic } from "../errors.ts";
import { checkAbort, invalid } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { isKanaOnly } from "../text/mora.ts";
import type { LocalDictionary } from "../text/dictionary.ts";
import { dictionaryFromJson } from "../text/dictionary.ts";
import type { TextFrontend } from "../text/frontend.ts";
import { loadFrontend, readJapanese, readKanaHeuristically, readKanaNotation } from "../text/frontend.ts";
import type { ReadingPlan } from "../text/reading.ts";
import type { ResolvedRequest, ResolvedSong, ResolvedSpeech } from "../types.ts";
import { ENGINE_VERSION } from "../version.ts";
import type { PlannedSegment, SynthesisPlan } from "./plan.ts";
import { keyframeToObject } from "./plan.ts";
import { planSong } from "./song.ts";
import { planSpeech } from "./speech.ts";
import type { VoiceProfile } from "./voice.ts";
import { resolveVoice, voiceProfileHash } from "./voice.ts";

export interface CompileOptions {
  readonly signal?: AbortSignal;
  readonly dictionary?: LocalDictionary;
  readonly frontend?: TextFrontend | "auto" | "heuristic";
  readonly sampleRate?: number;
}

export interface CompiledSpeechReading {
  readonly reading: ReadingPlan;
  readonly readMs: number;
}

export async function readForRequest(
  request: ResolvedSpeech,
  options: CompileOptions = {},
): Promise<CompiledSpeechReading> {
  const started = performance.now();
  const dictionary = mergeDictionaries(options.dictionary, request);
  if (request.kana !== undefined) {
    const reading = readKanaNotation(request.kana, { path: "$.kana" });
    return { reading: { ...reading, text: request.text }, readMs: performance.now() - started };
  }
  if (options.frontend === "heuristic") {
    if (!isKanaOnly(request.text)) {
      invalid("$.text", "The heuristic reader accepts kana only; the text contains other characters.", {
        code: "UNREADABLE_TEXT",
        hint: "Enable the jpreprocess frontend, or give the reading in kana.",
      });
    }
    return { reading: readKanaHeuristically(request.text, "$.text"), readMs: performance.now() - started };
  }
  const frontend = typeof options.frontend === "object" ? options.frontend : await loadFrontend();
  checkAbort(options.signal);
  const reading = await readJapanese(request.text, {
    strict: request.strictReading,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    frontend,
    ...(dictionary === undefined ? {} : { dictionary }),
    path: "$.text",
  });
  return { reading, readMs: performance.now() - started };
}

function mergeDictionaries(base: LocalDictionary | undefined, request: ResolvedSpeech): LocalDictionary | undefined {
  if (request.dictionary.length === 0) return base;
  const inline = dictionaryFromJson(request.dictionary, "$.dictionary");
  return base === undefined ? inline : base.merge(inline);
}

export interface CompiledPlan {
  readonly plan: SynthesisPlan;
  readonly voice: VoiceProfile;
  readonly readMs: number;
  readonly planMs: number;
  readonly planHash: string;
}

export function compileSongPlan(request: ResolvedSong, sampleRate: number): SynthesisPlan {
  const voice = resolveVoice(request.voice, "$.voice");
  const defaults = voice.singing;
  return planSong({
    notes: request.notes,
    tempo: request.tempo,
    voice,
    sampleRate,
    seed: request.seed,
    volume: request.volume,
    leadIn: request.leadIn,
    leadOut: request.leadOut,
    vibrato: {
      depthCents: request.vibratoDepth ?? defaults.vibratoDepthCents,
      rateHz: request.vibratoRate,
      delaySeconds: request.vibratoDelayMs / 1000,
      fadeSeconds: request.vibratoFadeMs / 1000,
    },
    portamentoSeconds: request.portamentoMs === undefined ? defaults.portamentoSeconds : request.portamentoMs / 1000,
    scoopCents: request.scoopCents,
    scoopSeconds: request.scoopMs / 1000,
    breathiness: request.breathiness,
    jitter: undefined,
    allowConsonantCompression: request.consonantCompression,
    path: "$.notes",
  });
}

export function compileSpeechPlan(request: ResolvedSpeech, reading: ReadingPlan, sampleRate: number): SynthesisPlan {
  const voice = resolveVoice(request.voice, "$.voice");
  return planSpeech({
    reading,
    voice,
    sampleRate,
    seed: request.seed,
    speed: request.speed,
    pitchSemitones: request.pitchSemitones,
    pitchScale: request.pitch,
    intonation: request.intonation,
    volume: request.volume,
    prePause: request.prePause,
    postPause: request.postPause,
    pauseLength: request.pauseLength,
    pauseScale: request.pauseScale,
    upspeak: request.upspeak,
    breathiness: request.breathiness,
    jitter: undefined,
    path: request.kana === undefined ? "$.text" : "$.kana",
  });
}

export async function compileRequest(
  request: ResolvedRequest,
  sampleRate: number,
  options: CompileOptions = {},
): Promise<CompiledPlan> {
  checkAbort(options.signal);
  let readMs = 0;
  let plan: SynthesisPlan;
  const started = performance.now();
  if (request.kind === "speech") {
    const read = await readForRequest(request, options);
    readMs = read.readMs;
    const planStart = performance.now();
    plan = compileSpeechPlan(request, read.reading, sampleRate);
    checkAbort(options.signal);
    checkPlanLimits(plan);
    return { plan, voice: plan.voice, readMs, planMs: performance.now() - planStart, planHash: planHash(plan) };
  }
  plan = compileSongPlan(request, sampleRate);
  checkAbort(options.signal);
  checkPlanLimits(plan);
  return { plan, voice: plan.voice, readMs, planMs: performance.now() - started, planHash: planHash(plan) };
}

export function checkPlanLimits(plan: SynthesisPlan): void {
  const seconds = plan.frames / plan.sampleRate;
  if (seconds > LIMITS.formantSeconds) {
    invalid(
      "$",
      `Audio would last ${seconds.toFixed(1)} s; the formant engine renders at most ${LIMITS.formantSeconds} s per request.`,
      {
        hint: "Split the input into shorter requests (batch mode keeps the order), or use streaming.",
        repairOptions: [{ action: "split-input", description: "Split the text or score into several requests." }],
      },
    );
  }
}

export function planHash(plan: SynthesisPlan): string {
  const hash = createHash("sha256");
  hash.update(
    `${plan.engineVersion}|${plan.planVersion}|${plan.sampleRate}|${plan.seed}|${plan.volume}|${plan.jitter}|${plan.shimmerDb}|${plan.flutter}|${voiceProfileHash(plan.voice)}|`,
  );
  for (const segment of plan.segments) {
    hash.update(`${segment.phoneme}:${segment.start}:${segment.end}:${segment.articulation}|`);
    for (const frame of segment.keyframes) {
      hash.update(String(Math.round(frame.at * 1e6)));
      hash.update(Buffer.from(frame.values.buffer, frame.values.byteOffset, frame.values.byteLength));
    }
  }
  for (const point of plan.pitch) hash.update(`${point.sample}:${point.hz.toFixed(4)}|`);
  for (const region of plan.vibrato)
    hash.update(
      `${region.start}:${region.end}:${region.depthCents}:${region.rateHz}:${region.delaySeconds}:${region.fadeSeconds}|`,
    );
  return hash.digest("hex");
}

export type PlanDetail = "summary" | "phonemes" | "acoustics";

export interface PlanSummary {
  readonly planVersion: number;
  readonly engineVersion: string;
  readonly kind: "speech" | "song";
  readonly voice: string;
  readonly voiceHash: string;
  readonly sampleRate: number;
  readonly seed: number;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly wavBytes: number;
  readonly f0: { readonly min: number; readonly max: number };
  readonly planHash: string;
  readonly reading: {
    readonly frontend: string;
    readonly kana: string;
    readonly moraCount: number;
    readonly phrases: readonly {
      readonly index: number;
      readonly text: string;
      readonly kana: string;
      readonly accent: number;
      readonly accentSource: string;
      readonly boundary: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
    }[];
    readonly dictionaryHits: readonly {
      readonly surface: string;
      readonly reading: string;
      readonly accent: number | null;
      readonly source: string;
      readonly applied: boolean;
    }[];
  } | null;
  readonly notes: readonly {
    readonly id: string;
    readonly index: number;
    readonly key: number | null;
    readonly hz: number | null;
    readonly lyric: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly vowelStartSeconds: number | null;
    readonly continuation: string;
    readonly articulation: string;
    readonly sustainId: number | null;
  }[];
  readonly moras: readonly {
    readonly index: number;
    readonly text: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly phonemes: readonly string[];
  }[];
  readonly phonemes?: readonly {
    readonly id: number;
    readonly phoneme: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly voiced: boolean;
    readonly mora: number | null;
    readonly note: string | null;
    readonly articulation: string;
    readonly keyframes?: readonly Record<string, number>[];
  }[];
  readonly pitchPoints?: readonly { readonly seconds: number; readonly hz: number }[];
  readonly warnings: readonly Diagnostic[];
  readonly adjustments: readonly {
    readonly code: string;
    readonly message: string;
    readonly noteId?: string;
    readonly path?: string;
  }[];
}

export function summarizePlan(plan: SynthesisPlan, hash: string, detail: PlanDetail = "summary"): PlanSummary {
  const rate = plan.sampleRate;
  const seconds = (sample: number): number => Math.round((sample / rate) * 10000) / 10000;
  const phonemes = (segments: readonly PlannedSegment[]): NonNullable<PlanSummary["phonemes"]> =>
    segments.map((segment) => ({
      id: segment.id,
      phoneme: segment.phoneme,
      startSeconds: seconds(segment.start),
      endSeconds: seconds(segment.end),
      voiced: segment.voiced,
      mora: segment.moraIndex,
      note: segment.noteId,
      articulation: segment.articulation,
      ...(detail === "acoustics" ? { keyframes: segment.keyframes.map(keyframeToObject) } : {}),
    }));
  const reading = plan.reading;
  return {
    planVersion: plan.planVersion,
    engineVersion: plan.engineVersion,
    kind: plan.kind,
    voice: plan.voice.id,
    voiceHash: voiceProfileHash(plan.voice),
    sampleRate: rate,
    seed: plan.seed,
    frames: plan.frames,
    durationSeconds: seconds(plan.frames),
    wavBytes: 44 + plan.frames * 2,
    f0: { min: Math.round(plan.f0Min * 10) / 10, max: Math.round(plan.f0Max * 10) / 10 },
    planHash: hash,
    reading:
      reading === null
        ? null
        : {
            frontend: reading.frontend,
            kana: reading.kana,
            moraCount: reading.moraCount,
            phrases: plan.phrases.map((marker) => ({
              index: marker.index,
              text: marker.text,
              kana: marker.kana,
              accent: marker.accent,
              accentSource: reading.phrases[marker.index]?.accentSource ?? "frontend",
              boundary: marker.boundary,
              startSeconds: seconds(marker.start),
              endSeconds: seconds(marker.end),
            })),
            dictionaryHits: reading.dictionaryHits.map((hit) => ({
              surface: hit.surface,
              reading: hit.reading,
              accent: hit.accent,
              source: hit.source,
              applied: hit.applied,
            })),
          },
    notes: plan.notes.map((note) => ({
      id: note.id,
      index: note.index,
      key: note.key,
      hz: note.hz === null ? null : Math.round(note.hz * 100) / 100,
      lyric: note.lyric,
      startSeconds: seconds(note.start),
      endSeconds: seconds(note.end),
      vowelStartSeconds: note.vowelStart === null ? null : seconds(note.vowelStart),
      continuation: note.continuation,
      articulation: note.articulation,
      sustainId: note.sustainId,
    })),
    moras: plan.moras.map((mora) => ({
      index: mora.index,
      text: mora.text,
      startSeconds: seconds(mora.start),
      endSeconds: seconds(mora.end),
      phonemes: mora.phonemes,
    })),
    ...(detail === "summary" ? {} : { phonemes: phonemes(plan.segments) }),
    ...(detail === "summary"
      ? {}
      : {
          pitchPoints: plan.pitch
            .filter((_, index) => detail === "acoustics" || index % 4 === 0)
            .map((point) => ({ seconds: seconds(point.sample), hz: Math.round(point.hz * 100) / 100 })),
        }),
    warnings: plan.warnings,
    adjustments: plan.adjustments,
  };
}

export const FORMANT_ENGINE_VERSION: string = ENGINE_VERSION;

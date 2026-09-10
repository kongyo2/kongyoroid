import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import process from "node:process";
import type { CacheStats, RenderCache } from "./cache.ts";
import { DiskCache, LayeredCache, MemoryCache, cacheKey } from "./cache.ts";
import { Semaphore } from "./concurrency.ts";
import type { Diagnostic, ErrorData } from "./errors.ts";
import { KongyoroidError, asKongyoroidError, checkAbort, invalid } from "./errors.ts";
import { DEFAULT_SAMPLE_RATE, LIMITS } from "./limits.ts";
import { parseEngine, parseRequest, parseStyleRef, requestHash } from "./request.ts";
import type { CompileOptions, CompiledPlan, PlanDetail, PlanSummary } from "./synth/engine.ts";
import { compileRequest, readForRequest, summarizePlan } from "./synth/engine.ts";
import type { SynthesisPlan } from "./synth/plan.ts";
import type { RenderStats } from "./synth/renderer.ts";
import type { PcmBlock, StreamOptions } from "./synth/stream.ts";
import { encodePlanAsync, renderPcmStream } from "./synth/stream.ts";
import type { TextStreamEvent, TextStreamOptions } from "./synth/textstream.ts";
import { synthesizeTextStream } from "./synth/textstream.ts";
import type { VoiceProfile } from "./synth/voice.ts";
import { BUILTIN_VOICES, describeVoice, resolveVoice, voiceProfileHash } from "./synth/voice.ts";
import { estimatePitch, signalStats } from "./synth/analysis.ts";
import type { DictionaryEntryInput } from "./text/dictionary.ts";
import { LocalDictionary, dictionaryFromJson } from "./text/dictionary.ts";
import { frontendState, loadFrontend } from "./text/frontend.ts";
import { formatKanaNotation, parseKanaNotation } from "./text/notation.ts";
import type { ReadingPlan } from "./text/reading.ts";
import type {
  AudioInfo,
  EngineId,
  EngineSelector,
  OperationOptions,
  RenderResult,
  RenderStyles,
  RenderTimings,
  ResolvedRequest,
  ResolvedSpeech,
  SongRequest,
  SpeechRequest,
  StyleRef,
  StyleSelection,
  VoiceStyle,
} from "./types.ts";
import type { JsonObject } from "./validate.ts";
import { integer, isObject, literal } from "./validate.ts";
import { ENGINE_VERSION, FRONTEND_VERSION, PACKAGE_NAME, PLAN_VERSION, VERSION } from "./version.ts";
import type { EngineAccentPhrase, EngineManifest, SupportedDevices } from "./voicevox/api.ts";
import type { VoicevoxClientOptions } from "./voicevox/client.ts";
import { VoicevoxClient } from "./voicevox/client.ts";
import { Dictionary } from "./voicevox/dictionary.ts";
import { accentPhrasesToKana, synthesizeSpeech } from "./voicevox/speech.ts";
import { synthesizeSong } from "./voicevox/song.ts";
import { StyleCatalog } from "./voicevox/styles.ts";
import { audioInfo, decodeWav, inspectWav } from "./wav.ts";

export interface CacheOptions {
  readonly directory?: string;
  readonly memoryBytes?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly strict?: boolean;
  readonly enabled?: boolean;
}

export interface VoicevoxOptions extends VoicevoxClientOptions {
  readonly speaker?: StyleRef;
  readonly singer?: StyleRef;
  readonly teacher?: StyleRef;
  readonly probeTimeoutMs?: number;
}

export interface KongyoroidOptions extends VoicevoxClientOptions {
  readonly engine?: EngineSelector;
  readonly voice?: string;
  readonly dictionary?: LocalDictionary | readonly DictionaryEntryInput[];
  readonly strictReading?: boolean;
  readonly speaker?: StyleRef;
  readonly singer?: StyleRef;
  readonly teacher?: StyleRef;
  readonly concurrency?: number;
  readonly cacheBytes?: number;
  readonly cacheDir?: string;
  readonly cache?: CacheOptions;
  readonly probeTimeoutMs?: number;
  readonly voicevox?: VoicevoxOptions;
}

export type SpeakInput = Omit<SpeechRequest, "kind">;
export type SingInput = Omit<SongRequest, "kind">;

export interface ReadingMora {
  readonly text: string;
  readonly consonant: string | null;
  readonly vowel: string;
  readonly consonantLength: number | null;
  readonly vowelLength: number;
  readonly pitch: number;
}

export interface ReadingPhrase {
  readonly text: string;
  readonly accent: number;
  readonly accentSource: string;
  readonly boundary: string;
  readonly pause: boolean;
  readonly interrogative: boolean;
  readonly moras: readonly ReadingMora[];
}

export interface Reading {
  readonly engine: EngineId;
  readonly frontend: string;
  readonly kana: string;
  readonly phrases: readonly ReadingPhrase[];
  readonly speaker: StyleSelection | null;
  readonly warnings: readonly Diagnostic[];
  readonly dictionaryHits: readonly {
    readonly surface: string;
    readonly reading: string;
    readonly accent: number | null;
    readonly source: "dictionary" | "lexicon";
    readonly applied: boolean;
  }[];
  readonly sentences: readonly {
    readonly text: string;
    readonly kana: string;
    readonly start: number;
    readonly end: number;
  }[];
}

export interface ReadingOptions extends OperationOptions {
  readonly speaker?: StyleRef;
  readonly kana?: string;
  readonly engine?: EngineSelector;
  readonly dictionary?: LocalDictionary;
  readonly strict?: boolean;
}

export interface FrontendDiagnosis {
  readonly available: boolean;
  readonly version: string;
  readonly loadMs: number | null;
  readonly error: ErrorData | null;
}

export interface VoicevoxDiagnosis {
  readonly ok: boolean;
  readonly endpoint: string;
  readonly version: string | null;
  readonly manifest: EngineManifest | null;
  readonly devices: SupportedDevices | null;
  readonly styles: {
    readonly speech: number;
    readonly song: number;
    readonly teacher: number;
    readonly total: number;
  } | null;
  readonly error: ErrorData | null;
}

export interface Diagnosis {
  readonly ok: boolean;
  readonly name: string;
  readonly version: string;
  readonly engineVersion: string;
  readonly node: string;
  readonly defaultEngine: EngineSelector;
  readonly formant: {
    readonly ok: boolean;
    readonly voices: readonly string[];
    readonly frontend: FrontendDiagnosis;
    readonly synthesis: {
      readonly ok: boolean;
      readonly ms: number;
      readonly frames: number;
      readonly error: ErrorData | null;
    };
  };
  readonly cache: {
    readonly directory: string | null;
    readonly stats: CacheStats | null;
    readonly error: ErrorData | null;
  };
  readonly dictionary: { readonly entries: number; readonly digest: string } | null;
  readonly voicevox: VoicevoxDiagnosis | null;
  readonly error: ErrorData | null;
}

export interface DoctorOptions extends OperationOptions {
  readonly engine?: EngineSelector | "all";
  readonly frontend?: boolean;
}

export type VoiceKind = "speech" | "song" | "all";

export interface VoiceDescriptor {
  readonly id: string;
  readonly engine: EngineId;
  readonly name: string;
  readonly character: string | null;
  readonly description: string | null;
  readonly kinds: readonly ("speech" | "song")[];
  readonly styleId: number | null;
  readonly type: string | null;
  readonly baseF0: number | null;
  readonly f0Range: { readonly min: number; readonly max: number } | null;
  readonly hash: string | null;
}

export interface VoicesOptions extends OperationOptions {
  readonly engine?: EngineSelector | "all";
  readonly kind?: VoiceKind;
}

export interface VoicesResult {
  readonly voices: readonly VoiceDescriptor[];
  readonly voicevox: { readonly queried: boolean; readonly available: boolean; readonly error: ErrorData | null };
}

export interface ValidationResult {
  readonly ok: true;
  readonly operation: "validate";
  readonly engine: EngineId | "auto";
  readonly kind: "speech" | "song";
  readonly renderable: boolean | "unknown";
  readonly estimate: {
    readonly durationSeconds: number;
    readonly frames: number;
    readonly wavBytes: number;
    readonly sampleRate: number;
  } | null;
  readonly voice: string | undefined;
  readonly reading: { readonly kana: string; readonly frontend: string; readonly moraCount: number } | null;
  readonly notes: number | null;
  readonly warnings: readonly Diagnostic[];
  readonly adjustments: readonly { readonly code: string; readonly message: string }[];
  readonly requestHash: string;
  readonly planHash: string | null;
  readonly request: ResolvedRequest;
}

export interface PlanResult {
  readonly ok: true;
  readonly operation: "plan";
  readonly engine: EngineId;
  readonly requestHash: string;
  readonly plan: PlanSummary;
  readonly request: ResolvedRequest;
}

export interface CompileResult extends CompiledPlan {
  readonly request: ResolvedRequest;
  readonly requestHash: string;
  readonly engine: "formant";
}

export interface InspectResult {
  readonly info: AudioInfo;
  readonly bytes: number;
  readonly sha256: string;
  readonly peak: number;
  readonly rms: number;
  readonly dc: number;
  readonly clipped: number;
  readonly finite: boolean;
  readonly pitch: {
    readonly medianHz: number | null;
    readonly minHz: number | null;
    readonly maxHz: number | null;
    readonly voicedRatio: number;
    readonly track?: readonly { readonly seconds: number; readonly hz: number; readonly clarity: number }[];
  };
}

export interface InspectOptions {
  readonly pitchTrack?: boolean;
  readonly windowMs?: number;
}

export interface RenderPlanOptions extends StreamOptions {
  readonly requestHash?: string;
  readonly readMs?: number;
  readonly planMs?: number;
}

const PROBE_RETRY_MS = 30_000;

interface Probe {
  readonly at: number;
  result: EngineId | undefined;
  promise: Promise<EngineId>;
}

interface CachedRender {
  readonly audio: Uint8Array;
  readonly kana: string | undefined;
  readonly chunks: number;
  readonly warnings: readonly Diagnostic[];
  readonly adjustments: readonly { readonly code: string; readonly message: string }[];
  readonly stats: RenderStats | undefined;
  readonly voice: string | undefined;
}

const PACK_VERSION = 2;

function packRender(entry: CachedRender): Uint8Array {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      v: PACK_VERSION,
      kana: entry.kana ?? null,
      chunks: entry.chunks,
      warnings: entry.warnings,
      adjustments: entry.adjustments,
      stats: entry.stats ?? null,
      voice: entry.voice ?? null,
    }),
  );
  const out = new Uint8Array(4 + meta.length + entry.audio.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, 4);
  out.set(entry.audio, 4 + meta.length);
  return out;
}

function statsFrom(value: unknown): RenderStats | undefined {
  if (!isObject(value)) return undefined;
  const peak = value["peak"];
  const rms = value["rms"];
  const limitedSamples = value["limitedSamples"];
  const frames = value["frames"];
  if (
    typeof peak !== "number" ||
    typeof rms !== "number" ||
    typeof limitedSamples !== "number" ||
    typeof frames !== "number"
  ) {
    return undefined;
  }
  return { peak, rms, limitedSamples, frames };
}

function diagnosticsFrom(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: Diagnostic[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const severity = item["severity"];
    const code = item["code"];
    const message = item["message"];
    if (severity !== "error" && severity !== "warning" && severity !== "advice") continue;
    if (typeof code !== "string" || typeof message !== "string") continue;
    const sourceSpan = item["sourceSpan"];
    out.push({
      severity,
      code,
      message,
      ...(typeof item["path"] === "string" ? { path: item["path"] } : {}),
      ...(typeof item["help"] === "string" ? { help: item["help"] } : {}),
      ...(typeof item["surface"] === "string" ? { surface: item["surface"] } : {}),
      ...(isObject(sourceSpan) &&
      typeof sourceSpan["start"] === "number" &&
      typeof sourceSpan["end"] === "number" &&
      sourceSpan["unit"] === "unicode-code-point"
        ? { sourceSpan: { start: sourceSpan["start"], end: sourceSpan["end"], unit: "unicode-code-point" as const } }
        : {}),
      ...(item["detail"] === undefined ? {} : { detail: item["detail"] }),
    });
  }
  return out;
}

function adjustmentsFrom(value: unknown): { readonly code: string; readonly message: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { readonly code: string; readonly message: string }[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const code = item["code"];
    const message = item["message"];
    if (typeof code === "string" && typeof message === "string") out.push({ ...item, code, message });
  }
  return out;
}

function unpackRender(bytes: Uint8Array): CachedRender | undefined {
  if (bytes.length < 4) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + length > bytes.length) return undefined;
  try {
    const meta: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    if (!isObject(meta) || meta["v"] !== PACK_VERSION) return undefined;
    const audio = bytes.slice(4 + length);
    inspectWav(audio);
    return {
      audio,
      kana: typeof meta["kana"] === "string" ? meta["kana"] : undefined,
      chunks: typeof meta["chunks"] === "number" ? meta["chunks"] : 1,
      warnings: diagnosticsFrom(meta["warnings"]),
      adjustments: adjustmentsFrom(meta["adjustments"]),
      stats: statsFrom(meta["stats"]),
      voice: typeof meta["voice"] === "string" ? meta["voice"] : undefined,
    };
  } catch {
    return undefined;
  }
}

function round(value: number, digits: number = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class Kongyoroid {
  public readonly dictionary: LocalDictionary;
  private clientInstance: VoicevoxClient | undefined;
  private stylesInstance: StyleCatalog | undefined;
  private voicevoxDictionaryInstance: Dictionary | undefined;
  private readonly voicevoxOptions: VoicevoxOptions;
  private readonly defaults: {
    readonly engine: EngineSelector;
    readonly voice: string | undefined;
    readonly speaker: StyleRef | undefined;
    readonly singer: StyleRef | undefined;
    readonly teacher: StyleRef | undefined;
    readonly strictReading: boolean | undefined;
  };
  private readonly semaphore: Semaphore;
  private readonly cache: RenderCache | undefined;
  private readonly cacheStrict: boolean;
  private readonly diskCache: DiskCache | undefined;
  private readonly concurrency: number;
  private readonly probeTimeoutMs: number;
  private readonly inFlight: Map<string, Promise<CachedRender>> = new Map<string, Promise<CachedRender>>();
  private probe: Probe | undefined;

  public constructor(options: KongyoroidOptions = {}) {
    const voicevox: VoicevoxOptions = {
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.speaker === undefined ? {} : { speaker: options.speaker }),
      ...(options.singer === undefined ? {} : { singer: options.singer }),
      ...(options.teacher === undefined ? {} : { teacher: options.teacher }),
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      ...(options.voicevox ?? {}),
    };
    this.voicevoxOptions = voicevox;
    this.defaults = {
      engine: options.engine ?? "formant",
      voice: options.voice === undefined ? undefined : resolveVoice(options.voice, "$.voice").id,
      speaker: voicevox.speaker === undefined ? undefined : parseStyleRef(voicevox.speaker, "$.speaker"),
      singer: voicevox.singer === undefined ? undefined : parseStyleRef(voicevox.singer, "$.singer"),
      teacher: voicevox.teacher === undefined ? undefined : parseStyleRef(voicevox.teacher, "$.teacher"),
      strictReading: options.strictReading,
    };
    if (options.engine !== undefined) parseEngine(options.engine, "$.engine");
    this.dictionary =
      options.dictionary === undefined
        ? new LocalDictionary()
        : options.dictionary instanceof LocalDictionary
          ? options.dictionary
          : dictionaryFromJson(options.dictionary, "$.dictionary");
    this.concurrency = integer(options.concurrency ?? 2, "$.concurrency", 1, LIMITS.concurrency);
    this.semaphore = new Semaphore(this.concurrency);
    const cacheOptions: CacheOptions = {
      ...(options.cacheDir === undefined ? {} : { directory: options.cacheDir }),
      ...(options.cacheBytes === undefined ? {} : { memoryBytes: options.cacheBytes }),
      ...(options.cache ?? {}),
    };
    this.cacheStrict = cacheOptions.strict ?? false;
    if (cacheOptions.enabled === false) {
      this.cache = undefined;
      this.diskCache = undefined;
    } else {
      const memory = new MemoryCache(cacheOptions.memoryBytes ?? 64 * 1024 * 1024);
      if (cacheOptions.directory === undefined) {
        this.cache = memory;
        this.diskCache = undefined;
      } else {
        this.diskCache = new DiskCache(cacheOptions.directory, {
          ...(cacheOptions.maxBytes === undefined ? {} : { maxBytes: cacheOptions.maxBytes }),
          ...(cacheOptions.maxEntries === undefined ? {} : { maxEntries: cacheOptions.maxEntries }),
        });
        this.cache = new LayeredCache([memory, this.diskCache]);
      }
    }
    this.probeTimeoutMs = integer(voicevox.probeTimeoutMs ?? 3000, "$.probeTimeoutMs", 100, 600_000);
  }

  public get client(): VoicevoxClient {
    this.clientInstance ??= new VoicevoxClient(this.voicevoxOptions);
    return this.clientInstance;
  }

  public get styles(): StyleCatalog {
    this.stylesInstance ??= new StyleCatalog(this.client);
    return this.stylesInstance;
  }

  public get voicevoxDictionary(): Dictionary {
    this.voicevoxDictionaryInstance ??= new Dictionary(this.client);
    return this.voicevoxDictionaryInstance;
  }

  public get defaultEngine(): EngineSelector {
    return this.defaults.engine;
  }

  public get voices$(): readonly VoiceProfile[] {
    return BUILTIN_VOICES;
  }

  public async clearCache(): Promise<number> {
    return this.cache === undefined ? 0 : this.cache.clear();
  }

  public async cacheStats(): Promise<CacheStats | null> {
    return this.cache === undefined ? null : this.cache.stats();
  }

  public async pruneCache(maxBytes?: number, maxEntries?: number): Promise<number> {
    return this.diskCache === undefined ? 0 : this.diskCache.prune(maxBytes, maxEntries);
  }

  public withDefaults(request: unknown): unknown {
    if (!isObject(request)) return request;
    const merged: JsonObject = { ...request };
    const hasStyle =
      merged["speaker"] !== undefined || merged["singer"] !== undefined || merged["teacher"] !== undefined;
    if (merged["engine"] === undefined && (this.defaults.engine !== "formant" || !hasStyle))
      merged["engine"] = this.defaults.engine;
    if (merged["voice"] === undefined && this.defaults.voice !== undefined) merged["voice"] = this.defaults.voice;
    if (merged["strictReading"] === undefined && this.defaults.strictReading !== undefined)
      merged["strictReading"] = this.defaults.strictReading;
    const engine = merged["engine"];
    const wantsVoicevox = engine === "voicevox" || engine === "auto" || hasStyle;
    if (
      wantsVoicevox &&
      merged["kind"] === "speech" &&
      merged["speaker"] === undefined &&
      this.defaults.speaker !== undefined
    ) {
      merged["speaker"] = this.defaults.speaker;
    }
    if (wantsVoicevox && merged["kind"] === "song") {
      if (merged["singer"] === undefined && this.defaults.singer !== undefined) merged["singer"] = this.defaults.singer;
      if (merged["teacher"] === undefined && this.defaults.teacher !== undefined)
        merged["teacher"] = this.defaults.teacher;
    }
    if (merged["engine"] === "formant" && hasStyle) {
      if (this.defaults.engine === "formant" && isObject(request) && request["engine"] === undefined)
        delete merged["engine"];
    }
    return merged;
  }

  public parse(request: unknown): { readonly request: ResolvedRequest; readonly requestHash: string } {
    const resolved = parseRequest(this.withDefaults(request));
    return { request: resolved, requestHash: requestHash({ ...resolved, dictionaryDigest: this.dictionary.digest() }) };
  }

  public resolveEngine(selector: EngineSelector, options: OperationOptions = {}): Promise<EngineId> {
    if (selector !== "auto") return Promise.resolve(selector);
    const current = this.probe;
    if (current !== undefined && !(current.result === "formant" && Date.now() - current.at > PROBE_RETRY_MS)) {
      return current.promise;
    }
    const timeout = AbortSignal.timeout(this.probeTimeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    const probe: Probe = { at: Date.now(), result: undefined, promise: Promise.resolve("formant") };
    probe.promise = this.client.version({ signal }).then(
      (): EngineId => {
        probe.result = "voicevox";
        return "voicevox";
      },
      (error: unknown): EngineId => {
        if (options.signal?.aborted === true) {
          if (this.probe === probe) this.probe = undefined;
          throw error;
        }
        probe.result = "formant";
        return "formant";
      },
    );
    this.probe = probe;
    return probe.promise;
  }

  public async dictionaryDigest(options: OperationOptions = {}): Promise<string | undefined> {
    try {
      const words = await this.client.dictionary(options);
      const rows = words
        .map((word) => [word.uuid, word.surface, word.pronunciation, word.accentType, word.priority].join(" "))
        .sort();
      return createHash("sha256").update(rows.join("\n")).digest("hex");
    } catch (error) {
      if (error instanceof KongyoroidError && error.code === "ABORTED") throw error;
      return undefined;
    }
  }

  public async resolveStyles(request: ResolvedRequest, options: OperationOptions = {}): Promise<RenderStyles> {
    if (request.kind === "speech") {
      return { speaker: await this.styles.resolve(request.speaker, "speaker", options) };
    }
    const singer = await this.styles.resolve(request.singer, "singer", options);
    const teacher =
      request.teacher !== undefined
        ? await this.styles.resolve(request.teacher, "teacher", options)
        : singer.type === "sing"
          ? singer
          : await this.styles.resolve(undefined, "teacher", options);
    return { singer, teacher };
  }

  private compileOptions(options: OperationOptions): CompileOptions {
    return {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      dictionary: this.dictionary,
    };
  }

  public async compile(request: unknown, options: OperationOptions = {}): Promise<CompileResult> {
    const parsed = this.parse(request);
    const engine = await this.resolveEngine(parsed.request.engine, options);
    if (engine !== "formant") {
      invalid("$.engine", "Plans can only be compiled for the formant engine.", {
        hint: 'Set engine to "formant" (or omit the VOICEVOX style) to inspect the plan.',
        repairOptions: [{ action: "use-formant-engine", description: "Use the built-in engine for plan inspection." }],
      });
    }
    const sampleRate = parsed.request.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const compiled = await compileRequest(parsed.request, sampleRate, this.compileOptions(options));
    return { ...compiled, request: parsed.request, requestHash: parsed.requestHash, engine: "formant" };
  }

  public async validate(request: unknown, options: OperationOptions = {}): Promise<ValidationResult> {
    const parsed = this.parse(request);
    const resolved = parsed.request;
    const engine = resolved.engine === "auto" ? "auto" : resolved.engine;
    if (engine !== "formant") {
      return {
        ok: true,
        operation: "validate",
        engine,
        kind: resolved.kind,
        renderable: "unknown",
        estimate: null,
        voice: undefined,
        reading: null,
        notes: resolved.kind === "song" ? resolved.notes.length : null,
        warnings: [
          {
            severity: "advice",
            code: "EXTERNAL_ENGINE_NOT_PROBED",
            message: "The request targets VOICEVOX; structure was validated but the engine was not contacted.",
            help: "Run doctor --engine voicevox to check the endpoint.",
          },
        ],
        adjustments: [],
        requestHash: parsed.requestHash,
        planHash: null,
        request: resolved,
      };
    }
    const sampleRate = resolved.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const compiled = await compileRequest(resolved, sampleRate, this.compileOptions(options));
    const plan = compiled.plan;
    return {
      ok: true,
      operation: "validate",
      engine: "formant",
      kind: resolved.kind,
      renderable: true,
      estimate: {
        durationSeconds: round(plan.frames / sampleRate, 3),
        frames: plan.frames,
        wavBytes: 44 + plan.frames * 2,
        sampleRate,
      },
      voice: plan.voice.id,
      reading:
        plan.reading === null
          ? null
          : { kana: plan.reading.kana, frontend: plan.reading.frontend, moraCount: plan.reading.moraCount },
      notes: resolved.kind === "song" ? resolved.notes.length : null,
      warnings: plan.warnings,
      adjustments: plan.adjustments,
      requestHash: parsed.requestHash,
      planHash: compiled.planHash,
      request: resolved,
    };
  }

  public async plan(
    request: unknown,
    options: PlanDetail | (OperationOptions & { readonly detail?: PlanDetail }) = {},
  ): Promise<PlanResult> {
    const resolved = typeof options === "string" ? { detail: options } : options;
    const detail = literal(resolved.detail ?? "summary", "$.detail", ["summary", "phonemes", "acoustics"]);
    const compiled = await this.compile(request, resolved);
    return {
      ok: true,
      operation: "plan",
      engine: "formant",
      requestHash: compiled.requestHash,
      plan: summarizePlan(compiled.plan, compiled.planHash, detail),
      request: compiled.request,
    };
  }

  public async renderPlan(plan: SynthesisPlan, options: RenderPlanOptions = {}): Promise<RenderResult> {
    const start = performance.now();
    checkAbort(options.signal);
    const encoded = await encodePlanAsync(plan, options);
    const renderMs = performance.now() - start;
    return this.formantResult(
      {
        audio: encoded.audio,
        kana: plan.reading?.kana,
        chunks: 1,
        warnings: plan.warnings,
        adjustments: plan.adjustments,
        stats: encoded.stats,
        voice: plan.voice.id,
      },
      plan.kind,
      false,
      options.requestHash ?? "",
      {
        readMs: options.readMs ?? 0,
        planMs: options.planMs ?? 0,
        renderMs,
        encodeMs: 0,
        totalMs: (options.readMs ?? 0) + (options.planMs ?? 0) + renderMs,
      },
    );
  }

  private formantResult(
    entry: CachedRender,
    kind: "speech" | "song",
    cached: boolean,
    hash: string,
    timings: RenderTimings,
  ): RenderResult {
    return {
      audio: entry.audio,
      info: audioInfo(inspectWav(entry.audio)),
      engine: "formant",
      kind,
      voice: entry.voice,
      styles: {},
      kana: entry.kana,
      chunks: entry.chunks,
      cached,
      sha256: createHash("sha256").update(entry.audio).digest("hex"),
      requestHash: hash,
      elapsedMs: round(timings.totalMs),
      timings: {
        readMs: round(timings.readMs),
        planMs: round(timings.planMs),
        renderMs: round(timings.renderMs),
        encodeMs: round(timings.encodeMs),
        totalMs: round(timings.totalMs),
      },
      warnings: entry.warnings,
      adjustments: entry.adjustments,
      peak: entry.stats === undefined ? undefined : round(entry.stats.peak, 4),
      rms: entry.stats === undefined ? undefined : round(entry.stats.rms, 4),
      limitedSamples: entry.stats?.limitedSamples,
      engineVersion: ENGINE_VERSION,
    };
  }

  private async cacheGet(key: string, warnings: Diagnostic[]): Promise<CachedRender | undefined> {
    if (this.cache === undefined) return undefined;
    try {
      const bytes = await this.cache.get(key);
      return bytes === undefined ? undefined : unpackRender(bytes);
    } catch (error) {
      if (this.cacheStrict) throw asKongyoroidError(error);
      warnings.push({
        severity: "warning",
        code: "CACHE_READ_FAILED",
        message: `The render cache could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  private async cacheSet(key: string, entry: CachedRender, warnings: Diagnostic[]): Promise<void> {
    if (this.cache === undefined) return;
    try {
      await this.cache.set(key, packRender(entry));
    } catch (error) {
      if (this.cacheStrict) throw asKongyoroidError(error);
      warnings.push({
        severity: "warning",
        code: "CACHE_WRITE_FAILED",
        message: `The render was produced but could not be cached: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  public async render(request: unknown, options: OperationOptions = {}): Promise<RenderResult> {
    const start = performance.now();
    checkAbort(options.signal);
    const parsed = this.parse(request);
    const resolved = parsed.request;
    const engine = await this.resolveEngine(resolved.engine, options);
    const cacheWarnings: Diagnostic[] = [];
    const styles = engine === "voicevox" ? await this.resolveStyles(resolved, options) : {};
    const manifest = engine === "voicevox" ? await this.client.manifest(options) : undefined;
    const dictionary =
      engine === "voicevox" && resolved.kind === "speech"
        ? await this.dictionaryDigest(options)
        : this.dictionary.digest();
    const key =
      dictionary === undefined
        ? undefined
        : cacheKey(
            engine,
            VERSION,
            engine === "voicevox"
              ? [this.client.endpoint.href, manifest?.version ?? "", styles, dictionary]
              : [ENGINE_VERSION, FRONTEND_VERSION, PLAN_VERSION, dictionary],
            resolved,
          );
    const cached = key === undefined ? undefined : await this.cacheGet(key, cacheWarnings);
    checkAbort(options.signal);
    let timings: RenderTimings = { readMs: 0, planMs: 0, renderMs: 0, encodeMs: 0, totalMs: 0 };
    let entry: CachedRender;
    if (cached !== undefined) {
      entry = cached;
    } else {
      const shared = key === undefined ? undefined : this.inFlight.get(key);
      if (shared !== undefined) {
        entry = await shared;
      } else {
        const job = this.semaphore.run(async (): Promise<CachedRender> => {
          checkAbort(options.signal);
          if (engine === "formant") {
            const sampleRate = resolved.sampleRate ?? DEFAULT_SAMPLE_RATE;
            const compiled = await compileRequest(resolved, sampleRate, this.compileOptions(options));
            const renderStart = performance.now();
            const encoded = await encodePlanAsync(
              compiled.plan,
              options.signal === undefined ? {} : { signal: options.signal },
            );
            const renderMs = performance.now() - renderStart;
            timings = { readMs: compiled.readMs, planMs: compiled.planMs, renderMs, encodeMs: 0, totalMs: 0 };
            return {
              audio: encoded.audio,
              kana: compiled.plan.reading?.kana,
              chunks: compiled.plan.reading?.sentences.length ?? 1,
              warnings: compiled.plan.warnings,
              adjustments: compiled.plan.adjustments,
              stats: encoded.stats,
              voice: compiled.plan.voice.id,
            };
          }
          if (resolved.kind === "speech") {
            const speaker = styles.speaker;
            if (speaker === undefined) throw asKongyoroidError(new Error("speaker was not resolved"));
            const result = await synthesizeSpeech(this.client, resolved, speaker, {
              ...options,
              concurrency: this.concurrency,
            });
            return {
              audio: result.audio,
              kana: result.kana,
              chunks: result.chunks,
              warnings: [],
              adjustments: [],
              stats: undefined,
              voice: undefined,
            };
          }
          const singer = styles.singer;
          const teacher = styles.teacher;
          if (singer === undefined || teacher === undefined)
            throw asKongyoroidError(new Error("singer was not resolved"));
          const result = await synthesizeSong(this.client, resolved, singer, teacher, options);
          return {
            audio: result.audio,
            kana: undefined,
            chunks: 1,
            warnings: [],
            adjustments: [],
            stats: undefined,
            voice: undefined,
          };
        }, options.signal);
        if (key !== undefined) {
          this.inFlight.set(key, job);
          job
            .finally(() => {
              if (this.inFlight.get(key) === job) this.inFlight.delete(key);
            })
            .catch(() => undefined);
        }
        entry = await job;
        if (key !== undefined) await this.cacheSet(key, entry, cacheWarnings);
      }
    }
    checkAbort(options.signal);
    const total = performance.now() - start;
    const finalTimings: RenderTimings = { ...timings, totalMs: total };
    const warnings = cacheWarnings.length === 0 ? entry.warnings : [...entry.warnings, ...cacheWarnings];
    if (engine === "formant") {
      return this.formantResult(
        { ...entry, warnings },
        resolved.kind,
        cached !== undefined,
        parsed.requestHash,
        finalTimings,
      );
    }
    return {
      audio: entry.audio,
      info: audioInfo(inspectWav(entry.audio)),
      engine,
      kind: resolved.kind,
      voice: undefined,
      styles,
      kana: entry.kana,
      chunks: entry.chunks,
      cached: cached !== undefined,
      sha256: createHash("sha256").update(entry.audio).digest("hex"),
      requestHash: parsed.requestHash,
      elapsedMs: round(total),
      timings: { readMs: 0, planMs: 0, renderMs: round(total), encodeMs: 0, totalMs: round(total) },
      warnings,
      adjustments: [],
      peak: undefined,
      rms: undefined,
      limitedSamples: undefined,
      engineVersion: manifest?.version ?? "voicevox",
    };
  }

  public speak(input: string | SpeakInput, options: OperationOptions = {}): Promise<RenderResult> {
    return this.render({ kind: "speech", ...(typeof input === "string" ? { text: input } : input) }, options);
  }

  public sing(input: SingInput, options: OperationOptions = {}): Promise<RenderResult> {
    return this.render({ kind: "song", ...input }, options);
  }

  public async *renderStream(
    request: unknown,
    options: StreamOptions = {},
  ): AsyncGenerator<PcmBlock, { readonly plan: SynthesisPlan; readonly stats: RenderStats }, void> {
    const compiled = await this.compile(request, options.signal === undefined ? {} : { signal: options.signal });
    const iterator = renderPcmStream(compiled.plan, options);
    while (true) {
      const next = await iterator.next();
      if (next.done) return { plan: compiled.plan, stats: next.value };
      yield next.value;
    }
  }

  public speakStream(
    chunks: AsyncIterable<string>,
    input: Omit<SpeakInput, "text"> | Readonly<Record<string, unknown>> = {},
    options: Omit<TextStreamOptions, "dictionary"> = {},
  ): AsyncGenerator<TextStreamEvent, void, void> {
    const parsed = this.parse({ ...input, kind: "speech", text: "placeholder" });
    const request = parsed.request;
    if (request.kind !== "speech") invalid("$.kind", "Streaming synthesis needs a speech request.");
    if (request.engine === "voicevox") {
      invalid("$.engine", "Streaming synthesis is only available with the formant engine.", {
        hint: 'Set engine to "formant" (or "auto", which streams with the built-in engine) and drop the speaker.',
        repairOptions: [{ action: "use-formant-engine", description: "Use engine formant for streaming." }],
      });
    }
    const resolved: ResolvedSpeech = request.engine === "formant" ? request : { ...request, engine: "formant" };
    return synthesizeTextStream(chunks, resolved, {
      ...options,
      dictionary: this.dictionary,
      sampleRate: options.sampleRate ?? resolved.sampleRate ?? DEFAULT_SAMPLE_RATE,
    });
  }

  public async reading(text: string, options: ReadingOptions = {}): Promise<Reading> {
    const engine = await this.resolveEngine(
      options.engine ?? (options.speaker !== undefined ? "voicevox" : this.defaults.engine),
      options,
    );
    if (engine === "voicevox") {
      const speaker = await this.styles.resolve(options.speaker ?? this.defaults.speaker, "speaker", options);
      const phrases: readonly EngineAccentPhrase[] =
        options.kana === undefined
          ? (await this.client.audioQuery(text, speaker.id, options)).accent_phrases
          : await this.client.accentPhrases(
              formatKanaNotation(parseKanaNotation(options.kana, "$.kana")),
              speaker.id,
              true,
              options,
            );
      return {
        engine: "voicevox",
        frontend: "voicevox",
        kana: accentPhrasesToKana(phrases),
        speaker,
        warnings: [],
        dictionaryHits: [],
        sentences: [],
        phrases: phrases.map((phrase) => ({
          text: phrase.moras.map((mora) => mora.text).join(""),
          accent: phrase.accent,
          accentSource: "frontend",
          boundary: phrase.pause_mora !== null ? "pause" : "phrase",
          pause: phrase.pause_mora !== null,
          interrogative: phrase.is_interrogative,
          moras: phrase.moras.map((mora) => ({
            text: mora.text,
            consonant: mora.consonant,
            vowel: mora.vowel,
            consonantLength: mora.consonant_length,
            vowelLength: mora.vowel_length,
            pitch: mora.pitch,
          })),
        })),
      };
    }
    const request = this.parse({
      kind: "speech",
      text,
      ...(options.kana === undefined ? {} : { kana: options.kana }),
      ...(options.strict === undefined ? {} : { strictReading: options.strict }),
    }).request;
    if (request.kind !== "speech") invalid("$.kind", "Reading analysis needs a speech request.");
    const read = await readForRequest(request, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      dictionary: options.dictionary === undefined ? this.dictionary : this.dictionary.merge(options.dictionary),
    });
    return readingFromPlan(read.reading);
  }

  public async voices(options: VoicesOptions = {}): Promise<VoicesResult> {
    const engine = options.engine ?? "all";
    const kind = options.kind ?? "all";
    const voices: VoiceDescriptor[] = [];
    if (engine === "formant" || engine === "all" || engine === "auto") {
      for (const profile of BUILTIN_VOICES) {
        const described = describeVoice(profile);
        voices.push({
          id: described.id,
          engine: "formant",
          name: described.name,
          character: null,
          description: described.description,
          kinds: ["speech", "song"],
          styleId: null,
          type: null,
          baseF0: described.baseF0,
          f0Range: described.f0Range,
          hash: described.hash,
        });
      }
    }
    let voicevox: VoicesResult["voicevox"] = { queried: false, available: false, error: null };
    if (engine === "voicevox" || engine === "all" || engine === "auto") {
      try {
        const all = await this.styles.all(options);
        const filtered = all.filter((style) =>
          kind === "all"
            ? true
            : kind === "speech"
              ? style.type === "talk" || style.type === "streaming_talk"
              : style.type === "frame_decode" || style.type === "sing" || style.type === "singing_teacher",
        );
        for (const style of filtered) voices.push(voicevoxDescriptor(style));
        voicevox = { queried: true, available: true, error: null };
      } catch (error) {
        const failure = asKongyoroidError(error);
        if (failure.code === "ABORTED" || engine === "voicevox") throw failure;
        voicevox = { queried: true, available: false, error: failure.toJSON() };
      }
    }
    return { voices, voicevox };
  }

  public async doctor(options: DoctorOptions = {}): Promise<Diagnosis> {
    const engine = options.engine ?? this.defaults.engine;
    const checkVoicevox = engine === "voicevox" || engine === "auto" || engine === "all";
    const checkFormant = engine === "formant" || engine === "auto" || engine === "all" || options.frontend === true;
    let frontend: FrontendDiagnosis = { available: false, version: FRONTEND_VERSION, loadMs: null, error: null };
    let synthesis: Diagnosis["formant"]["synthesis"] = { ok: false, ms: 0, frames: 0, error: null };
    if (checkFormant) {
      const started = performance.now();
      try {
        await loadFrontend();
        frontend = {
          available: true,
          version: FRONTEND_VERSION,
          loadMs: round(performance.now() - started),
          error: null,
        };
      } catch (error) {
        frontend = {
          available: false,
          version: FRONTEND_VERSION,
          loadMs: round(performance.now() - started),
          error: asKongyoroidError(error).toJSON(),
        };
      }
      const synthStart = performance.now();
      try {
        const compiled = await this.compile(
          { kind: "speech", engine: "formant", text: "てすと", kana: "テ'_スト", prePause: 0, postPause: 0 },
          options,
        );
        const encoded = await encodePlanAsync(
          compiled.plan,
          options.signal === undefined ? {} : { signal: options.signal },
        );
        synthesis = {
          ok: encoded.audio.length > 44 && encoded.stats.peak > 0.01,
          ms: round(performance.now() - synthStart),
          frames: compiled.plan.frames,
          error: null,
        };
      } catch (error) {
        synthesis = {
          ok: false,
          ms: round(performance.now() - synthStart),
          frames: 0,
          error: asKongyoroidError(error).toJSON(),
        };
      }
    }
    let cache: Diagnosis["cache"] = { directory: this.diskCache?.directory ?? null, stats: null, error: null };
    if (this.cache !== undefined) {
      try {
        cache = { directory: this.diskCache?.directory ?? null, stats: await this.cache.stats(), error: null };
      } catch (error) {
        cache = { directory: this.diskCache?.directory ?? null, stats: null, error: asKongyoroidError(error).toJSON() };
      }
    }
    let voicevox: VoicevoxDiagnosis | null = null;
    if (checkVoicevox) voicevox = await this.voicevoxDoctor(options);
    const formantOk = !checkFormant || (frontend.available && synthesis.ok);
    const voicevoxOk = voicevox === null || voicevox.ok;
    const ok =
      engine === "auto"
        ? formantOk
        : engine === "all"
          ? formantOk && voicevoxOk
          : engine === "voicevox"
            ? voicevoxOk
            : formantOk;
    return {
      ok,
      name: PACKAGE_NAME,
      version: VERSION,
      engineVersion: ENGINE_VERSION,
      node: process.version,
      defaultEngine: this.defaults.engine,
      formant: { ok: formantOk, voices: BUILTIN_VOICES.map((voice) => voice.id), frontend, synthesis },
      cache,
      dictionary:
        this.dictionary.size === 0 ? null : { entries: this.dictionary.size, digest: this.dictionary.digest() },
      voicevox,
      error: ok ? null : (voicevox?.error ?? frontend.error ?? synthesis.error ?? null),
    };
  }

  public async voicevoxDoctor(options: OperationOptions = {}): Promise<VoicevoxDiagnosis> {
    let endpoint = "";
    try {
      endpoint = this.client.endpoint.origin;
      const version = await this.client.version(options);
      const manifest = await this.client.manifest(options);
      const devices = await this.client.supportedDevices(options).catch(() => null);
      const all = await this.styles.all(options);
      const count = (predicate: (style: VoiceStyle) => boolean): number => all.filter(predicate).length;
      return {
        ok: true,
        endpoint,
        version,
        manifest,
        devices,
        styles: {
          speech: count((s) => s.type === "talk" || s.type === "streaming_talk"),
          song: count((s) => s.type === "frame_decode" || s.type === "sing"),
          teacher: count((s) => s.type === "singing_teacher" || s.type === "sing"),
          total: all.length,
        },
        error: null,
      };
    } catch (error) {
      const failure = asKongyoroidError(error);
      if (failure.code === "ABORTED") throw failure;
      return {
        ok: false,
        endpoint,
        version: null,
        manifest: null,
        devices: null,
        styles: null,
        error: failure.toJSON(),
      };
    }
  }

  public inspect(audio: Uint8Array, options: InspectOptions = {}): InspectResult {
    const layout = inspectWav(audio);
    const decoded = decodeWav(audio);
    const stats = signalStats(decoded.samples);
    const window = Math.max(256, Math.round(((options.windowMs ?? 40) / 1000) * layout.sampleRate));
    const hop = Math.round(window / 2);
    const track: { seconds: number; hz: number; clarity: number }[] = [];
    const voiced: number[] = [];
    let windows = 0;
    for (let start = 0; start + window <= decoded.samples.length; start += hop) {
      windows += 1;
      const estimate = estimatePitch(decoded.samples, layout.sampleRate, start, start + window, 50, 1500);
      const frameStats = signalStats(decoded.samples, start, start + window);
      const isVoiced = estimate.clarity > 0.7 && frameStats.rms > 0.01;
      if (isVoiced) voiced.push(estimate.hz);
      if (options.pitchTrack === true)
        track.push({
          seconds: round(start / layout.sampleRate, 4),
          hz: isVoiced ? round(estimate.hz, 1) : 0,
          clarity: round(estimate.clarity, 3),
        });
    }
    const sorted = [...voiced].sort((a, b) => a - b);
    const median = sorted.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] ?? null);
    return {
      info: audioInfo(layout),
      bytes: audio.byteLength,
      sha256: createHash("sha256").update(audio).digest("hex"),
      peak: round(stats.peak, 4),
      rms: round(stats.rms, 4),
      dc: round(stats.dc, 5),
      clipped: stats.clipped,
      finite: stats.finite,
      pitch: {
        medianHz: median === null ? null : round(median, 1),
        minHz: sorted.length === 0 ? null : round(sorted[0] ?? 0, 1),
        maxHz: sorted.length === 0 ? null : round(sorted[sorted.length - 1] ?? 0, 1),
        voicedRatio: windows === 0 ? 0 : round(voiced.length / windows, 3),
        ...(options.pitchTrack === true ? { track } : {}),
      },
    };
  }

  public frontendStatus(): ReturnType<typeof frontendState> {
    return frontendState();
  }

  public voiceProfile(id?: string): VoiceProfile {
    return resolveVoice(id ?? this.defaults.voice, "$.voice");
  }

  public voiceHash(id?: string): string {
    return voiceProfileHash(this.voiceProfile(id));
  }
}

function voicevoxDescriptor(style: VoiceStyle): VoiceDescriptor {
  const speech = style.type === "talk" || style.type === "streaming_talk";
  return {
    id: `voicevox:${style.id}`,
    engine: "voicevox",
    name: style.name,
    character: style.character,
    description: null,
    kinds: speech ? ["speech"] : ["song"],
    styleId: style.id,
    type: style.type,
    baseF0: null,
    f0Range: null,
    hash: null,
  };
}

export function readingFromPlan(plan: ReadingPlan): Reading {
  return {
    engine: "formant",
    frontend: plan.frontend,
    kana: plan.kana,
    speaker: null,
    warnings: plan.warnings,
    dictionaryHits: plan.dictionaryHits.map((hit) => ({
      surface: hit.surface,
      reading: hit.reading,
      accent: hit.accent,
      source: hit.source,
      applied: hit.applied,
    })),
    sentences: plan.sentences.map((sentence) => ({
      text: sentence.text,
      kana: sentence.kana,
      start: sentence.sourceSpan.start,
      end: sentence.sourceSpan.end,
    })),
    phrases: plan.phrases.map((phrase) => ({
      text: phrase.moras.map((mora) => mora.text).join(""),
      accent: phrase.accent,
      accentSource: phrase.accentSource,
      boundary: phrase.boundary,
      pause: phrase.boundary !== "phrase" && phrase.boundary !== "end",
      interrogative: phrase.interrogative,
      moras: phrase.moras.map((mora) => ({
        text: mora.text,
        consonant: mora.consonant,
        vowel: mora.vowel,
        consonantLength: null,
        vowelLength: 0,
        pitch: 0,
      })),
    })),
  };
}

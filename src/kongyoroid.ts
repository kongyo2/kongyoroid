import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RenderCache } from "./cache.ts";
import { DiskCache, LayeredCache, MemoryCache, cacheKey } from "./cache.ts";
import { Semaphore } from "./concurrency.ts";
import type { ErrorData } from "./errors.ts";
import { KongyoroidError, asKongyoroidError, checkAbort } from "./errors.ts";
import { renderFormant } from "./formant.ts";
import { DEFAULT_SAMPLE_RATE, LIMITS } from "./limits.ts";
import { parseRequest, parseStyleRef } from "./request.ts";
import type {
  EngineId,
  EngineSelector,
  OperationOptions,
  RenderResult,
  RenderStyles,
  ResolvedRequest,
  SongRequest,
  SpeechRequest,
  StyleRef,
  StyleSelection,
  VoiceStyle,
} from "./types.ts";
import type { JsonObject } from "./validate.ts";
import { integer, isObject } from "./validate.ts";
import { VERSION } from "./version.ts";
import type { EngineAccentPhrase, EngineManifest, SupportedDevices } from "./voicevox/api.ts";
import type { VoicevoxClientOptions } from "./voicevox/client.ts";
import { VoicevoxClient } from "./voicevox/client.ts";
import { Dictionary } from "./voicevox/dictionary.ts";
import { accentPhrasesToKana, synthesizeSpeech } from "./voicevox/speech.ts";
import { synthesizeSong } from "./voicevox/song.ts";
import { StyleCatalog } from "./voicevox/styles.ts";
import { audioInfo, inspectWav } from "./wav.ts";

export interface KongyoroidOptions extends VoicevoxClientOptions {
  readonly engine?: EngineSelector;
  readonly speaker?: StyleRef;
  readonly singer?: StyleRef;
  readonly teacher?: StyleRef;
  readonly concurrency?: number;
  readonly cacheBytes?: number;
  readonly cacheDir?: string;
  readonly probeTimeoutMs?: number;
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
  readonly pause: boolean;
  readonly interrogative: boolean;
  readonly moras: readonly ReadingMora[];
}

export interface Reading {
  readonly kana: string;
  readonly phrases: readonly ReadingPhrase[];
  readonly speaker: StyleSelection;
}

export interface ReadingOptions extends OperationOptions {
  readonly speaker?: StyleRef;
  readonly kana?: string;
}

export interface Diagnosis {
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

export type VoiceKind = "speech" | "song" | "all";

interface CachedRender {
  readonly audio: Uint8Array;
  readonly kana: string | undefined;
  readonly chunks: number;
}

function packRender(entry: CachedRender): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ kana: entry.kana ?? null, chunks: entry.chunks }));
  const out = new Uint8Array(4 + meta.length + entry.audio.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, 4);
  out.set(entry.audio, 4 + meta.length);
  return out;
}

function unpackRender(bytes: Uint8Array): CachedRender | undefined {
  if (bytes.length < 4) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + length > bytes.length) return undefined;
  try {
    const meta: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    if (!isObject(meta)) return undefined;
    const audio = bytes.slice(4 + length);
    inspectWav(audio);
    return {
      audio,
      kana: typeof meta["kana"] === "string" ? meta["kana"] : undefined,
      chunks: typeof meta["chunks"] === "number" ? meta["chunks"] : 1,
    };
  } catch {
    return undefined;
  }
}

export class Kongyoroid {
  public readonly client: VoicevoxClient;
  public readonly styles: StyleCatalog;
  public readonly dictionary: Dictionary;
  private readonly defaults: {
    readonly engine: EngineSelector;
    readonly speaker: StyleRef | undefined;
    readonly singer: StyleRef | undefined;
    readonly teacher: StyleRef | undefined;
  };
  private readonly semaphore: Semaphore;
  private readonly cache: RenderCache;
  private readonly concurrency: number;
  private readonly probeTimeoutMs: number;
  private probe: Promise<EngineId> | undefined;

  public constructor(options: KongyoroidOptions = {}) {
    this.client = new VoicevoxClient(options);
    this.styles = new StyleCatalog(this.client);
    this.dictionary = new Dictionary(this.client);
    this.defaults = {
      engine: options.engine ?? "voicevox",
      speaker: options.speaker === undefined ? undefined : parseStyleRef(options.speaker, "$.speaker"),
      singer: options.singer === undefined ? undefined : parseStyleRef(options.singer, "$.singer"),
      teacher: options.teacher === undefined ? undefined : parseStyleRef(options.teacher, "$.teacher"),
    };
    this.concurrency = integer(options.concurrency ?? 2, "$.concurrency", 1, LIMITS.concurrency);
    this.semaphore = new Semaphore(this.concurrency);
    const memory = new MemoryCache(options.cacheBytes ?? 64 * 1024 * 1024);
    this.cache = options.cacheDir === undefined ? memory : new LayeredCache([memory, new DiskCache(options.cacheDir)]);
    this.probeTimeoutMs = integer(options.probeTimeoutMs ?? 3000, "$.probeTimeoutMs", 100, 600_000);
  }

  public clearCache(): Promise<void> {
    return this.cache.clear();
  }

  public withDefaults(request: unknown): unknown {
    if (!isObject(request)) return request;
    const merged: JsonObject = { ...request };
    if (merged["engine"] === undefined) merged["engine"] = this.defaults.engine;
    if (merged["kind"] === "speech" && merged["speaker"] === undefined && this.defaults.speaker !== undefined) {
      merged["speaker"] = this.defaults.speaker;
    }
    if (merged["kind"] === "song") {
      if (merged["singer"] === undefined && this.defaults.singer !== undefined) merged["singer"] = this.defaults.singer;
      if (merged["teacher"] === undefined && this.defaults.teacher !== undefined)
        merged["teacher"] = this.defaults.teacher;
    }
    return merged;
  }

  public resolveEngine(selector: EngineSelector, options: OperationOptions = {}): Promise<EngineId> {
    if (selector !== "auto") return Promise.resolve(selector);
    this.probe ??= this.client
      .version({
        signal:
          options.signal === undefined
            ? AbortSignal.timeout(this.probeTimeoutMs)
            : AbortSignal.any([options.signal, AbortSignal.timeout(this.probeTimeoutMs)]),
      })
      .then((): EngineId => "voicevox")
      .catch((error: unknown): EngineId => {
        if (error instanceof KongyoroidError && error.code === "ABORTED") throw error;
        return "formant";
      });
    return this.probe;
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

  public async render(request: unknown, options: OperationOptions = {}): Promise<RenderResult> {
    const start = performance.now();
    checkAbort(options.signal);
    const resolved = parseRequest(this.withDefaults(request));
    const engine = await this.resolveEngine(resolved.engine, options);
    const styles = engine === "voicevox" ? await this.resolveStyles(resolved, options) : {};
    const manifest = engine === "voicevox" ? await this.client.manifest(options) : undefined;
    const key = cacheKey(
      engine,
      VERSION,
      engine === "voicevox" ? [this.client.endpoint.origin, manifest?.version ?? "", styles] : [],
      resolved,
    );
    const cached = unpackRender((await this.cache.get(key)) ?? new Uint8Array(0));
    const entry =
      cached ??
      (await this.semaphore.run(async (): Promise<CachedRender> => {
        checkAbort(options.signal);
        if (engine === "formant") {
          const audio = renderFormant(resolved, resolved.sampleRate ?? DEFAULT_SAMPLE_RATE, options);
          return { audio, kana: resolved.kind === "speech" ? resolved.kana : undefined, chunks: 1 };
        }
        if (resolved.kind === "speech") {
          const speaker = styles.speaker;
          if (speaker === undefined) throw asKongyoroidError(new Error("speaker was not resolved"));
          const result = await synthesizeSpeech(this.client, resolved, speaker, {
            ...options,
            concurrency: this.concurrency,
          });
          return { audio: result.audio, kana: result.kana, chunks: result.chunks };
        }
        const singer = styles.singer;
        const teacher = styles.teacher;
        if (singer === undefined || teacher === undefined) {
          throw asKongyoroidError(new Error("singer was not resolved"));
        }
        const result = await synthesizeSong(this.client, resolved, singer, teacher, options);
        return { audio: result.audio, kana: undefined, chunks: 1 };
      }, options.signal));
    if (cached === undefined) await this.cache.set(key, packRender(entry));
    return {
      audio: entry.audio,
      info: audioInfo(inspectWav(entry.audio)),
      engine,
      kind: resolved.kind,
      styles,
      kana: entry.kana,
      chunks: entry.chunks,
      cached: cached !== undefined,
      sha256: createHash("sha256").update(entry.audio).digest("hex"),
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  public speak(input: string | SpeakInput, options: OperationOptions = {}): Promise<RenderResult> {
    return this.render({ kind: "speech", ...(typeof input === "string" ? { text: input } : input) }, options);
  }

  public sing(input: SingInput, options: OperationOptions = {}): Promise<RenderResult> {
    return this.render({ kind: "song", ...input }, options);
  }

  public async reading(text: string, options: ReadingOptions = {}): Promise<Reading> {
    const speaker = await this.styles.resolve(options.speaker ?? this.defaults.speaker, "speaker", options);
    const phrases: readonly EngineAccentPhrase[] =
      options.kana === undefined
        ? (await this.client.audioQuery(text, speaker.id, options)).accent_phrases
        : await this.client.accentPhrases(options.kana, speaker.id, true, options);
    return {
      kana: accentPhrasesToKana(phrases),
      speaker,
      phrases: phrases.map((phrase) => ({
        text: phrase.moras.map((mora) => mora.text).join(""),
        accent: phrase.accent,
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

  public async voices(kind: VoiceKind = "all", options: OperationOptions = {}): Promise<readonly VoiceStyle[]> {
    const all = await this.styles.all(options);
    if (kind === "all") return all;
    return all.filter((style) =>
      kind === "speech"
        ? style.type === "talk" || style.type === "streaming_talk"
        : style.type === "frame_decode" || style.type === "sing" || style.type === "singing_teacher",
    );
  }

  public async doctor(options: OperationOptions = {}): Promise<Diagnosis> {
    const endpoint = this.client.endpoint.origin;
    try {
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
}

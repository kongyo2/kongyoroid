import { setTimeout as sleep } from "node:timers/promises";
import { KongyoroidError, checkAbort, invalid } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import type { EngineScore } from "../score.ts";
import type { OperationOptions, VoiceStyle } from "../types.ts";
import { integer } from "../validate.ts";
import type {
  AudioQuery,
  DictionaryWord,
  EngineAccentPhrase,
  EngineManifest,
  FrameAudioQuery,
  SupportedDevices,
  WordType,
} from "./api.ts";
import {
  protocolError,
  readAccentPhrases,
  readAudioQuery,
  readBoolean,
  readDictionary,
  readFrameAudioQuery,
  readManifest,
  readString,
  readStyles,
  readSupportedDevices,
} from "./api.ts";

export const DEFAULT_ENDPOINT: string = "http://127.0.0.1:50021";

export interface VoicevoxClientOptions {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DictionaryWordInput {
  readonly surface: string;
  readonly pronunciation: string;
  readonly accentType: number;
  readonly wordType?: WordType;
  readonly priority?: number;
}

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

interface RequestSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly query?: Query;
  readonly body?: unknown;
  readonly accept?: string;
  readonly idempotent?: boolean;
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function decodeDetail(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8").decode(bytes).slice(0, 4000);
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "detail" in parsed ? parsed.detail : parsed;
  } catch {
    return text;
  }
}

function describeDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item: unknown) => {
        if (typeof item === "object" && item !== null && "msg" in item) {
          const loc = "loc" in item && Array.isArray(item.loc) ? item.loc.join(".") : "";
          return loc.length > 0 ? `${loc}: ${String(item.msg)}` : String(item.msg);
        }
        return JSON.stringify(item);
      })
      .join("; ");
  }
  if (typeof detail === "object" && detail !== null && "text" in detail) return String(detail.text);
  return JSON.stringify(detail);
}

export class VoicevoxClient {
  public readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private manifestCache: Promise<EngineManifest> | undefined;
  private versionCache: Promise<string> | undefined;

  public constructor(options: VoicevoxClientOptions = {}) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    } catch (error) {
      throw new KongyoroidError(
        { code: "INVALID_INPUT", path: "$.endpoint", message: "Invalid VOICEVOX endpoint URL.", retryable: false },
        error,
      );
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      invalid("$.endpoint", "The VOICEVOX endpoint must use http or https.");
    }
    endpoint.search = "";
    endpoint.hash = "";
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/`;
    this.endpoint = endpoint;
    this.timeoutMs = integer(options.timeoutMs ?? 120_000, "$.timeoutMs", 100, 3_600_000);
    this.retries = integer(options.retries ?? 1, "$.retries", 0, 5);
    this.maxResponseBytes = integer(
      options.maxResponseBytes ?? LIMITS.responseBytes,
      "$.maxResponseBytes",
      1024,
      4_294_967_295,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
  }

  private url(path: string, query: Query | undefined): URL {
    const url = new URL(path, this.endpoint);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async readBody(response: Response, path: string): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > this.maxResponseBytes) {
      await response.body?.cancel();
      throw protocolError(`${path} response exceeds ${this.maxResponseBytes} bytes`);
    }
    if (response.body === null) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > this.maxResponseBytes) {
        await reader.cancel();
        throw protocolError(`${path} response exceeds ${this.maxResponseBytes} bytes`);
      }
      chunks.push(value);
      return pump();
    };
    try {
      await pump();
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  private async attempt(spec: RequestSpec, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(spec.path, spec.query), {
        method: spec.method,
        headers: {
          accept: spec.accept ?? "application/json",
          ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
          ...this.headers,
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: combined,
        redirect: "error",
      });
    } catch (error) {
      checkAbort(signal);
      if (timeout.aborted) {
        throw new KongyoroidError(
          {
            code: "TIMEOUT",
            message: `VOICEVOX ${spec.path} did not respond within ${this.timeoutMs} ms.`,
            retryable: true,
            hint: "Raise --timeout-ms for long inputs, or split the text into shorter requests.",
          },
          error,
        );
      }
      throw new KongyoroidError(
        {
          code: "ENGINE_UNAVAILABLE",
          message: `Could not reach VOICEVOX ENGINE at ${this.endpoint.origin}: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          hint: "Start VOICEVOX ENGINE (default http://127.0.0.1:50021), pass --endpoint, or use --engine formant.",
        },
        error,
      );
    }
    if (response.ok) {
      try {
        return await this.readBody(response, spec.path);
      } catch (error) {
        checkAbort(signal);
        if (timeout.aborted) {
          throw new KongyoroidError(
            { code: "TIMEOUT", message: `VOICEVOX ${spec.path} timed out while streaming.`, retryable: true },
            error,
          );
        }
        throw error;
      }
    }
    const bytes = await this.readBody(response, spec.path).catch(() => new Uint8Array(0));
    const detail = decodeDetail(bytes);
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    if (RETRYABLE_STATUS.has(response.status)) {
      throw new KongyoroidError({
        code: "ENGINE_HTTP",
        message: `VOICEVOX ${spec.path} returned HTTP ${response.status}: ${describeDetail(detail)}`,
        status: response.status,
        retryable: true,
        detail: { ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }), body: detail },
      });
    }
    throw new KongyoroidError({
      code: "ENGINE_REJECTED",
      message: `VOICEVOX ${spec.path} rejected the request (HTTP ${response.status}): ${describeDetail(detail)}`,
      status: response.status,
      retryable: false,
      detail,
      hint:
        response.status === 404
          ? "The endpoint is not a VOICEVOX ENGINE or this engine version lacks the feature."
          : "Check the style id with the voices command and the input against the schema command.",
    });
  }

  public async request(spec: RequestSpec, options: OperationOptions = {}): Promise<Uint8Array> {
    const run = async (attempt: number): Promise<Uint8Array> => {
      checkAbort(options.signal);
      try {
        return await this.attempt(spec, options.signal);
      } catch (error) {
        if (
          !(error instanceof KongyoroidError) ||
          !error.retryable ||
          spec.idempotent === false ||
          attempt >= this.retries
        ) {
          throw error;
        }
        const hinted =
          typeof error.detail === "object" && error.detail !== null && "retryAfterMs" in error.detail
            ? Number(error.detail.retryAfterMs)
            : undefined;
        const delay = Math.min(5000, hinted ?? 200 * 2 ** attempt);
        await sleep(delay, undefined, options.signal === undefined ? {} : { signal: options.signal }).catch(() => {
          checkAbort(options.signal);
        });
        return run(attempt + 1);
      }
    };
    return run(0);
  }

  public async json(spec: RequestSpec, options: OperationOptions = {}): Promise<unknown> {
    const bytes = await this.request(spec, options);
    if (bytes.length === 0) return null;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      throw protocolError(`${spec.path} did not return JSON`, error instanceof Error ? error.message : String(error));
    }
  }

  public version(options: OperationOptions = {}): Promise<string> {
    this.versionCache ??= this.json({ method: "GET", path: "version" }, options)
      .then((value) => readString(value, "version"))
      .catch((error: unknown) => {
        this.versionCache = undefined;
        throw error;
      });
    return this.versionCache;
  }

  public manifest(options: OperationOptions = {}): Promise<EngineManifest> {
    this.manifestCache ??= this.json({ method: "GET", path: "engine_manifest" }, options)
      .then(readManifest)
      .catch((error: unknown) => {
        this.manifestCache = undefined;
        throw error;
      });
    return this.manifestCache;
  }

  public async supportedDevices(options: OperationOptions = {}): Promise<SupportedDevices> {
    return readSupportedDevices(await this.json({ method: "GET", path: "supported_devices" }, options));
  }

  public async speakers(options: OperationOptions = {}): Promise<readonly VoiceStyle[]> {
    return readStyles(await this.json({ method: "GET", path: "speakers" }, options));
  }

  public async singers(options: OperationOptions = {}): Promise<readonly VoiceStyle[]> {
    return readStyles(await this.json({ method: "GET", path: "singers" }, options));
  }

  public async audioQuery(text: string, styleId: number, options: OperationOptions = {}): Promise<AudioQuery> {
    return readAudioQuery(
      await this.json({ method: "POST", path: "audio_query", query: { text, speaker: styleId } }, options),
    );
  }

  public async accentPhrases(
    text: string,
    styleId: number,
    isKana: boolean,
    options: OperationOptions = {},
  ): Promise<readonly EngineAccentPhrase[]> {
    return readAccentPhrases(
      await this.json(
        { method: "POST", path: "accent_phrases", query: { text, speaker: styleId, is_kana: isKana } },
        options,
      ),
    );
  }

  public async moraData(
    phrases: readonly EngineAccentPhrase[],
    styleId: number,
    options: OperationOptions = {},
  ): Promise<readonly EngineAccentPhrase[]> {
    return readAccentPhrases(
      await this.json({ method: "POST", path: "mora_data", query: { speaker: styleId }, body: phrases }, options),
    );
  }

  public synthesis(
    query: AudioQuery,
    styleId: number,
    upspeak: boolean,
    options: OperationOptions = {},
  ): Promise<Uint8Array> {
    return this.request(
      {
        method: "POST",
        path: "synthesis",
        query: { speaker: styleId, enable_interrogative_upspeak: upspeak },
        body: query,
        accept: "audio/wav",
      },
      options,
    );
  }

  public async singFrameAudioQuery(
    score: EngineScore,
    styleId: number,
    options: OperationOptions = {},
  ): Promise<FrameAudioQuery> {
    return readFrameAudioQuery(
      await this.json(
        { method: "POST", path: "sing_frame_audio_query", query: { speaker: styleId }, body: score },
        options,
      ),
    );
  }

  public frameSynthesis(query: FrameAudioQuery, styleId: number, options: OperationOptions = {}): Promise<Uint8Array> {
    return this.request(
      { method: "POST", path: "frame_synthesis", query: { speaker: styleId }, body: query, accept: "audio/wav" },
      options,
    );
  }

  public async initializeSpeaker(
    styleId: number,
    skipReinit: boolean = true,
    options: OperationOptions = {},
  ): Promise<void> {
    await this.request(
      { method: "POST", path: "initialize_speaker", query: { speaker: styleId, skip_reinit: skipReinit } },
      options,
    );
  }

  public async isInitializedSpeaker(styleId: number, options: OperationOptions = {}): Promise<boolean> {
    return readBoolean(
      await this.json({ method: "GET", path: "is_initialized_speaker", query: { speaker: styleId } }, options),
      "is_initialized_speaker",
    );
  }

  public async validateKana(text: string, options: OperationOptions = {}): Promise<boolean> {
    return readBoolean(
      await this.json({ method: "POST", path: "validate_kana", query: { text } }, options),
      "validate_kana",
    );
  }

  public async dictionary(options: OperationOptions = {}): Promise<readonly DictionaryWord[]> {
    return readDictionary(await this.json({ method: "GET", path: "user_dict" }, options));
  }

  public async addDictionaryWord(word: DictionaryWordInput, options: OperationOptions = {}): Promise<string> {
    const uuid = await this.json(
      {
        method: "POST",
        path: "user_dict_word",
        idempotent: false,
        query: {
          surface: word.surface,
          pronunciation: word.pronunciation,
          accent_type: word.accentType,
          word_type: word.wordType,
          priority: word.priority,
        },
      },
      options,
    );
    return readString(uuid, "user_dict_word");
  }

  public async updateDictionaryWord(
    uuid: string,
    word: DictionaryWordInput,
    options: OperationOptions = {},
  ): Promise<void> {
    await this.request(
      {
        method: "PUT",
        path: `user_dict_word/${encodeURIComponent(uuid)}`,
        query: {
          surface: word.surface,
          pronunciation: word.pronunciation,
          accent_type: word.accentType,
          word_type: word.wordType,
          priority: word.priority,
        },
      },
      options,
    );
  }

  public async deleteDictionaryWord(uuid: string, options: OperationOptions = {}): Promise<void> {
    await this.request({ method: "DELETE", path: `user_dict_word/${encodeURIComponent(uuid)}` }, options);
  }
}

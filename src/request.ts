import { invalid } from "./errors.ts";
import { DEFAULT_SAMPLE_RATE, LIMITS, SAMPLE_RATE_RANGE } from "./limits.ts";
import { parseKanaNotation } from "./notation.ts";
import { SONG_PROPERTIES, SPEECH_PROPERTIES } from "./schema.ts";
import { MAX_NOTES, parseNotes, resolveNotes, scoreSeconds, transposeInput } from "./score.ts";
import type {
  EngineSelector,
  ResolvedRequest,
  ResolvedSong,
  ResolvedSpeech,
  SongRequest,
  SpeechRequest,
  StyleRef,
} from "./types.ts";
import type { JsonObject } from "./validate.ts";
import { boolean, has, integer, keys, literal, number, object, optional, string } from "./validate.ts";

const ENGINES: readonly EngineSelector[] = ["voicevox", "formant", "auto"];

export function parseEngine(value: unknown, path: string = "$.engine"): EngineSelector {
  return literal(value, path, ENGINES);
}

export function parseStyleRef(value: unknown, path: string): StyleRef {
  if (typeof value === "number") return integer(value, path, 0, 4_294_967_295);
  if (typeof value === "string") {
    const name = value.trim();
    if (name.length === 0 || name.length > 200) invalid(path, "Expected a style id or a non-empty style name.");
    return /^\d+$/u.test(name) ? Number(name) : name;
  }
  return invalid(path, "Expected a style id (integer) or a style name (string).");
}

function parseSampleRate(value: unknown, path: string): number {
  return integer(value, path, SAMPLE_RATE_RANGE.min, SAMPLE_RATE_RANGE.max);
}

function parseSeed(value: unknown, path: string): number {
  return integer(value, path, 1, 4_294_967_295);
}

function parseCommon(o: JsonObject): {
  readonly engine: EngineSelector;
  readonly sampleRate: number | undefined;
  readonly volume: number;
  readonly seed: number;
} {
  return {
    engine: optional(o, "engine", "$", "voicevox", parseEngine),
    sampleRate: has(o, "sampleRate") ? parseSampleRate(o["sampleRate"], "$.sampleRate") : undefined,
    volume: optional(o, "volume", "$", 1, (v, p) => number(v, p, 0, 3)),
    seed: optional(o, "seed", "$", 1, parseSeed),
  };
}

export function parseSpeechRequest(o: JsonObject): ResolvedSpeech {
  keys(o, Object.keys(SPEECH_PROPERTIES), "$");
  const text = string(o["text"], "$.text", 1, LIMITS.textChars);
  if (text.trim().length === 0) invalid("$.text", "Text must not be blank.");
  const kana = has(o, "kana") ? string(o["kana"], "$.kana", 1, LIMITS.kanaChars) : undefined;
  if (kana !== undefined) parseKanaNotation(kana, "$.kana");
  return {
    kind: "speech",
    ...parseCommon(o),
    text,
    kana,
    speaker: has(o, "speaker") ? parseStyleRef(o["speaker"], "$.speaker") : undefined,
    speed: optional(o, "speed", "$", 1, (v, p) => number(v, p, 0.25, 4)),
    pitch: optional(o, "pitch", "$", 0, (v, p) => number(v, p, -1, 1)),
    intonation: optional(o, "intonation", "$", 1, (v, p) => number(v, p, 0, 3)),
    prePause: optional(o, "prePause", "$", 0.1, (v, p) => number(v, p, 0, 10)),
    postPause: optional(o, "postPause", "$", 0.1, (v, p) => number(v, p, 0, 10)),
    pauseLength: has(o, "pauseLength") ? number(o["pauseLength"], "$.pauseLength", 0, 10) : undefined,
    pauseScale: optional(o, "pauseScale", "$", 1, (v, p) => number(v, p, 0, 10)),
    upspeak: optional(o, "upspeak", "$", true, boolean),
    split: optional(o, "split", "$", "sentence", (v, p) => literal(v, p, ["sentence", "paragraph", "none"])),
  };
}

export function parseSongRequest(o: JsonObject): ResolvedSong {
  keys(o, Object.keys(SONG_PROPERTIES), "$");
  const tempo = optional(o, "tempo", "$", 120, (v, p) => number(v, p, 20, 400));
  const transpose = optional(o, "transpose", "$", 0, transposeInput);
  const inputNotes = parseNotes(o["notes"], "$.notes");
  if (inputNotes.length > MAX_NOTES) invalid("$.notes", `A score is limited to ${MAX_NOTES} notes.`);
  const notes = resolveNotes(inputNotes, "$.notes", transpose);
  const leadIn = optional(o, "leadIn", "$", 0.16, (v, p) => number(v, p, 0, 5));
  const leadOut = optional(o, "leadOut", "$", 0.16, (v, p) => number(v, p, 0, 5));
  const seconds = scoreSeconds(notes, tempo) + leadIn + leadOut;
  if (seconds > LIMITS.audioSeconds) {
    invalid("$.notes", `The score lasts ${seconds.toFixed(1)} s; the limit is ${LIMITS.audioSeconds} s.`);
  }
  return {
    kind: "song",
    ...parseCommon(o),
    notes,
    tempo,
    singer: has(o, "singer") ? parseStyleRef(o["singer"], "$.singer") : undefined,
    teacher: has(o, "teacher") ? parseStyleRef(o["teacher"], "$.teacher") : undefined,
    transpose,
    vibratoDepth: has(o, "vibratoDepth") ? number(o["vibratoDepth"], "$.vibratoDepth", 0, 200) : undefined,
    vibratoRate: optional(o, "vibratoRate", "$", 5.5, (v, p) => number(v, p, 0, 12)),
    leadIn,
    leadOut,
  };
}

export function parseRequest(value: unknown): ResolvedRequest {
  const o = object(value, "$");
  const kind = literal(o["kind"], "$.kind", ["speech", "song"]);
  return kind === "speech" ? parseSpeechRequest(o) : parseSongRequest(o);
}

export function speechRequest(input: Omit<SpeechRequest, "kind">): SpeechRequest {
  return { kind: "speech", ...input };
}

export function songRequest(input: Omit<SongRequest, "kind">): SongRequest {
  return { kind: "song", ...input };
}

export function parseJson(text: string, path: string = "$"): unknown {
  if (Buffer.byteLength(text, "utf8") > LIMITS.inputBytes) {
    invalid(path, `Input exceeds ${LIMITS.inputBytes} bytes.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return invalid(path, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function effectiveSampleRate(request: ResolvedRequest, engineDefault: number = DEFAULT_SAMPLE_RATE): number {
  return request.sampleRate ?? engineDefault;
}

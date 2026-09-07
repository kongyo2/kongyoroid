import { createHash } from "node:crypto";
import { invalid } from "./errors.ts";
import { DEFAULT_SAMPLE_RATE, LIMITS, SAMPLE_RATE_RANGE } from "./limits.ts";
import { MAX_NOTES, parseNotes, resolveNotes, scoreSeconds, transposeInput } from "./song/score.ts";
import { SONG_PROPERTIES, SPEECH_PROPERTIES } from "./schema.ts";
import { parseDictionaryEntries } from "./text/dictionary.ts";
import { formatKanaNotation, parseKanaNotation } from "./text/notation.ts";
import { DEFAULT_VOICE_ID, resolveVoice } from "./synth/voice.ts";
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
import { boolean, has, integer, isObject, keys, literal, number, object, optional, string } from "./validate.ts";

const ENGINES: readonly EngineSelector[] = ["voicevox", "formant", "auto"];

export function parseEngine(value: unknown, path: string = "$.engine"): EngineSelector {
  return literal(value, path, ENGINES);
}

export function parseStyleRef(value: unknown, path: string): StyleRef {
  if (typeof value === "number") return integer(value, path, 0, 4_294_967_295);
  if (typeof value === "string") {
    const name = value.trim();
    if (name.length === 0 || name.length > 200) invalid(path, "Expected a style id or a non-empty style name.");
    if (/^\d+$/u.test(name)) return integer(Number(name), path, 0, 4_294_967_295);
    return name;
  }
  return invalid(path, "Expected a style id (integer) or a style name (string).");
}

function parseSampleRate(value: unknown, path: string): number {
  return integer(value, path, SAMPLE_RATE_RANGE.min, SAMPLE_RATE_RANGE.max);
}

function parseSeed(value: unknown, path: string): number {
  return integer(value, path, 1, 4_294_967_295);
}

function parseVolume(o: JsonObject): number {
  const hasVolume = has(o, "volume");
  const hasGain = has(o, "gainDb");
  if (hasVolume && hasGain) invalid("$.gainDb", "Give either volume or gainDb, not both.");
  if (hasGain) return 10 ** (number(o["gainDb"], "$.gainDb", -60, 12) / 20);
  return hasVolume ? number(o["volume"], "$.volume", 0, 3) : 1;
}

function parseCommon(o: JsonObject): {
  readonly engine: EngineSelector;
  readonly voice: string;
  readonly sampleRate: number | undefined;
  readonly volume: number;
  readonly seed: number;
  readonly breathiness: number;
} {
  const implied: EngineSelector = has(o, "speaker") || has(o, "singer") || has(o, "teacher") ? "voicevox" : "formant";
  const engine = optional(o, "engine", "$", implied, parseEngine);
  const voiceRaw = has(o, "voice") ? string(o["voice"], "$.voice", 1, 100) : DEFAULT_VOICE_ID;
  const voice = resolveVoice(voiceRaw, "$.voice").id;
  if (engine === "formant" && (has(o, "speaker") || has(o, "singer") || has(o, "teacher"))) {
    invalid(
      has(o, "speaker") ? "$.speaker" : has(o, "singer") ? "$.singer" : "$.teacher",
      "VOICEVOX styles (speaker/singer/teacher) cannot be combined with engine formant.",
      {
        hint: 'Remove the style, or set engine to "voicevox" or "auto".',
      },
    );
  }
  return {
    engine,
    voice,
    sampleRate: has(o, "sampleRate") ? parseSampleRate(o["sampleRate"], "$.sampleRate") : undefined,
    volume: parseVolume(o),
    seed: optional(o, "seed", "$", 1, parseSeed),
    breathiness: optional(o, "breathiness", "$", 0, (v, p) => number(v, p, -1, 1.5)),
  };
}

export function parseSpeechRequest(o: JsonObject): ResolvedSpeech {
  keys(o, Object.keys(SPEECH_PROPERTIES), "$");
  const text = string(o["text"], "$.text", 1, LIMITS.textChars);
  if (text.trim().length === 0) invalid("$.text", "Text must not be blank.");
  const kana = has(o, "kana")
    ? formatKanaNotation(parseKanaNotation(string(o["kana"], "$.kana", 1, LIMITS.kanaChars), "$.kana"))
    : undefined;
  const hasPitch = has(o, "pitch");
  const hasSemitones = has(o, "pitchSemitones");
  if (hasPitch && hasSemitones)
    invalid("$.pitchSemitones", "Give either pitch (VOICEVOX pitchScale semantics) or pitchSemitones, not both.");
  const common = parseCommon(o);
  return {
    kind: "speech",
    ...common,
    text,
    kana,
    dictionary: has(o, "dictionary") ? parseDictionaryEntries(o["dictionary"], "$.dictionary") : [],
    strictReading: optional(o, "strictReading", "$", true, boolean),
    speaker: has(o, "speaker") ? parseStyleRef(o["speaker"], "$.speaker") : undefined,
    speed: optional(o, "speed", "$", 1, (v, p) => number(v, p, 0.25, 4)),
    pitch: hasPitch ? number(o["pitch"], "$.pitch", -1, 1) : undefined,
    pitchSemitones: optional(o, "pitchSemitones", "$", 0, (v, p) => number(v, p, -24, 24)),
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
  const parsedNotes = parseNotes(o["notes"], "$.notes");
  const tempo = has(o, "tempo") ? number(o["tempo"], "$.tempo", 20, 400) : (parsedNotes.tempo ?? 120);
  const transpose = optional(o, "transpose", "$", 0, transposeInput);
  if (parsedNotes.notes.length > MAX_NOTES) invalid("$.notes", `A score is limited to ${MAX_NOTES} notes.`);
  const notes = resolveNotes(parsedNotes.notes, "$.notes", transpose);
  const leadIn = optional(o, "leadIn", "$", 0.16, (v, p) => number(v, p, 0, 5));
  const leadOut = optional(o, "leadOut", "$", 0.16, (v, p) => number(v, p, 0, 5));
  const seconds = scoreSeconds(notes, tempo) + leadIn + leadOut;
  if (seconds > LIMITS.audioSeconds) {
    invalid("$.notes", `The score lasts ${seconds.toFixed(1)} s; the limit is ${LIMITS.audioSeconds} s.`);
  }
  const vibratoObject = has(o, "vibrato") ? object(o["vibrato"], "$.vibrato") : undefined;
  if (vibratoObject !== undefined) {
    keys(vibratoObject, ["depthCents", "rateHz", "delayMs", "fadeMs"], "$.vibrato");
    if (has(o, "vibratoDepth") || has(o, "vibratoRate"))
      invalid("$.vibrato", "Give either vibrato {…} or vibratoDepth/vibratoRate, not both.");
  }
  const vibratoDepth =
    vibratoObject !== undefined && has(vibratoObject, "depthCents")
      ? number(vibratoObject["depthCents"], "$.vibrato.depthCents", 0, 200)
      : has(o, "vibratoDepth")
        ? number(o["vibratoDepth"], "$.vibratoDepth", 0, 200)
        : undefined;
  const vibratoRate =
    vibratoObject !== undefined && has(vibratoObject, "rateHz")
      ? number(vibratoObject["rateHz"], "$.vibrato.rateHz", 0, 12)
      : optional(o, "vibratoRate", "$", 5.5, (v, p) => number(v, p, 0, 12));
  const vibratoDelayMs =
    vibratoObject !== undefined && has(vibratoObject, "delayMs")
      ? number(vibratoObject["delayMs"], "$.vibrato.delayMs", 0, 5000)
      : 180;
  const vibratoFadeMs =
    vibratoObject !== undefined && has(vibratoObject, "fadeMs")
      ? number(vibratoObject["fadeMs"], "$.vibrato.fadeMs", 0, 5000)
      : 250;
  const common = parseCommon(o);
  return {
    kind: "song",
    ...common,
    notes,
    tempo,
    singer: has(o, "singer") ? parseStyleRef(o["singer"], "$.singer") : undefined,
    teacher: has(o, "teacher") ? parseStyleRef(o["teacher"], "$.teacher") : undefined,
    transpose,
    vibratoDepth,
    vibratoRate,
    vibratoDelayMs,
    vibratoFadeMs,
    portamentoMs: has(o, "portamentoMs") ? number(o["portamentoMs"], "$.portamentoMs", 0, 2000) : undefined,
    scoopCents: optional(o, "scoopCents", "$", 0, (v, p) => number(v, p, 0, 1200)),
    scoopMs: optional(o, "scoopMs", "$", 80, (v, p) => number(v, p, 0, 2000)),
    consonantCompression: optional(o, "consonantCompression", "$", true, boolean),
    leadIn,
    leadOut,
    form: parsedNotes.form,
  };
}

export function parseRequest(value: unknown): ResolvedRequest {
  const o = object(value, "$");
  if (has(o, "schemaVersion")) {
    const version = o["schemaVersion"];
    if (version !== 1 && version !== 2) invalid("$.schemaVersion", "Supported schema versions: 1, 2.");
    const rest: JsonObject = { ...o };
    delete rest["schemaVersion"];
    return parseRequest(rest);
  }
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

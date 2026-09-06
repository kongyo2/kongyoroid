import { KongyoroidError } from "../errors.ts";
import type { StyleType, VoiceStyle } from "../types.ts";
import type { JsonObject } from "../validate.ts";
import { isObject } from "../validate.ts";

export interface EngineMora {
  readonly text: string;
  readonly consonant: string | null;
  readonly consonant_length: number | null;
  readonly vowel: string;
  readonly vowel_length: number;
  readonly pitch: number;
}

export interface EngineAccentPhrase {
  readonly moras: readonly EngineMora[];
  readonly accent: number;
  readonly pause_mora: EngineMora | null;
  readonly is_interrogative: boolean;
}

export interface AudioQuery {
  readonly accent_phrases: readonly EngineAccentPhrase[];
  readonly speedScale: number;
  readonly pitchScale: number;
  readonly intonationScale: number;
  readonly volumeScale: number;
  readonly prePhonemeLength: number;
  readonly postPhonemeLength: number;
  readonly pauseLength: number | null;
  readonly pauseLengthScale: number;
  readonly outputSamplingRate: number;
  readonly outputStereo: boolean;
  readonly kana: string;
}

export interface FramePhoneme {
  readonly phoneme: string;
  readonly frame_length: number;
  readonly note_id: string | null;
}

export interface FrameAudioQuery {
  readonly f0: readonly number[];
  readonly volume: readonly number[];
  readonly phonemes: readonly FramePhoneme[];
  readonly volumeScale: number;
  readonly outputSamplingRate: number;
  readonly outputStereo: boolean;
}

export interface EngineManifest {
  readonly name: string;
  readonly brandName: string;
  readonly version: string;
  readonly uuid: string;
  readonly defaultSamplingRate: number;
  readonly frameRate: number;
  readonly supportedFeatures: Readonly<Record<string, boolean>>;
}

export interface SupportedDevices {
  readonly cpu: boolean;
  readonly cuda: boolean;
  readonly dml: boolean;
}

export type WordType = "PROPER_NOUN" | "COMMON_NOUN" | "VERB" | "ADJECTIVE" | "SUFFIX";

export interface DictionaryWord {
  readonly uuid: string;
  readonly surface: string;
  readonly pronunciation: string;
  readonly accentType: number;
  readonly priority: number;
  readonly partOfSpeech: string;
  readonly moraCount: number | null;
}

export function protocolError(message: string, detail?: unknown): KongyoroidError {
  return new KongyoroidError({
    code: "ENGINE_PROTOCOL",
    message: `VOICEVOX returned an unexpected response: ${message}`,
    retryable: false,
    ...(detail === undefined ? {} : { detail }),
  });
}

function obj(value: unknown, what: string): JsonObject {
  if (!isObject(value)) throw protocolError(`${what} is not an object`);
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw protocolError(`${what} is not a number`);
  return value;
}

function int(value: unknown, what: string): number {
  const n = num(value, what);
  if (!Number.isSafeInteger(n)) throw protocolError(`${what} is not an integer`);
  return n;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw protocolError(`${what} is not a string`);
  return value;
}

function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(`${what} is not an array`);
  return value;
}

function nullable<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null || value === undefined ? null : read(value);
}

export function readMora(value: unknown): EngineMora {
  const m = obj(value, "mora");
  return {
    text: str(m["text"], "mora.text"),
    consonant: nullable(m["consonant"], (v) => str(v, "mora.consonant")),
    consonant_length: nullable(m["consonant_length"], (v) => num(v, "mora.consonant_length")),
    vowel: str(m["vowel"], "mora.vowel"),
    vowel_length: num(m["vowel_length"], "mora.vowel_length"),
    pitch: num(m["pitch"], "mora.pitch"),
  };
}

export function readAccentPhrases(value: unknown): readonly EngineAccentPhrase[] {
  return list(value, "accent_phrases").map((raw) => {
    const phrase = obj(raw, "accent_phrase");
    return {
      moras: list(phrase["moras"], "accent_phrase.moras").map(readMora),
      accent: int(phrase["accent"], "accent_phrase.accent"),
      pause_mora: nullable(phrase["pause_mora"], readMora),
      is_interrogative: phrase["is_interrogative"] === true,
    };
  });
}

export function readAudioQuery(value: unknown): AudioQuery {
  const q = obj(value, "audio_query");
  return {
    accent_phrases: readAccentPhrases(q["accent_phrases"]),
    speedScale: num(q["speedScale"], "speedScale"),
    pitchScale: num(q["pitchScale"], "pitchScale"),
    intonationScale: num(q["intonationScale"], "intonationScale"),
    volumeScale: num(q["volumeScale"], "volumeScale"),
    prePhonemeLength: num(q["prePhonemeLength"], "prePhonemeLength"),
    postPhonemeLength: num(q["postPhonemeLength"], "postPhonemeLength"),
    pauseLength: nullable(q["pauseLength"], (v) => num(v, "pauseLength")),
    pauseLengthScale: typeof q["pauseLengthScale"] === "number" ? q["pauseLengthScale"] : 1,
    outputSamplingRate: int(q["outputSamplingRate"], "outputSamplingRate"),
    outputStereo: q["outputStereo"] === true,
    kana: typeof q["kana"] === "string" ? q["kana"] : "",
  };
}

export function readFrameAudioQuery(value: unknown): FrameAudioQuery {
  const q = obj(value, "frame_audio_query");
  const f0 = list(q["f0"], "f0").map((v, i) => num(v, `f0[${i}]`));
  const volume = list(q["volume"], "volume").map((v, i) => num(v, `volume[${i}]`));
  const phonemes = list(q["phonemes"], "phonemes").map((raw, i) => {
    const p = obj(raw, `phonemes[${i}]`);
    return {
      phoneme: str(p["phoneme"], `phonemes[${i}].phoneme`),
      frame_length: int(p["frame_length"], `phonemes[${i}].frame_length`),
      note_id: nullable(p["note_id"], (v) => str(v, `phonemes[${i}].note_id`)),
    };
  });
  let frames = 0;
  for (const p of phonemes) frames += p.frame_length;
  if (f0.length !== frames || volume.length !== frames) {
    throw protocolError(`frame arrays disagree (f0 ${f0.length}, volume ${volume.length}, phonemes ${frames})`);
  }
  return {
    f0,
    volume,
    phonemes,
    volumeScale: num(q["volumeScale"], "volumeScale"),
    outputSamplingRate: int(q["outputSamplingRate"], "outputSamplingRate"),
    outputStereo: q["outputStereo"] === true,
  };
}

const STYLE_TYPES: readonly StyleType[] = ["talk", "singing_teacher", "frame_decode", "sing", "streaming_talk"];

export function readStyles(value: unknown): readonly VoiceStyle[] {
  const styles: VoiceStyle[] = [];
  for (const raw of list(value, "speakers")) {
    const speaker = obj(raw, "speaker");
    const character = str(speaker["name"], "speaker.name");
    const characterUuid = str(speaker["speaker_uuid"], "speaker.speaker_uuid");
    const version = typeof speaker["version"] === "string" ? speaker["version"] : "";
    for (const rawStyle of list(speaker["styles"], "speaker.styles")) {
      const style = obj(rawStyle, "style");
      const rawType = style["type"];
      const type = STYLE_TYPES.find((t) => t === rawType) ?? "talk";
      styles.push({
        id: int(style["id"], "style.id"),
        name: str(style["name"], "style.name"),
        character,
        characterUuid,
        type,
        version,
      });
    }
  }
  return styles;
}

export function readManifest(value: unknown): EngineManifest {
  const m = obj(value, "engine_manifest");
  const features: Record<string, boolean> = {};
  if (isObject(m["supported_features"])) {
    for (const [key, raw] of Object.entries(m["supported_features"])) {
      features[key] = isObject(raw) ? raw["value"] === true : raw === true;
    }
  }
  return {
    name: str(m["name"], "engine_manifest.name"),
    brandName: typeof m["brand_name"] === "string" ? m["brand_name"] : "",
    version: str(m["version"], "engine_manifest.version"),
    uuid: typeof m["uuid"] === "string" ? m["uuid"] : "",
    defaultSamplingRate: int(m["default_sampling_rate"], "engine_manifest.default_sampling_rate"),
    frameRate: typeof m["frame_rate"] === "number" && m["frame_rate"] > 0 ? m["frame_rate"] : 93.75,
    supportedFeatures: features,
  };
}

export function readSupportedDevices(value: unknown): SupportedDevices {
  const d = obj(value, "supported_devices");
  return { cpu: d["cpu"] === true, cuda: d["cuda"] === true, dml: d["dml"] === true };
}

export function readDictionary(value: unknown): readonly DictionaryWord[] {
  const words: DictionaryWord[] = [];
  for (const [uuid, raw] of Object.entries(obj(value, "user_dict"))) {
    const word = obj(raw, `user_dict.${uuid}`);
    words.push({
      uuid,
      surface: str(word["surface"], "surface"),
      pronunciation: str(word["pronunciation"], "pronunciation"),
      accentType: int(word["accent_type"], "accent_type"),
      priority: typeof word["priority"] === "number" ? word["priority"] : 5,
      partOfSpeech: typeof word["part_of_speech"] === "string" ? word["part_of_speech"] : "",
      moraCount: typeof word["mora_count"] === "number" ? word["mora_count"] : null,
    });
  }
  return words;
}

export function readString(value: unknown, what: string): string {
  return str(value, what);
}

export function readBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw protocolError(`${what} is not a boolean`);
  return value;
}

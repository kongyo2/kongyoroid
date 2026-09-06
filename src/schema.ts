import { EXIT_CODES } from "./errors.ts";
import { LIMITS, SAMPLE_RATE_RANGE } from "./limits.ts";
import { MAX_BEATS, MAX_NOTES, MIN_BEATS } from "./score.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

const styleRef: JsonSchema = {
  anyOf: [
    { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    { type: "string", minLength: 1, maxLength: 200 },
  ],
  description:
    'A VOICEVOX style id from the voices command, or a name: "ずんだもん" (first matching style) or "ずんだもん/ノーマル" (exact style).',
};

const common: JsonSchema = {
  engine: {
    enum: ["voicevox", "formant", "auto"],
    default: "voicevox",
    description:
      "voicevox uses a running VOICEVOX ENGINE (high quality, Japanese text). formant is the built-in offline synthesizer (kana only, deterministic). auto picks voicevox when reachable, otherwise formant.",
  },
  sampleRate: {
    type: "integer",
    minimum: SAMPLE_RATE_RANGE.min,
    maximum: SAMPLE_RATE_RANGE.max,
    description: "Output sample rate in Hz. Defaults to the engine default (24000).",
  },
  volume: { type: "number", minimum: 0, maximum: 3, default: 1, description: "Linear output gain." },
  seed: {
    type: "integer",
    minimum: 1,
    maximum: 4_294_967_295,
    default: 1,
    description: "Noise seed for the formant engine; ignored by voicevox.",
  },
};

export const SPEECH_PROPERTIES: JsonSchema = {
  kind: { const: "speech" },
  ...common,
  text: {
    type: "string",
    minLength: 1,
    maxLength: LIMITS.textChars,
    description: "Text to read. voicevox accepts ordinary Japanese including kanji; formant accepts kana only.",
  },
  kana: {
    type: "string",
    minLength: 1,
    maxLength: LIMITS.kanaChars,
    description:
      "Optional reading in AquesTalk-style notation, e.g. コンニチワ'/セカ'イ？ (katakana, / between accent phrases, 、 for a pause, ' after the accent nucleus, _ before a devoiced vowel, ？ for a question). When given, it replaces the engine's own reading of text and disables splitting.",
  },
  speaker: styleRef,
  speed: { type: "number", minimum: 0.25, maximum: 4, default: 1, description: "Speaking rate multiplier." },
  pitch: {
    type: "number",
    minimum: -1,
    maximum: 1,
    default: 0,
    description: "VOICEVOX pitchScale semantics; the practical range is about -0.15 to 0.15.",
  },
  intonation: { type: "number", minimum: 0, maximum: 3, default: 1, description: "Pitch-range multiplier." },
  prePause: { type: "number", minimum: 0, maximum: 10, default: 0.1, description: "Leading silence in seconds." },
  postPause: { type: "number", minimum: 0, maximum: 10, default: 0.1, description: "Trailing silence in seconds." },
  pauseLength: {
    type: "number",
    minimum: 0,
    maximum: 10,
    description: "Absolute punctuation pause in seconds. Omit to keep the engine's own pause lengths.",
  },
  pauseScale: { type: "number", minimum: 0, maximum: 10, default: 1, description: "Punctuation pause multiplier." },
  upspeak: {
    type: "boolean",
    default: true,
    description: "Raise the final mora of interrogative phrases (VOICEVOX enable_interrogative_upspeak).",
  },
  split: {
    enum: ["sentence", "paragraph", "none"],
    default: "sentence",
    description:
      "How long text is chunked before synthesis. Chunks are synthesized concurrently and concatenated in order.",
  },
};

export const NOTE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "beats"],
  properties: {
    key: {
      anyOf: [
        { type: "integer", minimum: 0, maximum: 127 },
        { type: "string", pattern: "^[A-Ga-g](#|♯|b|♭|x)?-?[0-9]$" },
        { type: "null" },
      ],
      description: "MIDI key (60 = C4), a note name such as C4 or F#3, or null for a rest.",
    },
    beats: {
      type: "number",
      minimum: MIN_BEATS,
      maximum: MAX_BEATS,
      description: "Duration in quarter-note beats at the score tempo.",
    },
    lyric: {
      type: "string",
      maxLength: 8,
      default: "",
      description:
        'Exactly one kana mora for a pitched note (ア, キャ, ン, ...), "ー" to hold the previous vowel, empty for a rest.',
    },
  },
  if: { properties: { key: { type: "null" } } },
  then: { properties: { lyric: { const: "" } } },
  else: { properties: { lyric: { type: "string", minLength: 1 } } },
};

export const SCORE_TEXT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lyrics", "melody"],
  properties: {
    lyrics: {
      type: "string",
      maxLength: LIMITS.textChars,
      description: "Kana lyrics; one mora is consumed per pitched melody note. ー holds the previous vowel.",
    },
    melody: {
      type: "string",
      minLength: 1,
      maxLength: LIMITS.textChars,
      description:
        'Whitespace-separated notes: note names (C4, F#4, Bb3), MIDI integers, R for a rest, ~ for a tie. Example: "C4 D4 E4 R ~".',
    },
    beats: {
      anyOf: [
        { type: "string" },
        { type: "array", items: { type: "number", minimum: MIN_BEATS, maximum: MAX_BEATS }, minItems: 1 },
      ],
      description:
        'Beat lengths per melody token ("1 1 2 0.5 1/2"). One value applies to every note; omitted means 1 beat each.',
    },
  },
};

export const SONG_PROPERTIES: JsonSchema = {
  kind: { const: "song" },
  ...common,
  notes: {
    anyOf: [
      { type: "array", minItems: 1, maxItems: MAX_NOTES, items: { $ref: "#/$defs/note" } },
      { $ref: "#/$defs/scoreText" },
    ],
    description: "Either an explicit note list or a compact lyrics/melody/beats score.",
  },
  tempo: { type: "number", minimum: 20, maximum: 400, default: 120, description: "Beats per minute." },
  singer: {
    ...styleRef,
    description:
      "VOICEVOX style that renders the voice (type frame_decode or sing). Defaults to the first singing style the engine offers.",
  },
  teacher: {
    ...styleRef,
    description:
      "VOICEVOX style that predicts timing and pitch (type singing_teacher or sing). Defaults to the singer when it can teach, otherwise to the first teacher.",
  },
  transpose: { type: "integer", minimum: -48, maximum: 48, default: 0, description: "Semitones added to every key." },
  vibratoDepth: {
    type: "number",
    minimum: 0,
    maximum: 200,
    description:
      "Vibrato depth in cents. voicevox defaults to 0 (the engine's own expression); formant defaults to 25.",
  },
  vibratoRate: { type: "number", minimum: 0, maximum: 12, default: 5.5, description: "Vibrato rate in Hz." },
  leadIn: { type: "number", minimum: 0, maximum: 5, default: 0.16, description: "Rest added before the first note." },
  leadOut: { type: "number", minimum: 0, maximum: 5, default: 0.16, description: "Rest added after the last note." },
};

function variant(kind: "speech" | "song", properties: JsonSchema, required: readonly string[]): JsonSchema {
  return {
    type: "object",
    title: kind === "speech" ? "SpeechRequest" : "SongRequest",
    additionalProperties: false,
    required: ["kind", ...required],
    properties,
  };
}

export const REQUEST_SCHEMA: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://github.com/kongyo2/kongyoroid/schema/render-request.json",
  title: "kongyoroid RenderRequest",
  description:
    "One speech (読み上げ) or song (歌唱) render. Unknown properties are rejected. Output is a mono PCM16 WAV.",
  oneOf: [variant("speech", SPEECH_PROPERTIES, ["text"]), variant("song", SONG_PROPERTIES, ["notes"])],
  $defs: { note: NOTE_SCHEMA, scoreText: SCORE_TEXT_SCHEMA },
};

export const BATCH_JOB_SCHEMA: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "kongyoroid BatchJob",
  description: "One JSONL line for the batch command.",
  type: "object",
  additionalProperties: false,
  required: ["id", "request"],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Output file name stem, unique per batch." },
    request: { $ref: REQUEST_SCHEMA["$id"] },
  },
};

export const CAPABILITIES: JsonSchema = {
  name: PACKAGE_NAME,
  version: VERSION,
  description: "Japanese speech and singing synthesis for LLM agents.",
  output: { container: "wav", encoding: "pcm16", channels: 1, sampleRate: { default: 24000, ...SAMPLE_RATE_RANGE } },
  engines: {
    voicevox: {
      external: true,
      endpoint: { default: "http://127.0.0.1:50021", env: ["KONGYOROID_ENDPOINT", "VOICEVOX_URL"] },
      speech: "Japanese text with kanji; readings adjustable via kana notation and the user dictionary.",
      song: "Score of one-mora notes rendered by a singing style; timing and pitch predicted by a teacher style.",
      styles: "Discover with the voices command; select by id or by name.",
    },
    formant: {
      external: false,
      speech: "Kana text or kana notation; deterministic for a given request and seed.",
      song: "Score of one-mora notes; deterministic.",
    },
  },
  commands: [
    "speak",
    "sing",
    "render",
    "batch",
    "reading",
    "voices",
    "doctor",
    "dict",
    "play",
    "schema",
    "capabilities",
  ],
  env: {
    KONGYOROID_ENDPOINT: "VOICEVOX ENGINE base URL.",
    VOICEVOX_URL: "Alias of KONGYOROID_ENDPOINT.",
    KONGYOROID_ENGINE: "Default engine: voicevox, formant, or auto.",
    KONGYOROID_SPEAKER: "Default speech style (id or name).",
    KONGYOROID_SINGER: "Default singing style (id or name).",
    KONGYOROID_TEACHER: "Default singing teacher style (id or name).",
    KONGYOROID_CACHE_DIR: "Directory for the on-disk render cache.",
  },
  limits: {
    textChars: LIMITS.textChars,
    notes: LIMITS.notes,
    audioSeconds: LIMITS.audioSeconds,
    inputBytes: LIMITS.inputBytes,
    batchLines: LIMITS.batchLines,
    concurrency: LIMITS.concurrency,
  },
  exitCodes: EXIT_CODES,
  errorCodes: [
    "INVALID_INPUT",
    "UNSUPPORTED_TEXT",
    "ENGINE_UNAVAILABLE",
    "ENGINE_HTTP",
    "ENGINE_REJECTED",
    "ENGINE_PROTOCOL",
    "TIMEOUT",
    "ABORTED",
    "QUEUE_FULL",
    "IO_ERROR",
    "PLAYER_UNAVAILABLE",
    "INTERNAL",
  ],
  stdout: "One JSON object per line. With --output - the WAV bytes go to stdout and the JSON goes to stderr.",
  stderr: "Errors as one JSON object: { ok: false, error: { code, message, path?, hint?, retryable } }.",
};

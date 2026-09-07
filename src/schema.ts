import { ERROR_CODES, EXIT_CODES } from "./errors.ts";
import { LIMITS, SAMPLE_RATE_RANGE } from "./limits.ts";
import { MAX_BEATS, MAX_LYRIC_MORAS, MAX_NOTES, MIN_BEATS } from "./song/score.ts";
import { BUILTIN_VOICES, DEFAULT_VOICE_ID } from "./synth/voice.ts";
import { ENGINE_VERSION, FRONTEND_VERSION, PACKAGE_NAME, PLAN_VERSION, SCHEMA_VERSION, VERSION } from "./version.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

const styleRef: JsonSchema = {
  anyOf: [
    { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    { type: "string", minLength: 1, maxLength: 200 },
  ],
  description:
    'VOICEVOX only: a style id from the voices command, or a name: "ずんだもん" (first matching style) or "ずんだもん/ノーマル" (exact style). Giving a style selects the voicevox engine.',
};

const VOICE_IDS: readonly string[] = BUILTIN_VOICES.map((voice) => voice.id);

const common: JsonSchema = {
  schemaVersion: { enum: [1, 2], description: "Optional request schema version; omitted means the current version." },
  engine: {
    enum: ["formant", "voicevox", "auto"],
    default: "formant",
    description:
      "formant is the built-in engine (default): ordinary Japanese text, kana, deterministic, no external service. voicevox drives a running VOICEVOX ENGINE and is selected automatically when speaker, singer, or teacher is given. auto uses voicevox when the endpoint answers, otherwise formant.",
  },
  voice: {
    type: "string",
    enum: VOICE_IDS,
    default: DEFAULT_VOICE_ID,
    description: `Built-in voice for the formant engine: ${VOICE_IDS.join(", ")}. Run the voices command for details.`,
  },
  sampleRate: {
    type: "integer",
    minimum: SAMPLE_RATE_RANGE.min,
    maximum: SAMPLE_RATE_RANGE.max,
    description: "Output sample rate in Hz. Defaults to 24000. Rates below 16000 lose fricative detail.",
  },
  volume: {
    type: "number",
    minimum: 0,
    maximum: 3,
    default: 1,
    description: "Linear output gain applied before a continuous soft limiter.",
  },
  gainDb: {
    type: "number",
    minimum: -60,
    maximum: 12,
    description: "Output gain in dB (alternative to volume; do not give both).",
  },
  breathiness: {
    type: "number",
    minimum: -1,
    maximum: 1.5,
    default: 0,
    description: "Glottal tension offset for the formant engine: negative is tenser, positive is breathier.",
  },
  seed: {
    type: "integer",
    minimum: 1,
    maximum: 4_294_967_295,
    default: 1,
    description:
      "Noise/jitter seed for the formant engine; the same request and seed give identical audio. Ignored by voicevox.",
  },
};

export const DICTIONARY_ENTRY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["surface", "reading"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100, description: "Stable identifier (defaults to entry-N)." },
    surface: { type: "string", minLength: 1, maxLength: 200, description: "Text to match (kanji, kana, or ASCII)." },
    reading: { type: "string", minLength: 1, maxLength: 200, description: "Pronunciation in kana (ー allowed)." },
    accent: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      description: "Accent nucleus mora (1-based); 0 = flat (平板); null = let the frontend decide.",
    },
    match: {
      enum: ["word", "anywhere"],
      default: "word",
      description: "word: do not match inside ASCII words; anywhere: match everywhere.",
    },
    priority: { type: "integer", minimum: 0, maximum: 10, default: 5 },
    caseSensitive: { type: "boolean", default: false },
    note: { type: "string", maxLength: 500 },
  },
};

export const SPEECH_PROPERTIES: JsonSchema = {
  kind: { const: "speech" },
  ...common,
  text: {
    type: "string",
    minLength: 1,
    maxLength: LIMITS.textChars,
    description:
      "Text to read: ordinary Japanese including kanji, numbers, dates, and ASCII words (formant engine uses the built-in jpreprocess frontend with an accent dictionary). Newlines separate sentences; blank lines separate paragraphs.",
  },
  kana: {
    type: "string",
    minLength: 1,
    maxLength: LIMITS.kanaChars,
    description:
      "Optional pronunciation that replaces the reading of text. Kana with optional accent notation: / between accent phrases, ' after the accent nucleus (none = flat), 、 pause, 。 sentence end, ？ question, ！ exclamation, _ before a devoiced mora, ー long vowel. Example: コンニチワ、キョ'ーワ/イ'イ/テ'ンキデ_スネ？",
  },
  dictionary: {
    type: "array",
    maxItems: LIMITS.dictionaryEntries,
    items: { $ref: "#/$defs/dictionaryEntry" },
    description: "One-off reading/accent overrides applied to text before analysis (highest priority).",
  },
  strictReading: {
    type: "boolean",
    default: true,
    description: "Fail with UNREADABLE_TEXT when a character has no reading; false skips it with a warning.",
  },
  speaker: styleRef,
  speed: {
    type: "number",
    minimum: 0.25,
    maximum: 4,
    default: 1,
    description: "Speaking rate multiplier (formant default is about 7 moras per second).",
  },
  pitch: {
    type: "number",
    minimum: -1,
    maximum: 1,
    description:
      "VOICEVOX pitchScale semantics (log-F0 exponent); practical range about -0.15 to 0.15. Prefer pitchSemitones for the formant engine.",
  },
  pitchSemitones: {
    type: "number",
    minimum: -24,
    maximum: 24,
    default: 0,
    description: "Shift of the voice's base pitch in semitones (formant engine).",
  },
  intonation: {
    type: "number",
    minimum: 0,
    maximum: 3,
    default: 1,
    description: "Pitch-range multiplier (accent and phrase components).",
  },
  prePause: { type: "number", minimum: 0, maximum: 10, default: 0.1, description: "Leading silence in seconds." },
  postPause: { type: "number", minimum: 0, maximum: 10, default: 0.1, description: "Trailing silence in seconds." },
  pauseLength: {
    type: "number",
    minimum: 0,
    maximum: 10,
    description: "Absolute length of 、 pauses in seconds. Omit to keep the engine's own pause lengths.",
  },
  pauseScale: { type: "number", minimum: 0, maximum: 10, default: 1, description: "Punctuation pause multiplier." },
  upspeak: { type: "boolean", default: true, description: "Raise the final mora of interrogative phrases." },
  split: {
    enum: ["sentence", "paragraph", "none"],
    default: "sentence",
    description:
      "voicevox only: how long text is chunked before synthesis. The formant engine always analyses per sentence.",
  },
};

export const NOTE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "beats"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "Stable note id (defaults to n1, n2, …); reported in plan output and errors.",
    },
    key: {
      anyOf: [
        { type: "integer", minimum: 0, maximum: 127 },
        { type: "string", pattern: "^\\s*(?:[A-Ga-g](?:#|♯|b|♭|x)?-?[0-9]|\\d{1,3})\\s*$" },
        { type: "null" },
      ],
      description: "MIDI key (60 = C4), a note name such as C4 or F#3, a numeric string, or null for a rest.",
    },
    beats: {
      type: "number",
      minimum: MIN_BEATS,
      maximum: MAX_BEATS,
      description: "Duration in quarter-note beats at the score tempo.",
    },
    lyric: {
      type: "string",
      maxLength: 32,
      description: `Kana for a pitched note: one mora (ア, キャ, ン) or up to ${MAX_LYRIC_MORAS} moras split inside the note (formant engine). "ー" holds the previous vowel. Empty for a rest.`,
    },
    continuation: {
      enum: ["none", "tie", "melisma"],
      description:
        "tie: hold the previous vowel at the same pitch; melisma: hold it at a new pitch. Must directly follow a pitched note.",
    },
    continueFrom: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "Id of the directly preceding note being continued (explicit form of continuation).",
    },
    articulation: {
      enum: ["auto", "legato", "rearticulate"],
      description: "auto: re-articulate a repeated vowel; legato: connect without re-attack.",
    },
    velocity: {
      type: "integer",
      minimum: 1,
      maximum: 127,
      description: "Loudness 1–127 (100 = nominal); louder is also slightly tenser.",
    },
    gainDb: { type: "number", minimum: -40, maximum: 12, description: "Loudness in dB (alternative to velocity)." },
    portamentoMs: {
      type: "number",
      minimum: 0,
      maximum: 2000,
      description: "Pitch transition time into this note (default from the request).",
    },
    vibrato: {
      anyOf: [
        { const: false },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            depthCents: { type: "number", minimum: 0, maximum: 200 },
            rateHz: { type: "number", minimum: 0, maximum: 12 },
            delayMs: { type: "number", minimum: 0, maximum: 5000 },
            fadeMs: { type: "number", minimum: 0, maximum: 5000 },
          },
        },
      ],
      description: "Per-sustain vibrato override, or false to disable vibrato on this note.",
    },
  },
  if: { properties: { key: { type: "null" } } },
  then: { properties: { lyric: { const: "" } } },
};

export const SCORE_TEXT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lyrics", "melody"],
  properties: {
    lyrics: {
      type: "string",
      maxLength: LIMITS.textChars,
      description: "Kana lyrics; one mora is consumed per pitched melody note.",
    },
    melody: {
      type: "string",
      minLength: 1,
      maxLength: LIMITS.textChars,
      description:
        'Whitespace-separated notes: note names (C4, F#4, Bb3), MIDI integers, R for a rest, ~ to hold the previous note (tie), ~D4 to move the held vowel to D4 (melisma), | ignored. Example: "C4 D4 E4 ~ R ~E4".',
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

export const MML_SCORE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mml"],
  properties: {
    mml: {
      type: "string",
      minLength: 1,
      maxLength: LIMITS.textChars,
      description:
        "Music Macro Language: t120 tempo, o4 octave, < > octave shift, l8 default length, v12 velocity, c d e f g a b (+ # -), lengths 1–64 with dots, r rest, & tie/melisma, n60 MIDI, [きゃ] inline lyric. Example: t120 o4 l4 c d e2 r4 e8&e8",
    },
    lyrics: {
      type: "string",
      maxLength: LIMITS.textChars,
      description: "Kana lyrics, one mora per pitched note (notes without lyrics sing ラ).",
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
      { $ref: "#/$defs/mmlScore" },
    ],
    description: "An explicit note list, a compact lyrics/melody/beats score, or an MML score.",
  },
  tempo: {
    type: "number",
    minimum: 20,
    maximum: 400,
    description: "Beats per minute (default 120, or the MML tempo).",
  },
  singer: { ...styleRef, description: "VOICEVOX only: style that renders the voice (type frame_decode or sing)." },
  teacher: {
    ...styleRef,
    description: "VOICEVOX only: style that predicts timing and pitch (type singing_teacher or sing).",
  },
  transpose: {
    type: "integer",
    minimum: -48,
    maximum: 48,
    default: 0,
    description: "Semitones added to every key (applied exactly once).",
  },
  vibratoDepth: {
    type: "number",
    minimum: 0,
    maximum: 200,
    description: "Vibrato depth in cents (formant default 30, voicevox default 0).",
  },
  vibratoRate: { type: "number", minimum: 0, maximum: 12, default: 5.5, description: "Vibrato rate in Hz." },
  vibrato: {
    type: "object",
    additionalProperties: false,
    properties: {
      depthCents: { type: "number", minimum: 0, maximum: 200 },
      rateHz: { type: "number", minimum: 0, maximum: 12 },
      delayMs: { type: "number", minimum: 0, maximum: 5000, default: 180 },
      fadeMs: { type: "number", minimum: 0, maximum: 5000, default: 250 },
    },
    description: "Vibrato settings per sustained vowel (alternative to vibratoDepth/vibratoRate).",
  },
  portamentoMs: {
    type: "number",
    minimum: 0,
    maximum: 2000,
    description: "Pitch transition time between connected notes (formant default 60 ms; 0 = step).",
  },
  scoopCents: {
    type: "number",
    minimum: 0,
    maximum: 1200,
    default: 0,
    description: "Start phrase-initial notes this many cents below and slide up (しゃくり).",
  },
  scoopMs: { type: "number", minimum: 0, maximum: 2000, default: 80, description: "Duration of the scoop slide." },
  consonantCompression: {
    type: "boolean",
    default: true,
    description: "Allow consonants to be shortened when a note is too short; false fails with NOTE_TOO_SHORT instead.",
  },
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

const REQUEST_BODY: JsonSchema = {
  title: "kongyoroid RenderRequest",
  description:
    "One speech (読み上げ) or song (歌唱) render. Unknown properties are rejected. Output is a mono PCM16 WAV. The built-in formant engine needs no external service.",
  oneOf: [variant("speech", SPEECH_PROPERTIES, ["text"]), variant("song", SONG_PROPERTIES, ["notes"])],
};

const DEFS: JsonSchema = {
  note: NOTE_SCHEMA,
  scoreText: SCORE_TEXT_SCHEMA,
  mmlScore: MML_SCORE_SCHEMA,
  dictionaryEntry: DICTIONARY_ENTRY_SCHEMA,
};

export const REQUEST_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/kongyo2/kongyoroid/schema/render-request.json",
  ...REQUEST_BODY,
  $defs: DEFS,
};

export const BATCH_JOB_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/kongyo2/kongyoroid/schema/batch-job.json",
  title: "kongyoroid BatchJob",
  description: "One JSONL line for the batch command. The request schema is embedded under $defs.request.",
  type: "object",
  additionalProperties: false,
  required: ["id", "request"],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Output file name stem, unique per batch." },
    request: { $ref: "#/$defs/request" },
  },
  $defs: { request: REQUEST_BODY, ...DEFS },
};

export const DICTIONARY_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/kongyo2/kongyoroid/schema/dictionary.json",
  title: "kongyoroid Dictionary",
  description: "Local reading dictionary file: { entries: [...] } or a bare array of entries.",
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["entries"],
      properties: { entries: { type: "array", items: { $ref: "#/$defs/dictionaryEntry" } } },
    },
    { type: "array", items: { $ref: "#/$defs/dictionaryEntry" } },
  ],
  $defs: { dictionaryEntry: DICTIONARY_ENTRY_SCHEMA },
};

export const CAPABILITIES: JsonSchema = {
  name: PACKAGE_NAME,
  version: VERSION,
  schemaVersion: SCHEMA_VERSION,
  planVersion: PLAN_VERSION,
  engineVersion: ENGINE_VERSION,
  frontendVersion: FRONTEND_VERSION,
  description:
    "Japanese speech and singing synthesis for LLM agents: a built-in deterministic formant engine with a dictionary-backed text frontend, plus an optional VOICEVOX adapter.",
  output: { container: "wav", encoding: "pcm16", channels: 1, sampleRate: { default: 24000, ...SAMPLE_RATE_RANGE } },
  streaming: { formats: ["wav", "pcm", "ndjson"], pcm: "s16le mono", sentenceGranularity: true },
  defaultEngine: "formant",
  engines: {
    formant: {
      external: false,
      voices: VOICE_IDS,
      text: "Ordinary Japanese (kanji, kana, numbers, dates, units, ASCII words) via jpreprocess + NAIST-JDic with accent; kana input with optional accent notation; local dictionaries for readings and accents.",
      speech:
        "Fujisaki-model intonation, accent phrases, devoicing, moraic nasal assimilation, sokuon closures; deterministic for a request and seed.",
      song: "Note lists, compact lyrics/melody/beats scores, and MML; ties, melismas, re-articulation, per-note velocity and vibrato, portamento, multi-mora lyrics per note; deterministic.",
      maxSeconds: LIMITS.formantSeconds,
      inspection:
        "validate and plan return readings, phonemes, note timing, pitch range and warnings before any audio is rendered.",
    },
    voicevox: {
      external: true,
      endpoint: { default: "http://127.0.0.1:50021", env: ["KONGYOROID_ENDPOINT", "VOICEVOX_URL"] },
      speech: "Japanese text with kanji; readings adjustable via kana notation and the VOICEVOX user dictionary.",
      song: "One-mora notes rendered by a singing style; timing and pitch predicted by a teacher style.",
      styles: "Discover with voices --engine voicevox; select by id or by name. Giving a style selects this engine.",
    },
  },
  commands: [
    "speak",
    "sing",
    "render",
    "validate",
    "plan",
    "batch",
    "reading",
    "inspect",
    "voices",
    "doctor",
    "dict",
    "cache",
    "play",
    "schema",
    "capabilities",
  ],
  env: {
    KONGYOROID_ENDPOINT: "VOICEVOX ENGINE base URL.",
    VOICEVOX_URL: "Alias of KONGYOROID_ENDPOINT.",
    KONGYOROID_ENGINE: "Default engine: formant, voicevox, or auto.",
    KONGYOROID_VOICE: "Default built-in voice id.",
    KONGYOROID_SPEAKER: "Default VOICEVOX speech style (id or name).",
    KONGYOROID_SINGER: "Default VOICEVOX singing style (id or name).",
    KONGYOROID_TEACHER: "Default VOICEVOX singing teacher style (id or name).",
    KONGYOROID_CACHE_DIR:
      "Directory for the on-disk render cache (a kongyoroid-cache subdirectory is created inside it).",
    KONGYOROID_DICTIONARY: "Path of the local reading dictionary JSON file.",
  },
  limits: {
    textChars: LIMITS.textChars,
    notes: LIMITS.notes,
    audioSeconds: LIMITS.audioSeconds,
    formantSeconds: LIMITS.formantSeconds,
    inputBytes: LIMITS.inputBytes,
    batchLines: LIMITS.batchLines,
    concurrency: LIMITS.concurrency,
    dictionaryEntries: LIMITS.dictionaryEntries,
  },
  exitCodes: EXIT_CODES,
  errorCodes: ERROR_CODES,
  stdout: "One JSON object per line. With --output - the audio bytes go to stdout and the JSON goes to stderr.",
  stderr:
    "Errors as one JSON object: { ok: false, error: { code, message, path?, hint?, retryable, repairOptions?, sourceSpan?, surface? } }.",
};

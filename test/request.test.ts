import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { KongyoroidError } from "../src/errors.ts";
import { parseJson, parseRequest, parseStyleRef, requestHash } from "../src/request.ts";
import {
  BATCH_JOB_SCHEMA,
  CAPABILITIES,
  DICTIONARY_SCHEMA,
  REQUEST_SCHEMA,
  SONG_PROPERTIES,
  SPEECH_PROPERTIES,
} from "../src/schema.ts";
import { isObject } from "../src/validate.ts";
import { VERSION } from "../src/version.ts";

function failure(fn: () => unknown): KongyoroidError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(REQUEST_SCHEMA);

const VALID: readonly unknown[] = [
  { kind: "speech", text: "こんにちは" },
  { kind: "speech", text: "こんにちは", engine: "voicevox", speaker: 3, speed: 1.2, pitch: 0.05, split: "none" },
  { kind: "speech", text: "こんにちは", kana: "コンニチワ'", speaker: "ずんだもん/ノーマル", upspeak: false },
  {
    kind: "speech",
    text: "x",
    engine: "auto",
    intonation: 1.5,
    volume: 0.8,
    prePause: 0,
    postPause: 0.5,
    pauseLength: 0.3,
    pauseScale: 2,
    sampleRate: 44100,
    seed: 7,
  },
  {
    kind: "speech",
    text: "x",
    voice: "female",
    pitchSemitones: 3,
    gainDb: -3,
    breathiness: 0.5,
    dictionary: [{ surface: "x", reading: "エックス", accent: 1 }],
    strictReading: false,
  },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }] },
  {
    kind: "song",
    notes: [
      { key: "C4", beats: 1, lyric: "ア" },
      { key: null, beats: 1 },
      { id: "x", key: "60", beats: 1, lyric: "きら", velocity: 90, portamentoMs: 30, vibrato: false },
      { key: "62", beats: 1, continuation: "melisma", vibrato: { depthCents: 20 } },
    ],
    tempo: 90,
  },
  {
    kind: "song",
    notes: { lyrics: "ドレミ", melody: "C4 D4 E4 ~ ~G4", beats: "1 1 1 1 2" },
    singer: 3001,
    teacher: 6000,
  },
  {
    kind: "song",
    notes: { mml: "t100 o4 c d e", lyrics: "ドレミ" },
    portamentoMs: 20,
    scoopCents: 50,
    consonantCompression: false,
  },
  {
    kind: "song",
    notes: { lyrics: "ア", melody: "C4", beats: [1] },
    transpose: -2,
    volume: 1.2,
    vibrato: { depthCents: 30, rateHz: 6, delayMs: 100, fadeMs: 200 },
    leadIn: 0.2,
    leadOut: 0.3,
    engine: "formant",
    seed: 2,
  },
];

const INVALID: readonly unknown[] = [
  {},
  { kind: "speech" },
  { kind: "speech", text: "" },
  { kind: "speech", text: "x", bogus: 1 },
  { kind: "speech", text: "x", speed: 10 },
  { kind: "speech", text: "x", engine: "espeak" },
  { kind: "speech", text: "x", voice: "robot" },
  { kind: "speech", text: "x", split: "words" },
  { kind: "speech", text: "x", speaker: -1 },
  { kind: "speech", text: "x", sampleRate: 100 },
  { kind: "speech", text: "x", pitchSemitones: 40 },
  { kind: "speech", text: "x", dictionary: [{ surface: "x" }] },
  { kind: "song" },
  { kind: "song", notes: [] },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア", extra: true }] },
  { kind: "song", notes: [{ key: null, beats: 1, lyric: "ア" }] },
  { kind: "song", notes: [{ key: 60, beats: 0, lyric: "ア" }] },
  { kind: "song", notes: [{ key: "X9", beats: 1, lyric: "ア" }] },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア", velocity: 200 }] },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア", continuation: "hold" }] },
  { kind: "song", notes: { melody: "C4" } },
  { kind: "song", notes: { mml: "" } },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }], tempo: 5 },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }], transpose: 1.5 },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }], vibrato: { depthCents: 500 } },
  { kind: "dance" },
];

test("the JSON Schema and the parser accept the same valid requests", () => {
  for (const request of VALID) {
    assert.equal(validate(request), true, `${JSON.stringify(request)} ${JSON.stringify(validate.errors)}`);
    parseRequest(request);
  }
});

test("the JSON Schema and the parser reject the same invalid requests", () => {
  for (const request of INVALID) {
    assert.equal(validate(request), false, JSON.stringify(request));
    assert.throws(() => parseRequest(request), KongyoroidError, JSON.stringify(request));
  }
});

test("semantic rules beyond the schema are enforced by the parser", () => {
  assert.equal(
    failure(() => parseRequest({ kind: "speech", text: "x", pitch: 0.1, pitchSemitones: 1 })).path,
    "$.pitchSemitones",
  );
  assert.equal(failure(() => parseRequest({ kind: "speech", text: "x", volume: 1, gainDb: 0 })).path, "$.gainDb");
  assert.equal(
    failure(() => parseRequest({ kind: "speech", text: "x", engine: "formant", speaker: 3 })).path,
    "$.speaker",
  );
  assert.equal(failure(() => parseRequest({ kind: "speech", text: "   " })).path, "$.text");
  assert.equal(failure(() => parseRequest({ kind: "speech", text: "x", kana: "漢" })).code, "INVALID_INPUT");
  assert.equal(
    failure(() =>
      parseRequest({
        kind: "song",
        notes: [{ key: 60, beats: 1, lyric: "ア" }],
        vibratoDepth: 1,
        vibrato: { rateHz: 5 },
      }),
    ).path,
    "$.vibrato",
  );
  const long = Array.from({ length: 20 }, () => ({ key: 60, beats: 64, lyric: "ア" }));
  assert.equal(failure(() => parseRequest({ kind: "song", notes: long, tempo: 20 })).path, "$.notes");
});

test("every schema property is understood by the parser", () => {
  const speech = {
    kind: "speech",
    schemaVersion: 2,
    engine: "formant",
    voice: "neutral",
    sampleRate: 24000,
    volume: 1,
    seed: 1,
    breathiness: 0,
    text: "x",
    kana: "ア'",
    dictionary: [],
    strictReading: true,
    speed: 1,
    pitchSemitones: 0,
    intonation: 1,
    prePause: 0.1,
    postPause: 0.1,
    pauseLength: 0.2,
    pauseScale: 1,
    upspeak: true,
    split: "none",
  };
  const speechKeys = new Set(Object.keys(SPEECH_PROPERTIES));
  for (const key of Object.keys(speech)) assert.ok(speechKeys.has(key), key);
  for (const key of speechKeys)
    assert.ok(key in speech || key === "speaker" || key === "pitch" || key === "gainDb", key);
  assert.equal(validate(speech), true, JSON.stringify(validate.errors));
  parseRequest(speech);
  const song = {
    kind: "song",
    engine: "formant",
    voice: "neutral",
    sampleRate: 24000,
    volume: 1,
    seed: 1,
    breathiness: 0,
    notes: { lyrics: "ア", melody: "C4", beats: [1] },
    tempo: 120,
    transpose: 0,
    vibratoDepth: 10,
    vibratoRate: 5,
    portamentoMs: 60,
    scoopCents: 0,
    scoopMs: 80,
    consonantCompression: true,
    leadIn: 0.1,
    leadOut: 0.1,
  };
  const songKeys = new Set(Object.keys(SONG_PROPERTIES));
  for (const key of Object.keys(song)) assert.ok(songKeys.has(key), key);
  for (const key of songKeys) {
    assert.ok(key in song || ["singer", "teacher", "gainDb", "vibrato", "schemaVersion"].includes(key), key);
  }
  assert.equal(validate(song), true, JSON.stringify(validate.errors));
  parseRequest(song);
});

test("defaults are materialized and errors carry paths, hints, and repair options", () => {
  const speech = parseRequest({ kind: "speech", text: " こんにちは " });
  assert.equal(speech.kind, "speech");
  if (speech.kind === "speech") {
    assert.equal(speech.engine, "formant");
    assert.equal(speech.voice, "neutral");
    assert.equal(speech.speed, 1);
    assert.equal(speech.pitch, undefined);
    assert.equal(speech.pitchSemitones, 0);
    assert.equal(speech.upspeak, true);
    assert.equal(speech.strictReading, true);
    assert.equal(speech.sampleRate, undefined);
  }
  const song = parseRequest({ kind: "song", notes: { lyrics: "ド", melody: "C4" }, transpose: 12 });
  if (song.kind === "song") {
    assert.equal(song.tempo, 120);
    assert.equal(song.notes[0]?.key, 72);
    assert.equal(song.notes[0]?.lyric, "ド");
    assert.equal(song.vibratoDepth, undefined);
    assert.equal(song.vibratoRate, 5.5);
    assert.equal(song.form, "compact");
    assert.equal(song.consonantCompression, true);
  }
  const mml = parseRequest({ kind: "song", notes: { mml: "t88 c" } });
  if (mml.kind === "song") {
    assert.equal(mml.tempo, 88);
    assert.equal(mml.notes[0]?.lyric, "ラ");
  }
  const unknown = failure(() => parseRequest({ kind: "speech", text: "x", speeed: 1 }));
  assert.equal(unknown.path, "$.speeed");
  assert.ok(unknown.hint?.includes("Allowed properties"));
  const gainDb = parseRequest({ kind: "speech", text: "x", gainDb: -6 });
  assert.ok(Math.abs(gainDb.volume - 0.5012) < 0.001);
});

test("resolved requests are not accepted as raw requests, so transposition is applied once", () => {
  const raw = { kind: "song", transpose: 2, notes: [{ key: 60, beats: 1, lyric: "あ" }] };
  const once = parseRequest(raw);
  assert.equal(once.kind === "song" ? once.notes[0]?.key : undefined, 62);
  assert.throws(() => parseRequest(once), KongyoroidError);
  const again = parseRequest(raw);
  assert.equal(again.kind === "song" ? again.notes[0]?.key : 0, 62);
});

test("a style reference implies the voicevox engine, and formant refuses styles", () => {
  const plain = parseRequest({ kind: "speech", text: "x" });
  const withSpeaker = parseRequest({ kind: "speech", text: "x", speaker: 3 });
  const song = parseRequest({ kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }], singer: "ずんだもん" });
  assert.equal(plain.engine, "formant");
  assert.equal(withSpeaker.engine, "voicevox");
  assert.equal(song.engine, "voicevox");
  assert.equal(
    failure(() => parseRequest({ kind: "speech", text: "x", speaker: 3, engine: "formant" })).code,
    "INVALID_INPUT",
  );
});

test("style references accept ids, numeric strings, and names", () => {
  assert.equal(parseStyleRef(3, "$.speaker"), 3);
  assert.equal(parseStyleRef(" 42 ", "$.speaker"), 42);
  assert.equal(parseStyleRef("ずんだもん/ノーマル", "$.speaker"), "ずんだもん/ノーマル");
  assert.equal(failure(() => parseStyleRef("", "$.speaker")).path, "$.speaker");
  assert.equal(failure(() => parseStyleRef(1.5, "$.speaker")).path, "$.speaker");
  assert.equal(failure(() => parseStyleRef(true, "$.speaker")).path, "$.speaker");
  assert.equal(failure(() => parseStyleRef("99999999999999999999", "$.speaker")).path, "$.speaker");
});

test("parseJson bounds input and reports syntax errors", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(failure(() => parseJson("{")).code, "INVALID_INPUT");
  assert.equal(failure(() => parseJson("x".repeat(9 * 1024 * 1024))).code, "INVALID_INPUT");
});

test("request hashes are canonical and the schemas and capabilities carry the version", async () => {
  assert.equal(requestHash({ a: 1, b: [1, 2] }), requestHash({ b: [1, 2], a: 1 }));
  assert.notEqual(requestHash({ a: 1 }), requestHash({ a: 2 }));
  assert.equal(BATCH_JOB_SCHEMA["title"], "kongyoroid BatchJob");
  assert.equal(DICTIONARY_SCHEMA["title"], "kongyoroid Dictionary");
  assert.equal(CAPABILITIES["version"], VERSION);
  const pkg: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(isObject(pkg));
  assert.equal(pkg["version"], VERSION);
  assert.equal(CAPABILITIES["name"], "@kongyo2/kongyoroid");
  assert.ok(Array.isArray(CAPABILITIES["errorCodes"]) && CAPABILITIES["errorCodes"].includes("UNREADABLE_TEXT"));
});

test("kana is canonicalized before it is stored", () => {
  const speech = parseRequest({ kind: "speech", text: "x", kana: "すーぱー'/いい'?" });
  assert.equal(speech.kind === "speech" ? speech.kana : undefined, "スーパー'/イイ'？");
});

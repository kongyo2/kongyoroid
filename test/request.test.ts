import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Ajv } from "ajv";
import { KongyoroidError } from "../src/errors.ts";
import { parseJson, parseRequest, parseStyleRef } from "../src/request.ts";
import { BATCH_JOB_SCHEMA, CAPABILITIES, REQUEST_SCHEMA, SONG_PROPERTIES, SPEECH_PROPERTIES } from "../src/schema.ts";
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

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(REQUEST_SCHEMA);

const VALID: readonly unknown[] = [
  { kind: "speech", text: "こんにちは" },
  { kind: "speech", text: "こんにちは", engine: "formant", speaker: 3, speed: 1.2, pitch: 0.05, split: "none" },
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
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }] },
  {
    kind: "song",
    notes: [
      { key: "C4", beats: 1, lyric: "ア" },
      { key: null, beats: 1 },
    ],
    tempo: 90,
  },
  { kind: "song", notes: { lyrics: "ドレミ", melody: "C4 D4 E4", beats: "1 1 2" }, singer: 3001, teacher: 6000 },
  {
    kind: "song",
    notes: { lyrics: "ア", melody: "C4", beats: [1] },
    transpose: -2,
    volume: 1.2,
    vibratoDepth: 30,
    vibratoRate: 6,
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
  { kind: "speech", text: "x", split: "words" },
  { kind: "speech", text: "x", speaker: -1 },
  { kind: "speech", text: "x", sampleRate: 100 },
  { kind: "song" },
  { kind: "song", notes: [] },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア", extra: true }] },
  { kind: "song", notes: [{ key: null, beats: 1, lyric: "ア" }] },
  { kind: "song", notes: [{ key: 60, beats: 0, lyric: "ア" }] },
  { kind: "song", notes: [{ key: "X9", beats: 1, lyric: "ア" }] },
  { kind: "song", notes: { melody: "C4" } },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }], tempo: 5 },
  { kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }], transpose: 1.5 },
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

test("every schema property is understood by the parser", () => {
  const speech = {
    kind: "speech",
    engine: "formant",
    sampleRate: 24000,
    volume: 1,
    seed: 1,
    text: "x",
    kana: "ア'",
    speaker: 1,
    speed: 1,
    pitch: 0,
    intonation: 1,
    prePause: 0.1,
    postPause: 0.1,
    pauseLength: 0.2,
    pauseScale: 1,
    upspeak: true,
    split: "none",
  };
  assert.deepEqual(new Set(Object.keys(speech)), new Set(Object.keys(SPEECH_PROPERTIES)));
  assert.equal(validate(speech), true, JSON.stringify(validate.errors));
  parseRequest(speech);
  const song = {
    kind: "song",
    engine: "formant",
    sampleRate: 24000,
    volume: 1,
    seed: 1,
    notes: { lyrics: "ア", melody: "C4", beats: [1] },
    tempo: 120,
    singer: 1,
    teacher: 2,
    transpose: 0,
    vibratoDepth: 10,
    vibratoRate: 5,
    leadIn: 0.1,
    leadOut: 0.1,
  };
  assert.deepEqual(new Set(Object.keys(song)), new Set(Object.keys(SONG_PROPERTIES)));
  assert.equal(validate(song), true, JSON.stringify(validate.errors));
  parseRequest(song);
});

test("defaults are materialized and errors carry paths and hints", () => {
  const speech = parseRequest({ kind: "speech", text: " こんにちは " });
  assert.equal(speech.kind, "speech");
  if (speech.kind === "speech") {
    assert.equal(speech.engine, "voicevox");
    assert.equal(speech.speed, 1);
    assert.equal(speech.upspeak, true);
    assert.equal(speech.split, "sentence");
    assert.equal(speech.sampleRate, undefined);
    assert.equal(speech.pauseLength, undefined);
  }
  const song = parseRequest({ kind: "song", notes: { lyrics: "ド", melody: "C4" }, transpose: 12 });
  if (song.kind === "song") {
    assert.equal(song.tempo, 120);
    assert.equal(song.notes[0]?.key, 72);
    assert.equal(song.notes[0]?.lyric, "ド");
    assert.equal(song.vibratoDepth, undefined);
    assert.equal(song.vibratoRate, 5.5);
  }
  const unknown = failure(() => parseRequest({ kind: "speech", text: "x", speeed: 1 }));
  assert.equal(unknown.path, "$.speeed");
  assert.ok(unknown.hint?.includes("Allowed properties"));
  assert.equal(failure(() => parseRequest({ kind: "speech", text: "x", kana: "コン" })).path, "$.kana[0]");
  assert.equal(failure(() => parseRequest({ kind: "speech", text: "   " })).path, "$.text");
  const long = Array.from({ length: 20 }, () => ({ key: 60, beats: 64, lyric: "ア" }));
  assert.equal(failure(() => parseRequest({ kind: "song", notes: long, tempo: 20 })).path, "$.notes");
});

test("style references accept ids, numeric strings, and names", () => {
  assert.equal(parseStyleRef(3, "$.speaker"), 3);
  assert.equal(parseStyleRef(" 42 ", "$.speaker"), 42);
  assert.equal(parseStyleRef("ずんだもん/ノーマル", "$.speaker"), "ずんだもん/ノーマル");
  assert.equal(failure(() => parseStyleRef("", "$.speaker")).path, "$.speaker");
  assert.equal(failure(() => parseStyleRef(1.5, "$.speaker")).path, "$.speaker");
  assert.equal(failure(() => parseStyleRef(true, "$.speaker")).path, "$.speaker");
});

test("parseJson bounds input and reports syntax errors", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(failure(() => parseJson("{")).code, "INVALID_INPUT");
  assert.equal(failure(() => parseJson("x".repeat(9 * 1024 * 1024))).code, "INVALID_INPUT");
});

test("the batch schema references the request schema and capabilities carry the version", async () => {
  assert.equal(BATCH_JOB_SCHEMA["title"], "kongyoroid BatchJob");
  assert.equal(CAPABILITIES["version"], VERSION);
  const pkg: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(isObject(pkg));
  assert.equal(pkg["version"], VERSION);
  assert.equal(CAPABILITIES["name"], "@kongyo2/kongyoroid");
});

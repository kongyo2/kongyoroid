import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { parseSongRequest, parseSpeechRequest } from "../src/request.ts";
import { VoicevoxClient } from "../src/voicevox/client.ts";
import { Dictionary } from "../src/voicevox/dictionary.ts";
import { synthesizeSong } from "../src/voicevox/song.ts";
import { synthesizeSpeech } from "../src/voicevox/speech.ts";
import { StyleCatalog } from "../src/voicevox/styles.ts";
import { inspectWav } from "../src/wav.ts";
import { list, pick } from "./helpers/cli.ts";
import { MockEngine } from "./helpers/mock-engine.ts";

const engine = new MockEngine();
let client: VoicevoxClient;
let catalog: StyleCatalog;

before(async () => {
  await engine.start();
  client = new VoicevoxClient({ endpoint: engine.url, timeoutMs: 5000, retries: 2 });
  catalog = new StyleCatalog(client);
});

after(async () => {
  await engine.stop();
});

beforeEach(() => {
  engine.requests.length = 0;
  engine.faults.length = 0;
  engine.delayMs = 0;
  engine.stereo = false;
});

async function failure(promise: Promise<unknown>): Promise<KongyoroidError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

test("client reads engine metadata and validates shapes", async () => {
  assert.equal(await client.version(), "0.24.0-mock");
  const manifest = await client.manifest();
  assert.equal(manifest.frameRate, 93.75);
  assert.equal(manifest.defaultSamplingRate, 24000);
  assert.equal(manifest.supportedFeatures["sing"], true);
  assert.deepEqual(await client.supportedDevices(), { cpu: true, cuda: false, dml: false });
  const speakers = await client.speakers();
  assert.equal(speakers.length, 5);
  assert.deepEqual(speakers[0], {
    id: 3,
    name: "ノーマル",
    character: "ずんだもん",
    characterUuid: "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9",
    type: "talk",
    version: "0.14.0",
  });
  assert.equal((await client.singers()).find((s) => s.id === 6000)?.type, "singing_teacher");
  assert.equal(engine.count("version"), 1);
  await client.version();
  assert.equal(engine.count("version"), 1);
});

test("client rejects bad endpoints and unsupported protocols", () => {
  assert.throws(() => new VoicevoxClient({ endpoint: "not a url" }), KongyoroidError);
  assert.throws(() => new VoicevoxClient({ endpoint: "ftp://host" }), KongyoroidError);
  assert.equal(new VoicevoxClient({ endpoint: "http://host:1/base?x=1#y" }).endpoint.href, "http://host:1/base/");
});

test("styles resolve by id, character, character/style, and report near misses", async () => {
  assert.deepEqual(await catalog.resolve(undefined, "speaker"), {
    id: 3,
    name: "ノーマル",
    character: "ずんだもん",
    type: "talk",
  });
  assert.equal((await catalog.resolve(2, "speaker")).character, "四国めたん");
  assert.equal((await catalog.resolve("四国めたん", "speaker")).id, 2);
  assert.equal((await catalog.resolve("ずんだもん/あまあま", "speaker")).id, 1);
  assert.equal((await catalog.resolve("ずんだもん／ささやき", "speaker")).id, 22);
  assert.equal((await catalog.resolve("ナースロボ_タイプT", "singer")).id, 3002);
  assert.equal((await catalog.resolve("めたん", "speaker")).id, 2);
  assert.equal((await catalog.resolve(undefined, "singer")).id, 3001);
  assert.equal((await catalog.resolve(undefined, "teacher")).id, 6000);
  const wrongType = await failure(catalog.resolve(3, "singer"));
  assert.equal(wrongType.path, "$.singer");
  assert.ok(wrongType.hint?.includes("3001"));
  const unknownId = await failure(catalog.resolve(99, "speaker"));
  assert.ok(unknownId.message.includes("99"));
  const unknownStyle = await failure(catalog.resolve("ずんだもん/ツンツン", "speaker"));
  assert.ok(unknownStyle.hint?.includes("ノーマル (3)"));
  const unknownName = await failure(catalog.resolve("だれ", "speaker"));
  assert.ok(unknownName.hint?.includes("Available"));
  const ambiguous = await failure(catalog.resolve("ノーマル/x", "speaker"));
  assert.equal(ambiguous.code, "INVALID_INPUT");
  assert.equal(engine.count("speakers"), 1);
});

test("speech synthesis chunks text, applies settings, and concatenates audio", async () => {
  const request = parseSpeechRequest({
    kind: "speech",
    text: "こんにちは。げんきですか？\nつぎのだんらく。",
    speed: 1.5,
    pitch: 0.1,
    intonation: 0.8,
    volume: 0.7,
    prePause: 0.2,
    postPause: 0.3,
    pauseLength: 0.4,
    pauseScale: 2,
    upspeak: false,
    sampleRate: 16000,
  });
  const speaker = await catalog.resolve(3, "speaker");
  const result = await synthesizeSpeech(client, request, speaker, { concurrency: 2 });
  assert.equal(result.chunks, 3);
  assert.equal(result.sampleRate, 16000);
  const info = inspectWav(result.audio);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.ok(result.kana.includes("コ'ンニチハ"));
  assert.ok(result.kana.includes("/"));
  const syntheses = engine.requests.filter((r) => r.path === "synthesis");
  assert.equal(syntheses.length, 3);
  const body = syntheses[0]?.body;
  assert.equal(pick(body, "speedScale"), 1.5);
  assert.equal(pick(body, "pitchScale"), 0.1);
  assert.equal(pick(body, "intonationScale"), 0.8);
  assert.equal(pick(body, "volumeScale"), 0.7);
  assert.equal(pick(body, "prePhonemeLength"), 0.2);
  assert.equal(pick(body, "postPhonemeLength"), 0.3);
  assert.equal(pick(body, "pauseLength"), 0.4);
  assert.equal(pick(body, "pauseLengthScale"), 2);
  assert.equal(pick(body, "outputSamplingRate"), 16000);
  assert.equal(pick(body, "outputStereo"), false);
  assert.equal(syntheses[0]?.query["enable_interrogative_upspeak"], "false");
  assert.equal(syntheses[0]?.query["speaker"], "3");
  const expectedSeconds = syntheses.reduce((sum, r) => {
    let moras = 0;
    let pauses = 0;
    for (const phrase of list(pick(r.body, "accent_phrases"))) {
      moras += list(pick(phrase, "moras")).length;
      if (pick(phrase, "pause_mora") !== null) pauses += 1;
    }
    return sum + 0.5 + (moras * 0.08 + moras * 0.03 * 0 + pauses * 0.4) / 1.5;
  }, 0);
  assert.ok(Math.abs(info.durationSeconds - expectedSeconds) < 0.5, `${info.durationSeconds} vs ${expectedSeconds}`);
});

test("kana notation bypasses text analysis and is sent as-is", async () => {
  const request = parseSpeechRequest({ kind: "speech", text: "橋", kana: "ハ'シ", split: "sentence" });
  const result = await synthesizeSpeech(client, request, await catalog.resolve(3, "speaker"));
  assert.equal(result.kana, "ハ'シ");
  assert.equal(result.chunks, 1);
  assert.equal(engine.count("audio_query"), 0);
  const accent = engine.requests.find((r) => r.path === "accent_phrases");
  assert.equal(accent?.query["is_kana"], "true");
  assert.equal(accent?.query["text"], "ハ'シ");
});

test("engine rejections surface the detail and are not retried", async () => {
  const request = parseSpeechRequest({ kind: "speech", text: "x", kana: "ハ'シ" });
  engine.failNext(400, 1, "accent_phrases", {
    detail: { text: "判別できない読み仮名があります: X", error_name: "UNKNOWN_TEXT", error_args: { text: "X" } },
  });
  const error = await failure(synthesizeSpeech(client, request, await catalog.resolve(3, "speaker")));
  assert.equal(error.code, "ENGINE_REJECTED");
  assert.equal(error.status, 400);
  assert.ok(error.message.includes("判別できない"));
  assert.equal(error.retryable, false);
  assert.equal(engine.count("accent_phrases"), 1);
  engine.failNext(422, 1, "audio_query", {
    detail: [{ loc: ["query", "speaker"], msg: "value is not a valid integer", type: "type_error" }],
  });
  const validation = await failure(client.audioQuery("x", 3));
  assert.ok(validation.message.includes("query.speaker: value is not a valid integer"));
});

test("retryable HTTP failures are retried with backoff and then succeed", async () => {
  engine.failNext(503, 2, "version", undefined, { "retry-after": "0" });
  const fresh = new VoicevoxClient({ endpoint: engine.url, retries: 2 });
  assert.equal(await fresh.version(), "0.24.0-mock");
  assert.equal(engine.count("version"), 3);
  engine.failNext(500, 3, "version");
  const exhausted = new VoicevoxClient({ endpoint: engine.url, retries: 1 });
  const error = await failure(exhausted.version());
  assert.equal(error.code, "ENGINE_HTTP");
  assert.equal(error.status, 500);
  assert.equal(error.retryable, true);
});

test("timeouts, unreachable endpoints, oversize bodies, and aborts map to codes", async () => {
  engine.delayMs = 300;
  const slow = new VoicevoxClient({ endpoint: engine.url, timeoutMs: 100, retries: 0 });
  const timeout = await failure(slow.supportedDevices());
  assert.equal(timeout.code, "TIMEOUT");
  assert.ok(timeout.hint?.includes("timeout-ms"));
  engine.delayMs = 0;
  const unreachable = new VoicevoxClient({ endpoint: "http://127.0.0.1:1", retries: 0 });
  const down = await failure(unreachable.version());
  assert.equal(down.code, "ENGINE_UNAVAILABLE");
  assert.ok(down.hint?.includes("--engine formant"));
  engine.padBytes = 4096;
  const small = new VoicevoxClient({ endpoint: engine.url, maxResponseBytes: 1024, retries: 0 });
  const oversize = await failure(small.supportedDevices());
  assert.equal(oversize.code, "ENGINE_PROTOCOL");
  const controller = new AbortController();
  engine.delayMs = 200;
  const pending = client.supportedDevices({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const aborted = await failure(pending);
  assert.equal(aborted.code, "ABORTED");
  engine.delayMs = 0;
  const notFound = await failure(client.json({ method: "GET", path: "nothing" }));
  assert.equal(notFound.code, "ENGINE_REJECTED");
  assert.equal(notFound.status, 404);
});

test("stereo or mismatched audio from the engine is reported as a protocol error", async () => {
  engine.stereo = true;
  const request = parseSpeechRequest({ kind: "speech", text: "あ", split: "none" });
  const error = await failure(synthesizeSpeech(client, request, await catalog.resolve(3, "speaker")));
  assert.equal(error.code, "ENGINE_PROTOCOL");
  assert.ok(error.message.includes("2 channel"));
});

test("song synthesis sends a padded score to the teacher and audio to the singer", async () => {
  const request = parseSongRequest({
    kind: "song",
    notes: { lyrics: "きらきら", melody: "C4 C4 G4 G4", beats: "1 1 1 2" },
    tempo: 100,
    volume: 0.5,
    vibratoDepth: 40,
    sampleRate: 44100,
  });
  const singer = await catalog.resolve(3001, "singer");
  const teacher = await catalog.resolve(6000, "teacher");
  const result = await synthesizeSong(client, request, singer, teacher);
  const info = inspectWav(result.audio);
  assert.equal(info.sampleRate, 44100);
  assert.equal(result.frameRate, 93.75);
  const query = engine.requests.find((r) => r.path === "sing_frame_audio_query");
  assert.equal(query?.query["speaker"], "6000");
  const notes = list(pick(query?.body, "notes"));
  assert.equal(pick(notes[0], "id"), "lead-in");
  assert.equal(pick(notes[0], "key"), null);
  assert.deepEqual(
    notes.slice(1, 5).map((n) => [pick(n, "key"), pick(n, "lyric")]),
    [
      [60, "キ"],
      [60, "ラ"],
      [67, "キ"],
      [67, "ラ"],
    ],
  );
  assert.equal(pick(notes.at(-1), "id"), "lead-out");
  const totalFrames = notes.reduce((sum: number, n) => sum + Number(pick(n, "frame_length")), 0);
  assert.equal(result.frames, totalFrames);
  assert.ok(Math.abs(info.durationSeconds - totalFrames / 93.75) < 0.01);
  const synthesis = engine.requests.find((r) => r.path === "frame_synthesis");
  assert.equal(synthesis?.query["speaker"], "3001");
  const body = synthesis?.body;
  assert.equal(pick(body, "volumeScale"), 0.5);
  assert.equal(pick(body, "outputSamplingRate"), 44100);
  const voiced = list(pick(body, "f0")).filter((hz): hz is number => typeof hz === "number" && hz > 0);
  assert.ok(
    voiced.some((hz) => Math.abs(hz - 261.63) > 0.5),
    "vibrato modulates f0",
  );
});

test("song errors from the engine are reported with their detail", async () => {
  const request = parseSongRequest({ kind: "song", notes: [{ key: 60, beats: 1, lyric: "ア" }] });
  engine.failNext(400, 1, "sing_frame_audio_query", { detail: "lyricが不正です: X" });
  const error = await failure(
    synthesizeSong(client, request, await catalog.resolve(3001, "singer"), await catalog.resolve(6000, "teacher")),
  );
  assert.equal(error.code, "ENGINE_REJECTED");
  assert.ok(error.message.includes("lyricが不正です"));
});

test("dictionary words are validated locally and round-trip through the engine", async () => {
  const dictionary = new Dictionary(client);
  const uuid = await dictionary.add({
    surface: "金曜日",
    pronunciation: "きんようび",
    accentType: 3,
    wordType: "COMMON_NOUN",
    priority: 6,
  });
  const words = await dictionary.list();
  const word = words.find((w) => w.uuid === uuid);
  assert.equal(word?.pronunciation, "キンヨウビ");
  assert.equal(word?.accentType, 3);
  assert.equal(word?.moraCount, 5);
  await dictionary.update(uuid, { surface: "金曜日", pronunciation: "キンヨービ", accentType: 0 });
  assert.equal((await dictionary.list()).find((w) => w.uuid === uuid)?.pronunciation, "キンヨービ");
  await dictionary.remove(uuid);
  assert.equal((await dictionary.list()).length, 0);
  const bad = await failure(dictionary.add({ surface: "x", pronunciation: "kin", accentType: 0 }));
  assert.equal(bad.path, "$.pronunciation");
  const accent = await failure(dictionary.add({ surface: "x", pronunciation: "アイ", accentType: 3 }));
  assert.equal(accent.path, "$.accentType");
  const type = await failure(dictionary.add({ surface: "x", pronunciation: "アイ", accentType: 1, wordType: "NOUN" }));
  assert.equal(type.path, "$.wordType");
  const missing = await failure(dictionary.remove("nope"));
  assert.equal(missing.code, "ENGINE_REJECTED");
});

test("speaker initialization and kana validation endpoints are exposed", async () => {
  await client.initializeSpeaker(3);
  assert.equal(await client.isInitializedSpeaker(3), true);
  assert.equal(await client.validateKana("コンニチワ'"), true);
  const invalid = await failure(client.validateKana("コン"));
  assert.equal(invalid.code, "ENGINE_REJECTED");
  assert.equal(engine.requests.find((r) => r.path === "initialize_speaker")?.query["skip_reinit"], "true");
});

test("kana notation is canonicalized before it reaches the engine", async () => {
  const request = parseSpeechRequest({ kind: "speech", text: "x", kana: "すーぱー'" });
  await synthesizeSpeech(client, request, await catalog.resolve(3, "speaker"));
  const accent = engine.requests.find((r) => r.path === "accent_phrases");
  assert.equal(accent?.query["text"], "スーパー'");
});

test("dictionary creation is never retried", async () => {
  engine.failNext(503, 1, "user_dict_word");
  const error = await failure(client.addDictionaryWord({ surface: "x", pronunciation: "エックス", accentType: 0 }));
  assert.equal(error.code, "ENGINE_HTTP");
  assert.equal(engine.count("user_dict_word"), 1);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { Kongyoroid } from "../src/kongyoroid.ts";
import { MockEngine } from "./helpers/mock-engine.ts";

const engine = new MockEngine();

before(async () => {
  await engine.start();
});

after(async () => {
  await engine.stop();
});

beforeEach(() => {
  engine.requests.length = 0;
  engine.faults.length = 0;
});

test("speak resolves defaults, reports styles, and caches identical requests", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url, speaker: "四国めたん" });
  const first = await agent.speak("こんにちは");
  assert.equal(first.engine, "voicevox");
  assert.equal(first.kind, "speech");
  assert.equal(first.styles.speaker?.id, 2);
  assert.equal(first.cached, false);
  assert.ok(first.kana !== undefined && first.kana.length > 0);
  assert.equal(first.info.channels, 1);
  const second = await agent.speak({ text: "こんにちは" });
  assert.equal(second.cached, true);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.kana, first.kana);
  assert.equal(engine.count("synthesis"), 1);
  const explicit = await agent.speak({ text: "こんにちは", speaker: 3 });
  assert.equal(explicit.styles.speaker?.id, 3);
  assert.equal(explicit.cached, false);
});

test("sing resolves singer and teacher, using a sing-type style for both when possible", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url });
  const result = await agent.sing({ notes: { lyrics: "ドレ", melody: "C4 D4" } });
  assert.equal(result.styles.singer?.id, 3001);
  assert.equal(result.styles.teacher?.id, 6000);
  const both = await agent.sing({ notes: { lyrics: "ドレ", melody: "C4 D4" }, singer: "ナースロボ＿タイプＴ" });
  assert.equal(both.styles.singer?.id, 3002);
  assert.equal(both.styles.teacher?.id, 3002);
  const explicit = await agent.sing({ notes: [{ key: 60, beats: 1, lyric: "ア" }], singer: 3001, teacher: 3002 });
  assert.equal(explicit.styles.teacher?.id, 3002);
});

test("the formant engine needs no network and honors the disk cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kongyoroid-agent-"));
  try {
    const agent = new Kongyoroid({ endpoint: "http://127.0.0.1:1", engine: "formant", cacheDir: directory });
    const result = await agent.speak("てすと");
    assert.equal(result.engine, "formant");
    assert.equal(result.cached, false);
    const again = new Kongyoroid({ endpoint: "http://127.0.0.1:1", engine: "formant", cacheDir: directory });
    const cached = await again.speak("てすと");
    assert.equal(cached.cached, true);
    assert.equal(cached.sha256, result.sha256);
    assert.equal(engine.requests.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("engine auto probes the endpoint and falls back to formant", async () => {
  const online = new Kongyoroid({ endpoint: engine.url, engine: "auto" });
  assert.equal((await online.speak("あ")).engine, "voicevox");
  const offline = new Kongyoroid({ endpoint: "http://127.0.0.1:1", engine: "auto", probeTimeoutMs: 500 });
  assert.equal((await offline.speak("あ")).engine, "formant");
  assert.equal((await offline.sing({ notes: { lyrics: "あ", melody: "C4" } })).engine, "formant");
});

test("render validates untrusted input before touching the engine", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url });
  await assert.rejects(
    agent.render({ kind: "speech" }),
    (error: unknown) => error instanceof KongyoroidError && error.path === "$.text",
  );
  await assert.rejects(
    agent.render("nope"),
    (error: unknown) => error instanceof KongyoroidError && error.code === "INVALID_INPUT",
  );
  assert.equal(engine.requests.length, 0);
  await assert.rejects(
    agent.speak({ text: "x", speaker: "誰もいない" }),
    (error: unknown) => error instanceof KongyoroidError && error.path === "$.speaker",
  );
});

test("reading, voices, doctor, and dictionary expose engine information", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url });
  const reading = await agent.reading("こんにちは、せかい？");
  assert.equal(reading.speaker.id, 3);
  assert.ok(reading.kana.startsWith("コ'ンニチハ、"));
  assert.equal(reading.phrases.length, 2);
  assert.equal(reading.phrases[0]?.pause, true);
  assert.equal(reading.phrases[1]?.interrogative, true);
  assert.equal(reading.phrases[0]?.moras[0]?.text, "コ");
  const forced = await agent.reading("橋", { kana: "ハ'シ", speaker: 2 });
  assert.equal(forced.kana, "ハ'シ");
  assert.equal(forced.speaker.id, 2);
  assert.equal((await agent.voices("speech")).length, 5);
  assert.equal((await agent.voices("song")).length, 3);
  assert.equal((await agent.voices()).length, 8);
  const diagnosis = await agent.doctor();
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.version, "0.24.0-mock");
  assert.deepEqual(diagnosis.styles, { speech: 5, song: 2, teacher: 2, total: 8 });
  const down = await new Kongyoroid({ endpoint: "http://127.0.0.1:1", retries: 0 }).doctor();
  assert.equal(down.ok, false);
  assert.equal(down.error?.code, "ENGINE_UNAVAILABLE");
  const uuid = await agent.dictionary.add({ surface: "こんぎょ", pronunciation: "コンギョ", accentType: 1 });
  assert.ok((await agent.dictionary.list()).some((w) => w.uuid === uuid));
  await agent.dictionary.remove(uuid);
});

test("aborting a render rejects with ABORTED", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    agent.speak("あ", { signal: controller.signal }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
});

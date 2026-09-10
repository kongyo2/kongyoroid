import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { Kongyoroid } from "../src/kongyoroid.ts";
import { parseKanaNotation } from "../src/text/notation.ts";
import { loadFrontend } from "../src/text/frontend.ts";
import { ENGINE_VERSION } from "../src/version.ts";
import { MockEngine } from "./helpers/mock-engine.ts";

const engine = new MockEngine();
const DOWN = "http://127.0.0.1:1";

before(async () => {
  await engine.start();
  await loadFrontend();
});

after(async () => {
  await engine.stop();
});

beforeEach(() => {
  engine.requests.length = 0;
  engine.faults.length = 0;
});

test("the formant engine reads kanji text offline and reports readings, hashes, and stats", async () => {
  const agent = new Kongyoroid({ endpoint: DOWN });
  const result = await agent.speak("橋の端で箸を使う。");
  assert.equal(result.engine, "formant");
  assert.equal(result.kind, "speech");
  assert.equal(result.voice, "neutral");
  assert.equal(result.kana, "ハシ'ノ/ハシデ/ハ'シヲ/_ツカウ。");
  assert.equal(result.cached, false);
  assert.equal(result.info.channels, 1);
  assert.equal(result.info.sampleRate, 24000);
  assert.ok(result.peak !== undefined && result.peak > 0.1 && result.peak <= 1);
  assert.equal(result.limitedSamples, 0);
  assert.equal(result.requestHash.length, 64);
  assert.equal(result.engineVersion, ENGINE_VERSION);
  assert.match(result.engineVersion, /^formant-\d+\.\d+\.\d+$/u);
  assert.ok(result.timings.readMs >= 0 && result.timings.renderMs > 0);
  assert.equal(engine.requests.length, 0);
  const again = await agent.speak("橋の端で箸を使う。");
  assert.equal(again.cached, true);
  assert.equal(again.sha256, result.sha256);
  assert.equal(again.kana, result.kana);
});

test("validate, plan, compile, and renderPlan form an inspect-then-render loop", async () => {
  const agent = new Kongyoroid({ endpoint: DOWN, cache: { enabled: false } });
  const request = { kind: "song", notes: { lyrics: "きらきら", melody: "C4 C4 G4 G4" }, tempo: 100 };
  const validation = await agent.validate(request);
  assert.equal(validation.renderable, true);
  assert.equal(validation.engine, "formant");
  assert.equal(validation.notes, 4);
  assert.ok(validation.estimate !== null && validation.estimate.wavBytes === 44 + validation.estimate.frames * 2);
  assert.equal(validation.planHash?.length, 64);
  const planned = await agent.plan(request, { detail: "phonemes" });
  assert.equal(planned.plan.notes.length, 4);
  assert.equal(planned.plan.planHash, validation.planHash);
  assert.ok(planned.plan.phonemes !== undefined && planned.plan.phonemes.some((p) => p.phoneme === "k"));
  const shorthand = await agent.plan(request, "acoustics");
  assert.ok(shorthand.plan.phonemes?.[0]?.keyframes !== undefined);
  assert.equal((await agent.plan(request)).plan.phonemes, undefined);
  const compiled = await agent.compile(request);
  const rendered = await agent.renderPlan(compiled.plan, { requestHash: compiled.requestHash });
  const direct = await agent.render(request);
  assert.equal(rendered.sha256, direct.sha256);
  assert.equal(rendered.info.frames, validation.estimate?.frames);
  const speech = await agent.validate({
    kind: "speech",
    text: "kongyoroidのテスト",
    dictionary: [{ surface: "kongyoroid", reading: "コンギョロイド", accent: 0 }],
  });
  assert.equal(speech.reading?.kana, "コンギョロイドノ/テ'_スト。");
  const voicevox = await agent.validate({ kind: "speech", text: "x", speaker: 3 });
  assert.equal(voicevox.renderable, "unknown");
  await assert.rejects(
    agent.plan({ kind: "speech", text: "x", speaker: 3 }),
    (error: unknown) => error instanceof KongyoroidError && error.repairOptions?.[0]?.action === "use-formant-engine",
  );
});

test("the disk cache lives in its own namespace, tolerates failures, and dedupes in-flight renders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kongyoroid-agent-"));
  try {
    await writeFile(join(directory, "unrelated.txt"), "keep");
    const agent = new Kongyoroid({ endpoint: DOWN, cacheDir: directory });
    const [first, second] = await Promise.all([agent.speak("てすと"), agent.speak("てすと")]);
    assert.equal(first.sha256, second.sha256);
    const again = new Kongyoroid({ endpoint: DOWN, cacheDir: directory });
    const cached = await again.speak("てすと");
    assert.equal(cached.cached, true);
    assert.equal(cached.sha256, first.sha256);
    assert.ok((await again.cacheStats())?.entries === 1);
    assert.ok((await again.clearCache()) >= 1);
    assert.equal(await readFile(join(directory, "unrelated.txt"), "utf8"), "keep");
    const broken = new Kongyoroid({ endpoint: DOWN, cacheDir: join(directory, "unrelated.txt") });
    const result = await broken.speak("てすと");
    assert.ok(result.warnings.some((warning) => warning.code === "CACHE_WRITE_FAILED"));
    const strict = new Kongyoroid({
      endpoint: DOWN,
      cache: { directory: join(directory, "unrelated.txt"), strict: true },
    });
    await assert.rejects(strict.speak("てすと"), KongyoroidError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reading, voices, doctor, inspect, and dictionaries work without VOICEVOX", async () => {
  const agent = new Kongyoroid({
    endpoint: DOWN,
    dictionary: [{ surface: "kongyoroid", reading: "コンギョロイド", accent: 0 }],
  });
  const reading = await agent.reading("kongyoroidは便利です。");
  assert.equal(reading.engine, "formant");
  assert.equal(reading.kana, "コンギョロイドワ/ベ'ンリデ_ス。");
  assert.equal(reading.phrases[0]?.accentSource, "dictionary");
  assert.equal(reading.dictionaryHits[0]?.applied, true);
  const notation = await agent.reading("x", { kana: "ハ'シ" });
  assert.equal(notation.kana, "ハ'シ。");
  const voices = await agent.voices({ engine: "all", signal: AbortSignal.timeout(5000) });
  assert.equal(voices.voices.filter((voice) => voice.engine === "formant").length, 7);
  assert.equal(voices.voicevox.available, false);
  await assert.rejects(
    agent.voices({ engine: "voicevox" }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ENGINE_UNAVAILABLE",
  );
  const diagnosis = await agent.doctor();
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.voicevox, null);
  assert.equal(diagnosis.formant.frontend.available, true);
  assert.equal(diagnosis.formant.synthesis.ok, true);
  assert.equal(diagnosis.dictionary?.entries, 1);
  assert.equal(engine.requests.length, 0);
  const all = await agent.doctor({ engine: "all" });
  assert.equal(all.ok, false);
  assert.equal(all.voicevox?.ok, false);
  assert.equal(all.formant.ok, true);
  const song = await agent.sing({ notes: [{ key: "A3", beats: 2, lyric: "あ" }], vibratoDepth: 0 });
  const inspected = agent.inspect(song.audio, { pitchTrack: true });
  assert.equal(inspected.info.frames, song.info.frames);
  assert.ok(inspected.pitch.medianHz !== null && Math.abs(inspected.pitch.medianHz - 220) < 2);
  assert.ok(inspected.pitch.track !== undefined && inspected.pitch.track.length > 5);
});

test("streaming speech yields sentence and audio events through the facade", async () => {
  const agent = new Kongyoroid({ endpoint: DOWN });
  const events = agent.speakStream(
    (async function* (): AsyncGenerator<string, void, void> {
      yield "一つ目。";
      yield "二つ目。";
    })(),
    { voice: "female" },
  );
  const kinds: string[] = [];
  for await (const event of events) kinds.push(event.type);
  assert.equal(kinds.filter((kind) => kind === "sentence").length, 2);
  assert.ok(kinds.filter((kind) => kind === "audio").length > 4);
  assert.equal(kinds.at(-1), "end");
  assert.throws(
    () => agent.speakStream((async function* (): AsyncGenerator<string, void, void> {})(), { speaker: 3 }),
    KongyoroidError,
  );
  assert.throws(
    () => agent.speakStream((async function* (): AsyncGenerator<string, void, void> {})(), { kana: "ア'" }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "INVALID_INPUT" && error.path === "$.kana",
  );
  const auto = new Kongyoroid({ endpoint: DOWN, engine: "auto" });
  const autoKinds: string[] = [];
  for await (const event of auto.speakStream(
    (async function* (): AsyncGenerator<string, void, void> {
      yield "自動。";
    })(),
  )) {
    autoKinds.push(event.type);
  }
  assert.equal(autoKinds[0], "sentence");
  assert.equal(autoKinds.at(-1), "end");
});

test("speak against VOICEVOX resolves defaults, reports styles, and caches identical requests", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url, speaker: "四国めたん", engine: "voicevox" });
  const first = await agent.speak("こんにちは");
  assert.equal(first.engine, "voicevox");
  assert.equal(first.styles.speaker?.id, 2);
  assert.equal(first.cached, false);
  assert.ok(first.kana !== undefined && first.kana.length > 0);
  const second = await agent.speak({ text: "こんにちは" });
  assert.equal(second.cached, true);
  assert.equal(second.sha256, first.sha256);
  assert.equal(engine.count("synthesis"), 1);
  const explicit = await agent.speak({ text: "こんにちは", speaker: 3 });
  assert.equal(explicit.styles.speaker?.id, 3);
  const semitones = await agent.speak({ text: "こんにちは", speaker: 3, pitchSemitones: 12 });
  assert.notEqual(semitones.sha256, explicit.sha256);
});

test("sing against VOICEVOX resolves singer and teacher, using a sing-type style for both when possible", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url, engine: "voicevox" });
  const result = await agent.sing({ notes: { lyrics: "ドレ", melody: "C4 D4" } });
  assert.equal(result.styles.singer?.id, 3001);
  assert.equal(result.styles.teacher?.id, 6000);
  const both = await agent.sing({ notes: { lyrics: "ドレ", melody: "C4 D4" }, singer: "ナースロボ＿タイプＴ" });
  assert.equal(both.styles.singer?.id, 3002);
  assert.equal(both.styles.teacher?.id, 3002);
  const explicit = await agent.sing({ notes: [{ key: 60, beats: 1, lyric: "ア" }], singer: 3001, teacher: 3002 });
  assert.equal(explicit.styles.teacher?.id, 3002);
});

test("engine auto probes the endpoint and falls back to formant", async () => {
  const online = new Kongyoroid({ endpoint: engine.url, engine: "auto" });
  assert.equal((await online.speak("あ")).engine, "voicevox");
  const offline = new Kongyoroid({ endpoint: DOWN, engine: "auto", probeTimeoutMs: 500 });
  assert.equal((await offline.speak("あ")).engine, "formant");
  assert.equal((await offline.sing({ notes: { lyrics: "あ", melody: "C4" } })).engine, "formant");
});

test("render validates untrusted input before touching any engine", async () => {
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
  const bad = new Kongyoroid({ endpoint: "not a url" });
  await bad.speak("あ");
  await assert.rejects(
    bad.speak({ text: "x", speaker: 3 }),
    (error: unknown) => error instanceof KongyoroidError && error.path === "$.endpoint",
  );
});

test("VOICEVOX reading, voices, doctor, and dictionary expose engine information", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url, engine: "voicevox" });
  const reading = await agent.reading("こんにちは、せかい？");
  assert.equal(reading.engine, "voicevox");
  assert.equal(reading.speaker?.id, 3);
  assert.ok(reading.kana.startsWith("コ'ンニチハ、"));
  assert.equal(reading.phrases.length, 2);
  assert.equal(reading.phrases[0]?.pause, true);
  assert.equal(reading.phrases[1]?.interrogative, true);
  const forced = await agent.reading("橋", { kana: "ハ'シ", speaker: 2 });
  assert.equal(forced.kana, "ハ'シ");
  const voices = await agent.voices({ engine: "voicevox", kind: "speech" });
  assert.equal(voices.voices.length, 5);
  assert.equal(voices.voices[0]?.id, "voicevox:3");
  assert.equal((await agent.voices({ engine: "voicevox", kind: "song" })).voices.length, 3);
  assert.equal((await agent.voices({ engine: "all" })).voices.length, 15);
  const diagnosis = await agent.doctor();
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.voicevox?.version, "0.24.0-mock");
  assert.deepEqual(diagnosis.voicevox?.styles, { speech: 5, song: 2, teacher: 2, total: 8 });
  const uuid = await agent.voicevoxDictionary.add({ surface: "こんぎょ", pronunciation: "コンギョ", accentType: 1 });
  assert.ok((await agent.voicevoxDictionary.list()).some((w) => w.uuid === uuid));
  await agent.voicevoxDictionary.remove(uuid);
  assert.equal(parseKanaNotation(reading.kana).length, reading.phrases.length);
});

test("aborting a render rejects with ABORTED before any side effect", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url, engine: "voicevox" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    agent.speak("あ", { signal: controller.signal }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
  assert.equal(engine.requests.length, 0);
  const builtin = new Kongyoroid({ endpoint: DOWN });
  await assert.rejects(
    builtin.speak("あ", { signal: controller.signal }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
});

test("changing the VOICEVOX dictionary invalidates cached speech", async () => {
  const agent = new Kongyoroid({ endpoint: engine.url, engine: "voicevox" });
  const first = await agent.speak("辞書");
  assert.equal((await agent.speak("辞書")).cached, true);
  const uuid = await agent.voicevoxDictionary.add({ surface: "辞書", pronunciation: "ジショ", accentType: 1 });
  const afterAdd = await agent.speak("辞書");
  assert.equal(afterAdd.cached, false);
  await agent.voicevoxDictionary.remove(uuid);
  assert.equal((await agent.speak("辞書")).cached, true);
  assert.equal(first.sha256, afterAdd.sha256);
});

test("a probe timeout falls back to formant and a cancelled probe is not sticky", async () => {
  engine.delayMs = 400;
  try {
    const slow = new Kongyoroid({ endpoint: engine.url, engine: "auto", probeTimeoutMs: 100 });
    assert.equal((await slow.speak("あ")).engine, "formant");
    const cancelled = new Kongyoroid({ endpoint: engine.url, engine: "auto", probeTimeoutMs: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      cancelled.speak("あ", { signal: controller.signal }),
      (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
    );
    engine.delayMs = 0;
    assert.equal((await cancelled.speak("あ")).engine, "voicevox");
  } finally {
    engine.delayMs = 0;
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { COMMANDS } from "../src/cli/help.ts";
import { inspectWav } from "../src/wav.ts";
import { VERSION } from "../src/version.ts";
import type { CliResult } from "./helpers/cli.ts";
import { allJson, lastJson, list, pick, record, runCli } from "./helpers/cli.ts";
import { MockEngine } from "./helpers/mock-engine.ts";

const engine = new MockEngine();
let workdir = "";

before(async () => {
  await engine.start();
  workdir = await mkdtemp(join(tmpdir(), "kongyoroid-cli-"));
});

after(async () => {
  await engine.stop();
  await rm(workdir, { recursive: true, force: true });
});

test("--version, layered --help with examples, schema, and capabilities are machine readable", async () => {
  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.deepEqual(lastJson(version.stdout), { ok: true, name: "@kongyo2/kongyoroid", version: VERSION });
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("Usage: kongyoroid <command>"));
  assert.ok(!help.stdout.includes("--vibrato-depth"));
  for (const name of Object.keys(COMMANDS)) {
    const commandHelp = await runCli([name, "--help"]);
    assert.equal(commandHelp.code, 0, name);
    assert.ok(commandHelp.stdout.includes("Examples"), name);
    assert.ok(commandHelp.stdout.includes(`kongyoroid ${name}`), name);
  }
  const bare = await runCli([]);
  assert.equal(bare.code, 2);
  assert.ok(bare.stderr.includes("Usage"));
  const schema = await runCli(["schema"]);
  assert.equal(lastJson(schema.stdout)["title"], "kongyoroid RenderRequest");
  assert.equal(lastJson((await runCli(["schema", "--kind", "batch"])).stdout)["title"], "kongyoroid BatchJob");
  assert.equal(lastJson((await runCli(["schema", "--kind", "dictionary"])).stdout)["title"], "kongyoroid Dictionary");
  const capabilities = lastJson((await runCli(["capabilities"])).stdout);
  assert.equal(capabilities["version"], VERSION);
  assert.ok(Array.isArray(pick(capabilities, "engines", "formant", "voices")));
});

test("bad flags, unknown commands, and missing text exit 2 with JSON on stderr and hints", async () => {
  const unknownFlag = await runCli(["speak", "--text", "x", "--bogus"]);
  assert.equal(unknownFlag.code, 2);
  assert.equal(unknownFlag.stdout, "");
  assert.equal(pick(lastJson(unknownFlag.stderr), "error", "code"), "INVALID_INPUT");
  const wrongCommand = await runCli(["dance"]);
  assert.equal(wrongCommand.code, 2);
  assert.ok(String(pick(lastJson(wrongCommand.stderr), "error", "hint")).includes("--help"));
  const notAccepted = await runCli(["voices", "--text", "x"]);
  assert.equal(notAccepted.code, 2);
  assert.equal(pick(lastJson(notAccepted.stderr), "error", "path"), "$flags.text");
  const noText = await runCli(["speak"]);
  assert.equal(noText.code, 2);
  assert.ok(String(pick(lastJson(noText.stderr), "error", "hint")).includes("kongyoroid speak --text"));
  const badNumber = await runCli(["speak", "--text", "あ", "--speed", "fast"]);
  assert.equal(badNumber.code, 2);
  assert.equal(pick(lastJson(badNumber.stderr), "error", "path"), "$flags.speed");
  const extra = await runCli(["speak", "extra", "--text", "あ"]);
  assert.equal(extra.code, 2);
});

test("speak writes a WAV, is idempotent for identical content, and refuses different content without --force", async () => {
  const output = join(workdir, "speak.wav");
  const result = await runCli(["speak", "--text", "こんにちは", "--output", output]);
  assert.equal(result.code, 0, result.stderr);
  const json = lastJson(result.stdout);
  assert.equal(json["ok"], true);
  assert.equal(json["path"], output);
  assert.equal(json["written"], true);
  assert.equal(json["engine"], "formant");
  assert.equal(json["kana"], "コンニチワ。");
  assert.equal(inspectWav(new Uint8Array(await readFile(output))).frames, json["frames"]);
  const repeat = await runCli(["speak", "--text", "こんにちは", "--output", output]);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(lastJson(repeat.stdout)["unchanged"], true);
  const refused = await runCli(["speak", "--text", "別の文", "--output", output]);
  assert.equal(refused.code, 4);
  assert.equal(pick(lastJson(refused.stderr), "error", "code"), "IO_ERROR");
  assert.equal(pick(lastJson(refused.stderr), "error", "repairOptions", "0", "action"), "use-force");
  const forced = await runCli(["speak", "--text", "別の文", "--output", output, "--force"]);
  assert.equal(forced.code, 0);
  const defaultName = await runCli(["speak", "-t", "あ", "--voice", "female"], { cwd: workdir });
  assert.equal(defaultName.code, 0);
  assert.match(String(lastJson(defaultName.stdout)["path"]), /kongyoroid-speech-[0-9a-f]{12}\.wav$/u);
  assert.equal(lastJson(defaultName.stdout)["voice"], "female");
});

test("--output - streams WAV bytes to stdout and JSON to stderr; --plan-out writes the plan", async () => {
  const result = await runCli(["speak", "--text", "あいう", "-o", "-"]);
  assert.equal(result.code, 0);
  const info = inspectWav(new Uint8Array(result.stdoutBytes));
  assert.equal(info.channels, 1);
  const json = lastJson(result.stderr);
  assert.equal(json["ok"], true);
  assert.equal(json["output"], "stdout");
  assert.equal(json["frames"], info.frames);
  const withPlay = await runCli(["speak", "--text", "あ", "-o", "-", "--play"]);
  assert.equal(withPlay.code, 2);
  const planPath = join(workdir, "plan.json");
  const planned = await runCli([
    "sing",
    "--lyrics",
    "ど",
    "--melody",
    "C4",
    "-o",
    join(workdir, "plan.wav"),
    "--plan-out",
    planPath,
  ]);
  assert.equal(planned.code, 0, planned.stderr);
  const plan = record(JSON.parse(await readFile(planPath, "utf8")));
  assert.equal(plan["kind"], "song");
  assert.ok(Array.isArray(plan["phonemes"]));
});

test("render reads a request from stdin, validate and plan inspect without rendering, and --dry-run validates", async () => {
  const output = join(workdir, "render.wav");
  const request = { kind: "song", notes: { lyrics: "ドレ", melody: "C4 D4" } };
  const result = await runCli(["render", "--input", "-", "--output", output], { input: JSON.stringify(request) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastJson(result.stdout)["kind"], "song");
  const invalid = await runCli(["render", "-i", "-", "-o", join(workdir, "x.wav")], { input: "{" });
  assert.equal(invalid.code, 2);
  const validate = await runCli(["validate", "--input", "-"], { input: JSON.stringify(request) });
  assert.equal(validate.code, 0, validate.stderr);
  assert.equal(lastJson(validate.stdout)["renderable"], true);
  assert.equal(lastJson(validate.stdout)["notes"], 2);
  const invalidScore = await runCli(["validate", "--lyrics", "きらきら", "--melody", "C4 C4 G4"]);
  assert.equal(invalidScore.code, 2);
  assert.equal(pick(lastJson(invalidScore.stderr), "error", "path"), "$.notes.lyrics");
  const compact = await runCli([
    "validate",
    "--text",
    "彁彁は幽霊文字",
    "--no-strict-reading",
    "--diagnostics",
    "compact",
  ]);
  assert.equal(compact.code, 0);
  assert.match(compact.stdout, /^<request>:1:1: warning kongyoroid\(UNREADABLE_TEXT_SKIPPED\)/u);
  const plan = await runCli(["plan", "--text", "橋の端で箸を使う", "--detail", "phonemes"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(pick(lastJson(plan.stdout), "plan", "reading", "kana"), "ハシ'ノ/ハシデ/ハ'シヲ/_ツカウ。");
  assert.ok(Array.isArray(pick(lastJson(plan.stdout), "plan", "phonemes")));
  const dry = await runCli(["speak", "--text", "あ", "--dry-run", "-o", join(workdir, "never.wav")]);
  assert.equal(dry.code, 0);
  assert.equal(lastJson(dry.stdout)["dryRun"], true);
  await assert.rejects(readFile(join(workdir, "never.wav")));
  const textFile = join(workdir, "input.txt");
  await writeFile(textFile, "ふぁいる から\n");
  const fromFile = await runCli(["speak", "-i", textFile, "-o", join(workdir, "file.wav")]);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  const missing = await runCli(["speak", "-i", join(workdir, "nope.txt"), "-o", join(workdir, "y.wav")]);
  assert.equal(missing.code, 4);
});

test("speak --stream emits audio per sentence in pcm, ndjson, and file modes", async () => {
  const pcm = await runCli(["speak", "--input", "-", "--stream", "--output", "-", "--format", "pcm", "--progress"], {
    input: "最初の文です。次の文。",
  });
  assert.equal(pcm.code, 0, pcm.stderr);
  const lines = allJson(pcm.stderr);
  assert.equal(lines.filter((line) => line["type"] === "sentence").length, 2);
  const summary = lines.at(-1);
  assert.equal(summary?.["stream"], true);
  assert.equal(pcm.stdoutBytes.length, Number(summary?.["frames"]) * 2);
  const ndjson = await runCli(["speak", "--text", "一。二。", "--stream", "--output", "-", "--format", "ndjson"]);
  assert.equal(ndjson.code, 0, ndjson.stderr);
  const events = allJson(ndjson.stdout);
  assert.equal(events[0]?.["type"], "sentence");
  assert.ok(events.some((event) => event["type"] === "audio" && typeof event["base64"] === "string"));
  assert.equal(events.at(-1)?.["type"], "end");
  const file = join(workdir, "stream.wav");
  const toFile = await runCli(["speak", "--text", "ファイルへ。二文目。", "--stream", "--output", file]);
  assert.equal(toFile.code, 0, toFile.stderr);
  const info = inspectWav(new Uint8Array(await readFile(file)));
  assert.equal(info.frames, lastJson(toFile.stdout)["frames"]);
});

test("batch renders every line, reports failures per line, and exits with the worst code", async () => {
  const jobs = [
    { id: "one", request: { kind: "speech", text: "いち" } },
    { id: "two", request: { kind: "speech", text: "" } },
    { id: "one", request: { kind: "speech", text: "さん" } },
    { id: "four", request: { kind: "song", notes: { lyrics: "し", melody: "C4" } } },
  ];
  const outDir = join(workdir, "batch");
  const result = await runCli(["batch", "--input", "-", "--output-dir", outDir, "--concurrency", "2"], {
    input: `${jobs.map((job) => JSON.stringify(job)).join("\n")}\nnot json\n`,
  });
  assert.equal(result.code, 2);
  const lines = allJson(result.stdout);
  assert.equal(lines.length, 5);
  const byLine = new Map(lines.map((line) => [line["line"], line]));
  assert.equal(byLine.get(1)?.["ok"], true);
  assert.equal(byLine.get(2)?.["ok"], false);
  assert.equal(byLine.get(3)?.["ok"], false);
  assert.equal(byLine.get(4)?.["ok"], true);
  assert.equal(byLine.get(5)?.["ok"], false);
  assert.equal(pick(byLine.get(2), "error", "path"), "$.text");
  assert.ok(String(byLine.get(4)?.["path"]).endsWith("four.wav"));
  assert.ok((await readFile(join(outDir, "one.wav"))).length > 44);
  const rerun = await runCli(["batch", "--input", "-", "--output-dir", outDir], { input: JSON.stringify(jobs[0]) });
  assert.equal(rerun.code, 0);
  assert.equal(lastJson(rerun.stdout)["unchanged"], true);
});

test("reading, voices, doctor, inspect, dict, and cache work offline with the built-in engine", async () => {
  const reading = await runCli([
    "reading",
    "--text",
    "kongyoroidはLLM向けです",
    "--dict-entry",
    "kongyoroid=コンギョロイド:0",
  ]);
  assert.equal(reading.code, 0, reading.stderr);
  assert.equal(lastJson(reading.stdout)["kana"], "コンギョロイドワ/エルエルエ'ムムケデ_ス。");
  assert.equal(pick(lastJson(reading.stdout), "dictionaryHits", "1", "source"), "lexicon");
  assert.equal(pick(lastJson(reading.stdout), "phrases", "0", "accentSource"), "dictionary");
  const voices = await runCli(["voices", "--engine", "formant"]);
  assert.equal(voices.code, 0);
  assert.equal(lastJson(voices.stdout)["count"], 7);
  const all = await runCli(["voices"]);
  assert.equal(all.code, 0);
  assert.equal(pick(lastJson(all.stdout), "voicevox", "available"), false);
  const doctor = await runCli(["doctor"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(lastJson(doctor.stdout)["ok"], true);
  assert.equal(pick(lastJson(doctor.stdout), "formant", "synthesis", "ok"), true);
  const doctorAll = await runCli(["doctor", "--engine", "all"]);
  assert.equal(doctorAll.code, 3);
  const wav = join(workdir, "inspect.wav");
  await runCli(["sing", "--lyrics", "あ", "--melody", "A3", "--beats", "2", "--vibrato-depth", "0", "-o", wav]);
  const inspect = await runCli(["inspect", wav]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.ok(Math.abs(Number(pick(lastJson(inspect.stdout), "pitch", "medianHz")) - 220) < 2);
  const dictionary = join(workdir, "dict.json");
  const add = await runCli([
    "dict",
    "add",
    "--surface",
    "kongyoroid",
    "--reading",
    "コンギョロイド",
    "--accent",
    "0",
    "--dictionary",
    dictionary,
  ]);
  assert.equal(add.code, 0, add.stderr);
  assert.equal(lastJson(add.stdout)["created"], true);
  const again = await runCli([
    "dict",
    "add",
    "--surface",
    "kongyoroid",
    "--reading",
    "コンギョロイド",
    "--accent",
    "0",
    "--dictionary",
    dictionary,
  ]);
  assert.equal(lastJson(again.stdout)["unchanged"], true);
  const listed = await runCli(["dict", "list", "--dictionary", dictionary]);
  assert.equal(list(pick(lastJson(listed.stdout), "entries")).length, 1);
  const check = await runCli(["dict", "check", "--text", "kongyoroidを使う", "--dictionary", dictionary]);
  assert.equal(lastJson(check.stdout)["kana"], "コンギョロイドヲ/_ツカウ。");
  const spoken = await runCli([
    "speak",
    "--text",
    "kongyoroidを使う",
    "--dictionary",
    dictionary,
    "-o",
    join(workdir, "dict.wav"),
  ]);
  assert.equal(lastJson(spoken.stdout)["kana"], "コンギョロイドヲ/_ツカウ。");
  const removed = await runCli(["dict", "delete", "--id", "entry-1", "--dictionary", dictionary]);
  assert.equal(lastJson(removed.stdout)["deleted"], true);
  const cacheDir = join(workdir, "cache");
  await runCli(["speak", "--text", "きゃっしゅ", "--cache-dir", cacheDir, "-o", join(workdir, "c1.wav")]);
  const second = await runCli([
    "speak",
    "--text",
    "きゃっしゅ",
    "--cache-dir",
    cacheDir,
    "-o",
    join(workdir, "c2.wav"),
  ]);
  assert.equal(lastJson(second.stdout)["cached"], true);
  await writeFile(join(cacheDir, "unrelated.txt"), "keep");
  const stats = await runCli(["cache", "stats", "--cache-dir", cacheDir]);
  assert.equal(lastJson(stats.stdout)["entries"], 1);
  const cleared = await runCli(["cache", "clear", "--cache-dir", cacheDir]);
  assert.equal(lastJson(cleared.stdout)["removed"], 1);
  assert.equal(await readFile(join(cacheDir, "unrelated.txt"), "utf8"), "keep");
});

test("voices, reading, doctor, sing, and dict work against a VOICEVOX endpoint", async () => {
  const env = { KONGYOROID_ENDPOINT: engine.url };
  const voices = await runCli(["voices", "--engine", "voicevox", "--kind", "song"], { env });
  assert.equal(voices.code, 0, voices.stderr);
  assert.equal(lastJson(voices.stdout)["count"], 3);
  const filtered = await runCli(["voices", "--engine", "voicevox", "--query", "めたん"], { env });
  assert.equal(lastJson(filtered.stdout)["count"], 2);
  const reading = await runCli(["reading", "--text", "こんにちは", "--engine", "voicevox", "--speaker", "四国めたん"], {
    env,
  });
  assert.equal(reading.code, 0, reading.stderr);
  assert.equal(pick(lastJson(reading.stdout), "speaker", "id"), 2);
  const doctor = await runCli(["doctor", "--engine", "voicevox", "--speaker", "3", "--initialize"], { env });
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(pick(lastJson(doctor.stdout), "style", "initialized"), true);
  const down = await runCli(["doctor", "--engine", "voicevox"], { env: { KONGYOROID_ENDPOINT: "http://127.0.0.1:1" } });
  assert.equal(down.code, 3);
  const output = join(workdir, "sing.wav");
  const sing = await runCli(
    [
      "sing",
      "--lyrics",
      "ドレミ",
      "--melody",
      "C4 D4 E4",
      "--beats",
      "1 1 2",
      "--tempo",
      "100",
      "--singer",
      "ずんだもん",
      "-o",
      output,
    ],
    { env },
  );
  assert.equal(sing.code, 0, sing.stderr);
  assert.equal(lastJson(sing.stdout)["engine"], "voicevox");
  assert.equal(pick(lastJson(sing.stdout), "styles", "singer", "id"), 3001);
  const envSpeaker = await runCli(["speak", "-t", "はい", "-o", join(workdir, "env.wav")], {
    env: { ...env, KONGYOROID_SPEAKER: "ずんだもん/ささやき", KONGYOROID_ENGINE: "voicevox" },
  });
  assert.equal(envSpeaker.code, 0, envSpeaker.stderr);
  assert.equal(pick(lastJson(envSpeaker.stdout), "styles", "speaker", "id"), 22);
  const add = await runCli(
    ["dict", "add", "--scope", "voicevox", "--surface", "金曜日", "--reading", "キンヨウビ", "--accent", "3"],
    { env },
  );
  assert.equal(add.code, 0, add.stderr);
  const uuid = String(lastJson(add.stdout)["uuid"]);
  const words = await runCli(["dict", "list", "--scope", "voicevox"], { env });
  assert.ok(Array.isArray(pick(lastJson(words.stdout), "words")));
  const remove = await runCli(["dict", "delete", "--scope", "voicevox", "--id", uuid], { env });
  assert.equal(remove.code, 0, remove.stderr);
});

test("an unreachable engine exits 3 with a hint, and engine auto falls back", async () => {
  const unreachable = await runCli([
    "speak",
    "-t",
    "あ",
    "-o",
    join(workdir, "down.wav"),
    "--retries",
    "0",
    "--engine",
    "voicevox",
  ]);
  assert.equal(unreachable.code, 3);
  const error = lastJson(unreachable.stderr);
  assert.equal(pick(error, "error", "code"), "ENGINE_UNAVAILABLE");
  assert.ok(String(pick(error, "error", "hint")).includes("--engine formant"));
  const auto = await runCli(["speak", "-t", "あ", "-o", join(workdir, "auto.wav"), "--engine", "auto"]);
  assert.equal(auto.code, 0, auto.stderr);
  assert.equal(lastJson(auto.stdout)["engine"], "formant");
});

test("play reports a missing file or player as an io error", async () => {
  const missing = await runCli(["play", join(workdir, "missing.wav")], { env: { PATH: workdir } });
  assert.equal(missing.code, 4);
  assert.equal(pick(lastJson(missing.stderr), "error", "code"), "IO_ERROR");
  const wav = join(workdir, "playable.wav");
  await runCli(["speak", "--text", "あ", "-o", wav]);
  const result = await runCli(["play", wav], { env: { PATH: workdir } });
  assert.equal(result.code, 4);
  assert.equal(pick(lastJson(result.stderr), "error", "code"), "PLAYER_UNAVAILABLE");
});

test("--plan-out with a VOICEVOX render still writes the audio and reports that no plan exists", async () => {
  const env = { KONGYOROID_ENDPOINT: engine.url };
  const planPath = join(workdir, "voicevox.plan.json");
  const output = join(workdir, "voicevox-plan.wav");
  const result = await runCli(["speak", "--text", "あ", "--speaker", "3", "--plan-out", planPath, "-o", output], {
    env,
  });
  assert.equal(result.code, 0, result.stderr);
  const json = lastJson(result.stdout);
  assert.equal(json["engine"], "voicevox");
  assert.equal(json["written"], true);
  assert.ok(list(json["warnings"]).some((warning) => pick(warning, "code") === "PLAN_UNAVAILABLE"));
  await assert.rejects(readFile(planPath));
  const inline = await runCli(["speak", "--text", "あ", "--speaker", "3", "--plan-out", "-", "-o", output], { env });
  assert.equal(inline.code, 0, inline.stderr);
  assert.equal(lastJson(inline.stdout)["plan"], undefined);
  const formant = await runCli(["speak", "--text", "あ", "--plan-out", "-", "-o", join(workdir, "formant-plan.wav")]);
  assert.equal(formant.code, 0, formant.stderr);
  assert.equal(pick(lastJson(formant.stdout), "plan", "kind"), "speech");
  assert.ok(!list(lastJson(formant.stdout)["warnings"]).some((w) => pick(w, "code") === "PLAN_UNAVAILABLE"));
});

test("--stream honours --dry-run, writes an empty WAV for empty input, and flushes on --flush-ms", async () => {
  const dryPath = join(workdir, "stream-dry.wav");
  const dry = await runCli(["speak", "--text", "あ。い。", "--stream", "--dry-run", "-o", dryPath]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(lastJson(dry.stdout)["dryRun"], true);
  assert.equal(lastJson(dry.stdout)["operation"], "validate");
  await assert.rejects(readFile(dryPath));
  const emptyPath = join(workdir, "stream-empty.wav");
  const empty = await runCli(["speak", "--input", "-", "--stream", "-o", emptyPath], { input: "" });
  assert.equal(empty.code, 0, empty.stderr);
  const summary = lastJson(empty.stdout);
  assert.equal(summary["output"], emptyPath);
  assert.equal(summary["written"], true);
  assert.equal(summary["sentences"], 0);
  assert.equal(inspectWav(new Uint8Array(await readFile(emptyPath))).frames, 0);
  const flushed = await runCli(
    ["speak", "--input", "-", "--stream", "--flush-ms", "150", "-o", "-", "--format", "ndjson"],
    {
      inputChunks: [
        { text: "最初の文", afterMs: 0 },
        { text: "です。次", afterMs: 900 },
        { text: "の文", afterMs: 900 },
      ],
    },
  );
  assert.equal(flushed.code, 0, flushed.stderr);
  const sentences = allJson(flushed.stdout)
    .filter((event) => event["type"] === "sentence")
    .map((event) => String(event["text"]));
  assert.deepEqual(sentences.slice(0, 2), ["最初の文", "です。"]);
  assert.equal(sentences.slice(2).join(""), "次の文");
  const waited = await runCli(["speak", "--input", "-", "--stream", "-o", "-", "--format", "ndjson"], {
    inputChunks: [
      { text: "最初の文", afterMs: 0 },
      { text: "です。次", afterMs: 300 },
      { text: "の文", afterMs: 300 },
    ],
  });
  assert.equal(waited.code, 0, waited.stderr);
  assert.deepEqual(
    allJson(waited.stdout)
      .filter((event) => event["type"] === "sentence")
      .map((event) => event["text"]),
    ["最初の文です。", "次の文"],
  );
  const badFlush = await runCli(["speak", "--text", "あ", "--stream", "--flush-ms", "0", "-o", "-", "--format", "pcm"]);
  assert.equal(badFlush.code, 2);
  assert.equal(pick(lastJson(badFlush.stderr), "error", "path"), "$flags.flush-ms");
});

test("JSON requests on stdin accept the same flags as --text, and sing without notes explains itself", async () => {
  const request = { kind: "speech", text: "kongyoroidを使う" };
  const validated = await runCli(
    ["validate", "--input", "-", "--dict-entry", "kongyoroid=コンギョロイド:0", "--voice", "male"],
    {
      input: JSON.stringify(request),
    },
  );
  assert.equal(validated.code, 0, validated.stderr);
  assert.equal(pick(lastJson(validated.stdout), "reading", "kana"), "コンギョロイドヲ/_ツカウ。");
  assert.equal(pick(lastJson(validated.stdout), "request", "voice"), "male");
  const planned = await runCli(["plan", "--input", "-", "--kana", "ア'"], { input: JSON.stringify(request) });
  assert.equal(planned.code, 0, planned.stderr);
  assert.equal(pick(lastJson(planned.stdout), "plan", "reading", "kana"), "ア'。");
  const spoken = await runCli(["speak", "--input", "-", "-o", join(workdir, "speak-json.wav"), "--speed", "1.2"], {
    input: JSON.stringify({ kind: "speech", text: "あ", voice: "male" }),
  });
  assert.equal(spoken.code, 0, spoken.stderr);
  assert.equal(lastJson(spoken.stdout)["voice"], "male");
  const wrongKind = await runCli(["speak", "--input", "-", "-o", join(workdir, "speak-song.wav")], {
    input: JSON.stringify({ kind: "song", notes: { lyrics: "あ", melody: "C4" } }),
  });
  assert.equal(wrongKind.code, 2);
  assert.equal(pick(lastJson(wrongKind.stderr), "error", "path"), "$.kind");
  const both = await runCli(["validate", "--text", "あ", "--input", "-"], { input: "い" });
  assert.equal(both.code, 2);
  const kanaOnly = await runCli(["speak", "--kana", "コンニチワ'", "-o", join(workdir, "kana-only.wav")]);
  assert.equal(kanaOnly.code, 0, kanaOnly.stderr);
  assert.equal(lastJson(kanaOnly.stdout)["kana"], "コンニチワ'。");
  const noNotes = await runCli(["sing", "-o", join(workdir, "no-notes.wav")]);
  assert.equal(noNotes.code, 2);
  assert.equal(pick(lastJson(noNotes.stderr), "error", "path"), "$flags.melody");
  assert.ok(String(pick(lastJson(noNotes.stderr), "error", "hint")).includes("--mml"));
});

test("flags replace their exclusive counterpart in a JSON request, and vibrato flags merge into vibrato objects", async () => {
  const speech = JSON.stringify({ kind: "speech", text: "あ", volume: 0.5, pitch: 0.1 });
  const gain = await runCli(["validate", "--input", "-", "--gain-db=-6", "--pitch-semitones", "3"], { input: speech });
  assert.equal(gain.code, 0, gain.stderr);
  const resolved = record(lastJson(gain.stdout)["request"]);
  assert.ok(Math.abs(Number(resolved["volume"]) - 10 ** (-6 / 20)) < 1e-9);
  assert.equal(resolved["pitchSemitones"], 3);
  assert.equal(resolved["pitch"], undefined);
  const volume = await runCli(["validate", "--input", "-", "--volume", "2", "--pitch", "0.05"], {
    input: JSON.stringify({ kind: "speech", text: "あ", gainDb: -6, pitchSemitones: 2 }),
  });
  assert.equal(volume.code, 0, volume.stderr);
  assert.equal(pick(lastJson(volume.stdout), "request", "volume"), 2);
  assert.equal(pick(lastJson(volume.stdout), "request", "pitch"), 0.05);
  assert.equal(pick(lastJson(volume.stdout), "request", "pitchSemitones"), 0);
  const both = await runCli(["validate", "--text", "あ", "--volume", "1", "--gain-db", "0"]);
  assert.equal(both.code, 2);
  assert.equal(pick(lastJson(both.stderr), "error", "path"), "$flags.gain-db");
  const song = { kind: "song", notes: { lyrics: "あ", melody: "C4" } };
  const rate = await runCli(["sing", "--dry-run", "--input", "-", "--vibrato-rate", "4", "--gain-db=-3"], {
    input: JSON.stringify({ ...song, vibrato: { depthCents: 20, delayMs: 50 }, volume: 0.5 }),
  });
  assert.equal(rate.code, 0, rate.stderr);
  assert.equal(pick(lastJson(rate.stdout), "request", "vibratoDepth"), 20);
  assert.equal(pick(lastJson(rate.stdout), "request", "vibratoRate"), 4);
  assert.equal(pick(lastJson(rate.stdout), "request", "vibratoDelayMs"), 50);
  assert.ok(Math.abs(Number(pick(lastJson(rate.stdout), "request", "volume")) - 10 ** (-3 / 20)) < 1e-9);
  const fade = await runCli(["sing", "--dry-run", "--input", "-", "--vibrato-fade-ms", "100"], {
    input: JSON.stringify({ ...song, vibratoDepth: 10, vibratoRate: 6 }),
  });
  assert.equal(fade.code, 0, fade.stderr);
  assert.equal(pick(lastJson(fade.stdout), "request", "vibratoDepth"), 10);
  assert.equal(pick(lastJson(fade.stdout), "request", "vibratoRate"), 6);
  assert.equal(pick(lastJson(fade.stdout), "request", "vibratoFadeMs"), 100);
  const depth = await runCli(["sing", "--dry-run", "--input", "-", "--vibrato-depth", "0"], {
    input: JSON.stringify({ ...song, vibratoDepth: 10 }),
  });
  assert.equal(depth.code, 0, depth.stderr);
  assert.equal(pick(lastJson(depth.stdout), "request", "vibratoDepth"), 0);
});

test("--stream reads a request JSON from --input, rejects --kana, and treats unreadable text like batch mode", async () => {
  const request = { kind: "speech", text: "一つ目。二つ目。", voice: "male", speed: 0.5 };
  const stream = (args: readonly string[], input: string): Promise<CliResult> =>
    runCli(["speak", "--input", "-", "--stream", "-o", "-", "--format", "ndjson", ...args], { input });
  const slow = await stream([], JSON.stringify(request));
  assert.equal(slow.code, 0, slow.stderr);
  const texts = (result: CliResult): unknown[] =>
    allJson(result.stdout)
      .filter((event) => event["type"] === "sentence")
      .map((event) => String(event["text"]).trim());
  assert.deepEqual(texts(slow), ["一つ目。", "二つ目。"]);
  const fast = await stream(["--speed", "2"], JSON.stringify(request));
  assert.equal(fast.code, 0, fast.stderr);
  assert.deepEqual(texts(fast), ["一つ目。", "二つ目。"]);
  assert.ok(Number(lastJson(fast.stdout)["durationSeconds"]) < Number(lastJson(slow.stdout)["durationSeconds"]) / 2);
  const song = await stream([], JSON.stringify({ kind: "song", notes: { lyrics: "あ", melody: "C4" } }));
  assert.equal(song.code, 2);
  assert.equal(pick(lastJson(song.stderr), "error", "path"), "$.kind");
  const noText = await stream([], JSON.stringify({ kind: "speech", voice: "male" }));
  assert.equal(noText.code, 2);
  assert.equal(pick(lastJson(noText.stderr), "error", "path"), "$.text");
  const kana = await runCli(["speak", "--text", "あ", "--kana", "ア'", "--stream", "-o", "-", "--format", "pcm"]);
  assert.equal(kana.code, 2);
  assert.equal(pick(lastJson(kana.stderr), "error", "path"), "$flags.kana");
  const unreadable = await runCli(["speak", "--input", "-", "--stream", "-o", "-", "--format", "wav"], {
    input: "🎉🎉🎉\n",
  });
  assert.equal(unreadable.code, 2);
  assert.equal(pick(lastJson(unreadable.stderr), "error", "path"), "$.text");
  assert.equal(unreadable.stdoutBytes.length, 0);
  const mixed = await stream([], "完了。\n🎉🎉🎉\n次。\n");
  assert.equal(mixed.code, 0, mixed.stderr);
  assert.deepEqual(texts(mixed), ["完了。", "次。"]);
  assert.equal(lastJson(mixed.stdout)["sentences"], 2);
});

test("cache prune needs a limit, and --dry-run reports what would be removed", async () => {
  const cacheDir = join(workdir, "prune-cache");
  for (const text of ["いち", "に", "さん"]) {
    const spoken = await runCli(["speak", "--text", text, "--cache-dir", cacheDir, "-o", "-"]);
    assert.equal(spoken.code, 0, spoken.stderr);
  }
  const noLimit = await runCli(["cache", "prune", "--cache-dir", cacheDir]);
  assert.equal(noLimit.code, 2);
  assert.equal(pick(lastJson(noLimit.stderr), "error", "path"), "$flags.max-bytes");
  const dry = await runCli(["cache", "prune", "--cache-dir", cacheDir, "--max-entries", "1", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(lastJson(dry.stdout)["wouldRemove"], 2);
  assert.equal(lastJson(dry.stdout)["entries"], 3);
  const pruned = await runCli(["cache", "prune", "--cache-dir", cacheDir, "--max-entries", "1"]);
  assert.equal(lastJson(pruned.stdout)["removed"], 2);
  assert.equal(lastJson(pruned.stdout)["entries"], 1);
});

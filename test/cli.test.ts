import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { COMMANDS } from "../src/cli/help.ts";
import { inspectWav } from "../src/wav.ts";
import { VERSION } from "../src/version.ts";
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
  const result = await runCli(["play", join(workdir, "missing.wav")], { env: { PATH: workdir } });
  assert.equal(result.code, 4);
  assert.equal(pick(lastJson(result.stderr), "error", "code"), "PLAYER_UNAVAILABLE");
});

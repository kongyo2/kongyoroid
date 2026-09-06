import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { inspectWav } from "../src/wav.ts";
import { VERSION } from "../src/version.ts";
import { allJson, lastJson, pick, runCli } from "./helpers/cli.ts";
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

test("--version, --help, schema, and capabilities are machine readable", async () => {
  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.deepEqual(lastJson(version.stdout), { ok: true, name: "@kongyo2/kongyoroid", version: VERSION });
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("Usage: kongyoroid"));
  const schema = await runCli(["schema"]);
  assert.equal(schema.code, 0);
  assert.equal(lastJson(schema.stdout)["title"], "kongyoroid RenderRequest");
  const batch = await runCli(["schema", "--kind", "batch"]);
  assert.equal(lastJson(batch.stdout)["title"], "kongyoroid BatchJob");
  const capabilities = await runCli(["capabilities"]);
  assert.equal(lastJson(capabilities.stdout)["version"], VERSION);
});

test("bad flags, unknown commands, and missing text exit 2 with JSON on stderr", async () => {
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
  const noText = await runCli(["speak", "--engine", "formant"]);
  assert.equal(noText.code, 2);
  const badNumber = await runCli(["speak", "--engine", "formant", "--text", "あ", "--speed", "fast"]);
  assert.equal(badNumber.code, 2);
  assert.equal(pick(lastJson(badNumber.stderr), "error", "path"), "$flags.speed");
});

test("speak writes a WAV with the formant engine and refuses to overwrite without --force", async () => {
  const output = join(workdir, "speak.wav");
  const result = await runCli(["speak", "--engine", "formant", "--text", "こんにちは", "--output", output]);
  assert.equal(result.code, 0, result.stderr);
  const json = lastJson(result.stdout);
  assert.equal(json["ok"], true);
  assert.equal(json["path"], output);
  assert.equal(json["engine"], "formant");
  assert.equal(inspectWav(new Uint8Array(await readFile(output))).frames, json["frames"]);
  const refused = await runCli(["speak", "--engine", "formant", "--text", "こんにちは", "--output", output]);
  assert.equal(refused.code, 4);
  assert.equal(pick(lastJson(refused.stderr), "error", "code"), "IO_ERROR");
  const forced = await runCli(["speak", "--engine", "formant", "--text", "こんにちは", "--output", output, "--force"]);
  assert.equal(forced.code, 0);
  const defaultName = await runCli(["speak", "--engine", "formant", "-t", "あ"], { cwd: workdir });
  assert.equal(defaultName.code, 0);
  assert.match(String(lastJson(defaultName.stdout)["path"]), /kongyoroid-speech-[0-9a-f]{8}\.wav$/u);
});

test("--output - streams WAV bytes to stdout and JSON to stderr", async () => {
  const result = await runCli(["speak", "--engine", "formant", "--text", "あいう", "-o", "-"]);
  assert.equal(result.code, 0);
  const info = inspectWav(new Uint8Array(result.stdoutBytes));
  assert.equal(info.channels, 1);
  const json = lastJson(result.stderr);
  assert.equal(json["ok"], true);
  assert.equal(json["output"], "stdout");
  assert.equal(json["frames"], info.frames);
  const withPlay = await runCli(["speak", "--engine", "formant", "--text", "あ", "-o", "-", "--play"]);
  assert.equal(withPlay.code, 2);
});

test("render reads a request from stdin and text input from a file", async () => {
  const output = join(workdir, "render.wav");
  const request = { kind: "song", engine: "formant", notes: { lyrics: "ドレ", melody: "C4 D4" } };
  const result = await runCli(["render", "--input", "-", "--output", output], { input: JSON.stringify(request) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastJson(result.stdout)["kind"], "song");
  const invalid = await runCli(["render", "-i", "-", "-o", join(workdir, "x.wav")], { input: "{" });
  assert.equal(invalid.code, 2);
  const textFile = join(workdir, "input.txt");
  await writeFile(textFile, "ふぁいる から\n");
  const fromFile = await runCli(["speak", "--engine", "formant", "-i", textFile, "-o", join(workdir, "file.wav")]);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  const missing = await runCli([
    "speak",
    "--engine",
    "formant",
    "-i",
    join(workdir, "nope.txt"),
    "-o",
    join(workdir, "y.wav"),
  ]);
  assert.equal(missing.code, 4);
});

test("batch renders every line, reports failures per line, and exits with the worst code", async () => {
  const jobs = [
    { id: "one", request: { kind: "speech", engine: "formant", text: "いち" } },
    { id: "two", request: { kind: "speech", engine: "formant", text: "" } },
    { id: "one", request: { kind: "speech", engine: "formant", text: "さん" } },
    { id: "four", request: { kind: "song", engine: "formant", notes: { lyrics: "し", melody: "C4" } } },
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
});

test("voices, reading, doctor, sing, and dict work against an engine endpoint", async () => {
  const env = { KONGYOROID_ENDPOINT: engine.url };
  const voices = await runCli(["voices", "--kind", "song"], { env });
  assert.equal(voices.code, 0, voices.stderr);
  assert.equal(lastJson(voices.stdout)["count"], 3);
  const filtered = await runCli(["voices", "--query", "めたん"], { env });
  assert.equal(lastJson(filtered.stdout)["count"], 2);
  const reading = await runCli(["reading", "--text", "こんにちは", "--speaker", "四国めたん"], { env });
  assert.equal(reading.code, 0, reading.stderr);
  assert.equal(pick(lastJson(reading.stdout), "speaker", "id"), 2);
  assert.ok(String(lastJson(reading.stdout)["kana"]).includes("コ"));
  const doctor = await runCli(["doctor", "--speaker", "3", "--initialize"], { env });
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(lastJson(doctor.stdout)["ok"], true);
  assert.equal(pick(lastJson(doctor.stdout), "style", "initialized"), true);
  const down = await runCli(["doctor"], { env: { KONGYOROID_ENDPOINT: "http://127.0.0.1:1" } });
  assert.equal(down.code, 3);
  assert.equal(lastJson(down.stdout)["ok"], false);
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
  const sung = lastJson(sing.stdout);
  assert.equal(sung["engine"], "voicevox");
  assert.equal(pick(sung, "styles", "singer", "id"), 3001);
  const scoreFile = join(workdir, "score.json");
  await writeFile(scoreFile, JSON.stringify({ notes: { lyrics: "ラ", melody: "A4" }, tempo: 80 }));
  const fromFile = await runCli(["sing", "-i", scoreFile, "--transpose", "2", "-o", join(workdir, "sing2.wav")], {
    env,
  });
  assert.equal(fromFile.code, 0, fromFile.stderr);
  const envSpeaker = await runCli(["speak", "-t", "はい", "-o", join(workdir, "env.wav")], {
    env: { ...env, KONGYOROID_SPEAKER: "ずんだもん/ささやき" },
  });
  assert.equal(envSpeaker.code, 0, envSpeaker.stderr);
  assert.equal(pick(lastJson(envSpeaker.stdout), "styles", "speaker", "id"), 22);
  const add = await runCli(["dict", "add", "--surface", "金曜日", "--pronunciation", "キンヨウビ", "--accent", "3"], {
    env,
  });
  assert.equal(add.code, 0, add.stderr);
  const uuid = String(lastJson(add.stdout)["uuid"]);
  const list = await runCli(["dict", "list"], { env });
  const words = pick(lastJson(list.stdout), "words");
  assert.ok(Array.isArray(words) && words.length >= 1);
  const update = await runCli(
    ["dict", "update", uuid, "--surface", "金曜日", "--pronunciation", "キンヨービ", "--accent", "0"],
    { env },
  );
  assert.equal(update.code, 0, update.stderr);
  const remove = await runCli(["dict", "delete", uuid], { env });
  assert.equal(remove.code, 0, remove.stderr);
  const badAction = await runCli(["dict", "purge"], { env });
  assert.equal(badAction.code, 2);
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

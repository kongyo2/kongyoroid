#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { ErrorData } from "./errors.ts";
import { EXIT_CODES, KongyoroidError, asKongyoroidError, exitCodeOf, invalid } from "./errors.ts";
import { readLines, readText, writeAudio, writeStream } from "./io.ts";
import { LIMITS } from "./limits.ts";
import type { VoiceKind } from "./kongyoroid.ts";
import { Kongyoroid } from "./kongyoroid.ts";
import { playWav } from "./player.ts";
import { parseEngine, parseJson } from "./request.ts";
import { BATCH_JOB_SCHEMA, CAPABILITIES, REQUEST_SCHEMA } from "./schema.ts";
import type { RenderResult } from "./types.ts";
import type { JsonObject } from "./validate.ts";
import { isObject, keys, literal, object, string } from "./validate.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";
import type { DictionaryWordDraft } from "./voicevox/dictionary.ts";

const HELP: string = `kongyoroid ${VERSION} — Japanese speech and singing for LLM agents (built-in formant engine, optional VOICEVOX ENGINE)

Usage: kongyoroid <command> [flags]

  speak    --text "こんにちは" [--speaker ずんだもん] [-o out.wav]     Read text aloud
  sing     --lyrics "ドレミ" --melody "C4 D4 E4" [--beats "1 1 2"]      Sing a score
  render   --input request.json | -                                    Render a full JSON request (see: schema)
  batch    --input jobs.jsonl --output-dir out                          Many renders, one JSONL line per job
  reading  --text "..." [--speaker ...]                                  Show the engine's reading (kana notation)
  voices   [--kind speech|song|all] [--query 名前]                       List VOICEVOX styles (id, character, type)
  doctor   [--speaker ...] [--initialize]                                Check the engine, versions, style counts
  dict     list | add | update <uuid> | delete <uuid>                    Manage the VOICEVOX user dictionary
  play     <file.wav>                                                    Play a WAV with the system player
  schema   [--kind request|batch]                                        JSON Schema of the request format
  capabilities                                                           Machine-readable feature descriptor

Common flags
  --engine formant|voicevox|auto   (default formant; a speaker/singer/teacher selects voicevox)
  --endpoint URL   --timeout-ms N   --retries N   --cache-dir DIR
  -o, --output FILE|-   (default: kongyoroid-<kind>-<hash>.wav; "-" streams WAV to stdout, JSON to stderr)
  --force               replace an existing output file        --play    play the result after writing

speak flags: -t/--text, -i/--input FILE|- (text), --kana NOTATION, --speaker ID|NAME, --speed, --pitch,
  --intonation, --volume, --pre-pause, --post-pause, --pause-length, --pause-scale, --no-upspeak,
  --split sentence|paragraph|none, --sample-rate, --seed
sing flags: --lyrics, --melody, --beats, --tempo, --singer, --teacher, --transpose, --volume, --vibrato-depth,
  --vibrato-rate, --lead-in, --lead-out, --sample-rate, --seed, -i/--input FILE|- (song JSON; flags override)
dict flags: --surface, --pronunciation, --accent N, --word-type PROPER_NOUN|COMMON_NOUN|VERB|ADJECTIVE|SUFFIX, --priority 0-10

Environment: KONGYOROID_ENDPOINT (or VOICEVOX_URL), KONGYOROID_ENGINE, KONGYOROID_SPEAKER, KONGYOROID_SINGER,
  KONGYOROID_TEACHER, KONGYOROID_CACHE_DIR
Output: one JSON object per line on stdout ({ "ok": true, ... }); errors on stderr ({ "ok": false, "error": {...} }).
Exit codes: 0 ok, 1 internal, 2 input, 3 engine, 4 io, 130 cancelled.
`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  text: { type: "string", short: "t" },
  input: { type: "string", short: "i" },
  output: { type: "string", short: "o" },
  "output-dir": { type: "string" },
  force: { type: "boolean" },
  play: { type: "boolean" },
  engine: { type: "string" },
  endpoint: { type: "string" },
  "timeout-ms": { type: "string" },
  retries: { type: "string" },
  concurrency: { type: "string" },
  "cache-dir": { type: "string" },
  kana: { type: "string" },
  speaker: { type: "string" },
  speed: { type: "string" },
  pitch: { type: "string" },
  intonation: { type: "string" },
  volume: { type: "string" },
  "pre-pause": { type: "string" },
  "post-pause": { type: "string" },
  "pause-length": { type: "string" },
  "pause-scale": { type: "string" },
  upspeak: { type: "boolean" },
  split: { type: "string" },
  "sample-rate": { type: "string" },
  seed: { type: "string" },
  lyrics: { type: "string" },
  melody: { type: "string" },
  beats: { type: "string" },
  tempo: { type: "string" },
  singer: { type: "string" },
  teacher: { type: "string" },
  transpose: { type: "string" },
  "vibrato-depth": { type: "string" },
  "vibrato-rate": { type: "string" },
  "lead-in": { type: "string" },
  "lead-out": { type: "string" },
  kind: { type: "string" },
  query: { type: "string" },
  initialize: { type: "boolean" },
  surface: { type: "string" },
  pronunciation: { type: "string" },
  accent: { type: "string" },
  "word-type": { type: "string" },
  priority: { type: "string" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

const NETWORK = ["endpoint", "timeout-ms", "retries", "engine"];
const OUTPUT = ["output", "force", "play", "cache-dir", "concurrency"];
const SPEECH = [
  "text",
  "input",
  "kana",
  "speaker",
  "speed",
  "pitch",
  "intonation",
  "volume",
  "pre-pause",
  "post-pause",
  "pause-length",
  "pause-scale",
  "upspeak",
  "split",
  "sample-rate",
  "seed",
];
const SONG = [
  "input",
  "lyrics",
  "melody",
  "beats",
  "tempo",
  "singer",
  "teacher",
  "transpose",
  "volume",
  "vibrato-depth",
  "vibrato-rate",
  "lead-in",
  "lead-out",
  "sample-rate",
  "seed",
];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  speak: [...NETWORK, ...OUTPUT, ...SPEECH],
  sing: [...NETWORK, ...OUTPUT, ...SONG],
  render: [...NETWORK, ...OUTPUT, "input"],
  batch: [...NETWORK, "input", "output-dir", "force", "concurrency", "cache-dir"],
  reading: [...NETWORK, "text", "input", "kana", "speaker"],
  voices: [...NETWORK, "kind", "query"],
  doctor: [...NETWORK, "speaker", "initialize"],
  dict: [...NETWORK, "surface", "pronunciation", "accent", "word-type", "priority"],
  play: [],
  schema: ["kind"],
  capabilities: [],
};

async function emit(value: unknown, error: boolean = false): Promise<void> {
  await writeStream(error ? process.stderr : process.stdout, `${JSON.stringify(value)}\n`);
}

function numberFlag(values: Values, name: keyof Values): number | undefined {
  const raw = values[name];
  if (raw === undefined || typeof raw !== "string") return undefined;
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value))
    invalid(`$flags.${name}`, `Expected a number, got ${JSON.stringify(raw)}.`);
  return value;
}

function styleFlag(values: Values, name: "speaker" | "singer" | "teacher"): string | number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  return /^\d+$/u.test(raw.trim()) ? Number(raw) : raw;
}

function assign(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

function metadata(result: RenderResult): JsonObject {
  return {
    engine: result.engine,
    kind: result.kind,
    styles: result.styles,
    ...(result.kana === undefined ? {} : { kana: result.kana }),
    chunks: result.chunks,
    cached: result.cached,
    sha256: result.sha256,
    bytes: result.audio.length,
    sampleRate: result.info.sampleRate,
    channels: result.info.channels,
    frames: result.info.frames,
    durationSeconds: Math.round(result.info.durationSeconds * 1000) / 1000,
    elapsedMs: result.elapsedMs,
  };
}

async function deliver(result: RenderResult, values: Values, signal: AbortSignal): Promise<JsonObject> {
  if (values.output === "-") {
    if (values.play) invalid("$flags.play", "--play cannot be combined with --output -.");
    await writeStream(process.stdout, result.audio);
    return { ok: true, output: "stdout", ...metadata(result) };
  }
  const path = values.output ?? `kongyoroid-${result.kind}-${result.sha256.slice(0, 8)}.wav`;
  const written = await writeAudio(path, result.audio, values.force ?? false, signal);
  const played = values.play ? await playWav(written, signal) : undefined;
  return { ok: true, path: written, ...metadata(result), ...(played === undefined ? {} : { player: played.player }) };
}

function speechRequestFromFlags(values: Values, text: string): JsonObject {
  const request: JsonObject = { kind: "speech", text };
  assign(request, "engine", values.engine);
  assign(request, "kana", values.kana);
  assign(request, "speaker", styleFlag(values, "speaker"));
  assign(request, "speed", numberFlag(values, "speed"));
  assign(request, "pitch", numberFlag(values, "pitch"));
  assign(request, "intonation", numberFlag(values, "intonation"));
  assign(request, "volume", numberFlag(values, "volume"));
  assign(request, "prePause", numberFlag(values, "pre-pause"));
  assign(request, "postPause", numberFlag(values, "post-pause"));
  assign(request, "pauseLength", numberFlag(values, "pause-length"));
  assign(request, "pauseScale", numberFlag(values, "pause-scale"));
  assign(request, "upspeak", values.upspeak);
  assign(request, "split", values.split);
  assign(request, "sampleRate", numberFlag(values, "sample-rate"));
  assign(request, "seed", numberFlag(values, "seed"));
  return request;
}

function songRequestFromFlags(values: Values, base: JsonObject): JsonObject {
  const request: JsonObject = { ...base, kind: "song" };
  if (values.lyrics !== undefined || values.melody !== undefined) {
    const notes: JsonObject = { lyrics: values.lyrics ?? "", melody: values.melody ?? "" };
    assign(notes, "beats", values.beats);
    request["notes"] = notes;
  } else if (values.beats !== undefined) {
    invalid("$flags.beats", "--beats needs --melody.");
  }
  assign(request, "engine", values.engine);
  assign(request, "tempo", numberFlag(values, "tempo"));
  assign(request, "singer", styleFlag(values, "singer"));
  assign(request, "teacher", styleFlag(values, "teacher"));
  assign(request, "transpose", numberFlag(values, "transpose"));
  assign(request, "volume", numberFlag(values, "volume"));
  assign(request, "vibratoDepth", numberFlag(values, "vibrato-depth"));
  assign(request, "vibratoRate", numberFlag(values, "vibrato-rate"));
  assign(request, "leadIn", numberFlag(values, "lead-in"));
  assign(request, "leadOut", numberFlag(values, "lead-out"));
  assign(request, "sampleRate", numberFlag(values, "sample-rate"));
  assign(request, "seed", numberFlag(values, "seed"));
  return request;
}

async function textInput(values: Values, signal: AbortSignal): Promise<string> {
  if (values.text !== undefined && values.input !== undefined)
    invalid("$flags", "Use either --text or --input, not both.");
  if (values.text !== undefined) return values.text;
  if (values.input !== undefined) return (await readText(values.input, signal)).replace(/\r?\n$/u, "");
  return invalid("$flags.text", "Provide --text or --input FILE (use - for standard input).");
}

function createAgent(values: Values): Kongyoroid {
  const engineFlag = values.engine ?? env("KONGYOROID_ENGINE");
  const concurrency = numberFlag(values, "concurrency");
  const timeoutMs = numberFlag(values, "timeout-ms");
  const retries = numberFlag(values, "retries");
  const cacheDir = values["cache-dir"] ?? env("KONGYOROID_CACHE_DIR");
  const speaker = env("KONGYOROID_SPEAKER");
  const singer = env("KONGYOROID_SINGER");
  const teacher = env("KONGYOROID_TEACHER");
  return new Kongyoroid({
    endpoint: values.endpoint ?? env("KONGYOROID_ENDPOINT") ?? env("VOICEVOX_URL") ?? "http://127.0.0.1:50021",
    ...(engineFlag === undefined ? {} : { engine: parseEngine(engineFlag, "$flags.engine") }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(retries === undefined ? {} : { retries }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(cacheDir === undefined ? {} : { cacheDir }),
    ...(speaker === undefined ? {} : { speaker }),
    ...(singer === undefined ? {} : { singer }),
    ...(teacher === undefined ? {} : { teacher }),
  });
}

async function runBatch(agent: Kongyoroid, values: Values, signal: AbortSignal, onFailure: () => void): Promise<void> {
  const input = string(values.input, "$flags.input", 1, 4096);
  const directory = string(values["output-dir"], "$flags.output-dir", 1, 4096);
  const concurrency = numberFlag(values, "concurrency") ?? 2;
  const active = new Set<Promise<void>>();
  const ids = new Set<string>();
  let line = 0;
  const run = async (text: string, index: number): Promise<void> => {
    let id: string | null = null;
    try {
      const job = object(parseJson(text, `$line[${index}]`), `$line[${index}]`);
      keys(job, ["id", "request"], `$line[${index}]`);
      id = string(job["id"], `$line[${index}].id`, 1, 64);
      if (!/^[A-Za-z0-9_-]+$/u.test(id)) invalid(`$line[${index}].id`, "Use 1–64 ASCII letters, digits, _ or -.");
      if (ids.has(id.toLowerCase())) invalid(`$line[${index}].id`, "Duplicate job id (case-insensitive).");
      ids.add(id.toLowerCase());
      const result = await agent.render(job["request"], { signal });
      const path = await writeAudio(resolve(directory, `${id}.wav`), result.audio, values.force ?? false, signal);
      await emit({ ok: true, id, line: index, path, ...metadata(result) });
    } catch (error) {
      const failure = asKongyoroidError(error);
      onFailure();
      process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCodeOf(failure));
      await emit({ ok: false, id, line: index, error: failure.toJSON() });
      if (failure.code === "ABORTED") throw failure;
    }
  };
  try {
    for await (const text of readLines(input, signal)) {
      line += 1;
      if (line > LIMITS.batchLines) invalid("$flags.input", `A batch is limited to ${LIMITS.batchLines} lines.`);
      const task = run(text, line).finally(() => {
        active.delete(task);
      });
      active.add(task);
      if (active.size >= Math.max(1, Math.min(concurrency, LIMITS.concurrency))) await Promise.race(active);
    }
  } finally {
    await Promise.allSettled(active);
  }
}

async function runDict(
  agent: Kongyoroid,
  values: Values,
  positionals: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const action = literal(positionals[1], "$.dict", ["list", "add", "update", "delete"]);
  if (action === "list") {
    await emit({ ok: true, words: await agent.dictionary.list({ signal }) });
    return;
  }
  if (action === "delete") {
    const uuid = string(positionals[2], "$.dict.uuid", 1, 200);
    await agent.dictionary.remove(uuid, { signal });
    await emit({ ok: true, deleted: uuid });
    return;
  }
  const priority = numberFlag(values, "priority");
  const draft: DictionaryWordDraft = {
    surface: string(values.surface, "$flags.surface", 1, 200),
    pronunciation: string(values.pronunciation, "$flags.pronunciation", 1, 200),
    accentType: numberFlag(values, "accent") ?? invalid("$flags.accent", "Provide --accent N (0 = flat)."),
    ...(values["word-type"] === undefined ? {} : { wordType: values["word-type"] }),
    ...(priority === undefined ? {} : { priority }),
  };
  if (action === "add") {
    const uuid = await agent.dictionary.add(draft, { signal });
    await emit({ ok: true, uuid, word: draft });
    return;
  }
  const uuid = string(positionals[2], "$.dict.uuid", 1, 200);
  await agent.dictionary.update(uuid, draft, { signal });
  await emit({ ok: true, updated: uuid, word: draft });
}

async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });
  if (values.help) {
    await writeStream(process.stdout, HELP);
    return;
  }
  if (values.version) {
    await emit({ ok: true, name: PACKAGE_NAME, version: VERSION });
    return;
  }
  const command = positionals[0];
  if (command === undefined || !Object.hasOwn(ALLOWED, command)) {
    invalid(
      "$.command",
      `Unknown command ${JSON.stringify(command ?? "")}.`,
      "Run kongyoroid --help for the command list.",
    );
  }
  const allowed = ALLOWED[command] ?? [];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key))
      invalid(`$flags.${key}`, `--${key} is not accepted by ${command}.`, `Accepted: ${allowed.join(", ")}.`);
  }
  if (command === "schema") {
    await emit(
      literal(values.kind ?? "request", "$flags.kind", ["request", "batch"]) === "batch"
        ? BATCH_JOB_SCHEMA
        : REQUEST_SCHEMA,
    );
    return;
  }
  if (command === "capabilities") {
    await emit(CAPABILITIES);
    return;
  }
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const signal = controller.signal;
  try {
    if (command === "play") {
      const path = string(positionals[1], "$.play.file", 1, 4096);
      await emit({ ok: true, path: resolve(path), ...(await playWav(resolve(path), signal)) });
      return;
    }
    const agent = createAgent(values);
    switch (command) {
      case "speak": {
        const result = await agent.render(speechRequestFromFlags(values, await textInput(values, signal)), { signal });
        await emit(await deliver(result, values, signal), values.output === "-");
        return;
      }
      case "sing": {
        const base = values.input === undefined ? {} : object(parseJson(await readText(values.input, signal)), "$");
        if (base["kind"] !== undefined && base["kind"] !== "song")
          invalid("$.kind", "sing accepts only song requests.");
        const result = await agent.render(songRequestFromFlags(values, base), { signal });
        await emit(await deliver(result, values, signal), values.output === "-");
        return;
      }
      case "render": {
        const input = string(values.input, "$flags.input", 1, 4096);
        const request = parseJson(await readText(input, signal));
        const withEngine =
          isObject(request) && values.engine !== undefined ? { ...request, engine: values.engine } : request;
        const result = await agent.render(withEngine, { signal });
        await emit(await deliver(result, values, signal), values.output === "-");
        return;
      }
      case "batch": {
        let failures = 0;
        await runBatch(agent, values, signal, () => {
          failures += 1;
        });
        if (failures === 0) process.exitCode = EXIT_CODES.success;
        return;
      }
      case "reading": {
        const text = await textInput(values, signal);
        const speakerRef = styleFlag(values, "speaker");
        const reading = await agent.reading(text, {
          signal,
          ...(values.kana === undefined ? {} : { kana: values.kana }),
          ...(speakerRef === undefined ? {} : { speaker: speakerRef }),
        });
        await emit({ ok: true, text, ...reading });
        return;
      }
      case "voices": {
        const kind: VoiceKind = literal(values.kind ?? "all", "$flags.kind", ["speech", "song", "all"]);
        const query = values.query?.normalize("NFKC").toLowerCase();
        const styles = (await agent.voices(kind, { signal })).filter(
          (style) =>
            query === undefined || `${style.character}/${style.name}`.normalize("NFKC").toLowerCase().includes(query),
        );
        await emit({ ok: true, kind, count: styles.length, styles });
        return;
      }
      case "doctor": {
        const diagnosis = await agent.doctor({ signal });
        const speakerRef = styleFlag(values, "speaker");
        let style: JsonObject | undefined;
        if (diagnosis.ok && speakerRef !== undefined) {
          const all = await agent.styles.all({ signal });
          const selected = all.find(
            (s) => s.id === speakerRef || `${s.character}/${s.name}` === speakerRef || s.character === speakerRef,
          );
          if (selected === undefined) invalid("$flags.speaker", `No style matches ${JSON.stringify(speakerRef)}.`);
          if (values.initialize) await agent.client.initializeSpeaker(selected.id, true, { signal });
          style = { ...selected, initialized: await agent.client.isInitializedSpeaker(selected.id, { signal }) };
        }
        await emit({ ...diagnosis, formant: { available: true }, ...(style === undefined ? {} : { style }) });
        if (!diagnosis.ok) process.exitCode = EXIT_CODES.engine;
        return;
      }
      case "dict":
        await runDict(agent, values, positionals, signal);
        return;
      default:
        invalid("$.command", `Unknown command ${JSON.stringify(command)}.`);
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

function isArgumentError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const data: ErrorData = isArgumentError(error)
    ? {
        code: "INVALID_INPUT",
        message: error.message,
        path: "$flags",
        retryable: false,
        hint: "Run kongyoroid --help.",
      }
    : asKongyoroidError(error).toJSON();
  process.exitCode = exitCodeOf(new KongyoroidError(data));
  await emit({ ok: false, error: data }, true);
}

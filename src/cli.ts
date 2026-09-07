#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import { commandHelp, rootHelp } from "./cli/help.ts";
import type { Values } from "./cli/flags.ts";
import {
  ALLOWED,
  assign,
  checkAllowed,
  env,
  numberFlag,
  parseCommandLine,
  parseDictEntries,
  styleFlag,
} from "./cli/flags.ts";
import { DiskCache } from "./cache.ts";
import type { Diagnostic, ErrorData } from "./errors.ts";
import { EXIT_CODES, KongyoroidError, asKongyoroidError, exitCodeOf, formatDiagnostic, invalid } from "./errors.ts";
import {
  existingFileSha256,
  readBytes,
  readChunks,
  readLines,
  readText,
  writeAudioIdempotent,
  writeStream,
  writeTextFile,
  writeWithBackpressure,
} from "./io.ts";
import { LIMITS } from "./limits.ts";
import type { KongyoroidOptions, VoiceKind } from "./kongyoroid.ts";
import { Kongyoroid } from "./kongyoroid.ts";
import { playWav } from "./player.ts";
import { parseEngine, parseJson } from "./request.ts";
import { BATCH_JOB_SCHEMA, CAPABILITIES, DICTIONARY_SCHEMA, REQUEST_SCHEMA } from "./schema.ts";
import type { PlanDetail } from "./synth/engine.ts";
import { pcm16Bytes, streamingWavHeader } from "./synth/stream.ts";
import { LocalDictionary } from "./text/dictionary.ts";
import type { RenderResult } from "./types.ts";
import type { JsonObject } from "./validate.ts";
import { isObject, keys, literal, object, string } from "./validate.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";
import type { DictionaryWordDraft } from "./voicevox/dictionary.ts";
import { wavHeader } from "./wav.ts";

async function emit(value: unknown, error: boolean = false): Promise<void> {
  await writeStream(error ? process.stderr : process.stdout, `${JSON.stringify(value)}\n`);
}

function metadata(result: RenderResult): JsonObject {
  return {
    engine: result.engine,
    engineVersion: result.engineVersion,
    kind: result.kind,
    ...(result.voice === undefined ? {} : { voice: result.voice }),
    styles: result.styles,
    ...(result.kana === undefined ? {} : { kana: result.kana }),
    chunks: result.chunks,
    cached: result.cached,
    sha256: result.sha256,
    requestHash: result.requestHash,
    bytes: result.audio.length,
    sampleRate: result.info.sampleRate,
    channels: result.info.channels,
    frames: result.info.frames,
    durationSeconds: Math.round(result.info.durationSeconds * 1000) / 1000,
    ...(result.peak === undefined ? {} : { peak: result.peak, rms: result.rms, limitedSamples: result.limitedSamples }),
    elapsedMs: result.elapsedMs,
    timings: result.timings,
    warnings: result.warnings,
    adjustments: result.adjustments,
  };
}

async function reportDiagnostics(values: Values, warnings: readonly Diagnostic[], location: string): Promise<void> {
  if (values.diagnostics !== "compact") return;
  for (const warning of warnings) await writeStream(process.stderr, `${formatDiagnostic(warning, location)}\n`);
}

async function deliver(
  agent: Kongyoroid,
  result: RenderResult,
  values: Values,
  signal: AbortSignal,
  plan: unknown,
): Promise<JsonObject> {
  if (values["plan-out"] !== undefined && values["plan-out"] !== "-") {
    await writeTextFile(
      values["plan-out"],
      `${JSON.stringify(plan ?? (await agent.plan(result.requestHash)), null, 2)}\n`,
      values.force ?? false,
    );
  }
  await reportDiagnostics(values, result.warnings, values.input ?? "<request>");
  if (values.output === "-") {
    if (values.play)
      invalid("$flags.play", "--play cannot be combined with --output -.", {
        hint: "Write to a file and play it: -o out.wav --play",
      });
    await writeStream(process.stdout, result.audio);
    return {
      ok: true,
      output: "stdout",
      ...metadata(result),
      ...(plan === undefined || values["plan-out"] !== "-" ? {} : { plan }),
    };
  }
  const path = values.output ?? `kongyoroid-${result.kind}-${result.sha256.slice(0, 12)}.wav`;
  const written = await writeAudioIdempotent(path, result.audio, values.force ?? false, signal);
  const played = values.play ? await playWav(written.path, signal) : undefined;
  return {
    ok: true,
    path: written.path,
    written: written.written,
    unchanged: written.unchanged,
    ...metadata(result),
    ...(played === undefined ? {} : { player: played.player }),
    ...(plan === undefined || values["plan-out"] !== "-" ? {} : { plan }),
  };
}

function speechRequestFromFlags(values: Values, text: string): JsonObject {
  const request: JsonObject = { kind: "speech", text };
  assign(request, "engine", values.engine);
  assign(request, "voice", values.voice);
  assign(request, "kana", values.kana);
  const entries = parseDictEntries(values);
  if (entries.length > 0) request["dictionary"] = entries;
  if (values["strict-reading"] === false) request["strictReading"] = false;
  assign(request, "speaker", styleFlag(values, "speaker"));
  assign(request, "speed", numberFlag(values, "speed"));
  assign(request, "pitch", numberFlag(values, "pitch"));
  assign(request, "pitchSemitones", numberFlag(values, "pitch-semitones"));
  assign(request, "intonation", numberFlag(values, "intonation"));
  assign(request, "volume", numberFlag(values, "volume"));
  assign(request, "gainDb", numberFlag(values, "gain-db"));
  assign(request, "breathiness", numberFlag(values, "breathiness"));
  assign(request, "prePause", numberFlag(values, "pre-pause"));
  assign(request, "postPause", numberFlag(values, "post-pause"));
  assign(request, "pauseLength", numberFlag(values, "pause-length"));
  assign(request, "pauseScale", numberFlag(values, "pause-scale"));
  if (values.upspeak !== undefined) request["upspeak"] = values.upspeak;
  assign(request, "split", values.split);
  assign(request, "sampleRate", numberFlag(values, "sample-rate"));
  assign(request, "seed", numberFlag(values, "seed"));
  return request;
}

function songRequestFromFlags(values: Values, base: JsonObject): JsonObject {
  const request: JsonObject = { ...base, kind: "song" };
  if (values.mml !== undefined) {
    if (values.melody !== undefined || values.beats !== undefined)
      invalid("$flags.mml", "--mml cannot be combined with --melody or --beats.");
    request["notes"] = { mml: values.mml, ...(values.lyrics === undefined ? {} : { lyrics: values.lyrics }) };
  } else if (values.lyrics !== undefined || values.melody !== undefined) {
    if (values.melody === undefined)
      invalid("$flags.melody", "--lyrics needs --melody (or use --mml).", {
        hint: 'Example: --lyrics "ドレミ" --melody "C4 D4 E4"',
      });
    const notes: JsonObject = { lyrics: values.lyrics ?? "", melody: values.melody };
    assign(notes, "beats", values.beats);
    request["notes"] = notes;
  } else if (values.beats !== undefined) {
    invalid("$flags.beats", "--beats needs --melody.", {
      hint: 'Example: --lyrics "ドレミ" --melody "C4 D4 E4" --beats "1 1 2"',
    });
  }
  assign(request, "engine", values.engine);
  assign(request, "voice", values.voice);
  assign(request, "tempo", numberFlag(values, "tempo"));
  assign(request, "singer", styleFlag(values, "singer"));
  assign(request, "teacher", styleFlag(values, "teacher"));
  assign(request, "transpose", numberFlag(values, "transpose"));
  assign(request, "volume", numberFlag(values, "volume"));
  assign(request, "gainDb", numberFlag(values, "gain-db"));
  assign(request, "breathiness", numberFlag(values, "breathiness"));
  assign(request, "vibratoDepth", numberFlag(values, "vibrato-depth"));
  assign(request, "vibratoRate", numberFlag(values, "vibrato-rate"));
  const delay = numberFlag(values, "vibrato-delay-ms");
  const fade = numberFlag(values, "vibrato-fade-ms");
  if (delay !== undefined || fade !== undefined) {
    const vibrato: JsonObject = {};
    assign(vibrato, "delayMs", delay);
    assign(vibrato, "fadeMs", fade);
    assign(vibrato, "depthCents", numberFlag(values, "vibrato-depth"));
    assign(vibrato, "rateHz", numberFlag(values, "vibrato-rate"));
    delete request["vibratoDepth"];
    delete request["vibratoRate"];
    request["vibrato"] = vibrato;
  }
  assign(request, "portamentoMs", numberFlag(values, "portamento-ms"));
  assign(request, "scoopCents", numberFlag(values, "scoop-cents"));
  assign(request, "scoopMs", numberFlag(values, "scoop-ms"));
  if (values["consonant-compression"] !== undefined) request["consonantCompression"] = values["consonant-compression"];
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
  return invalid("$flags.text", "Provide --text or --input FILE (use - for standard input).", {
    hint: 'Example: kongyoroid speak --text "こんにちは" -o hello.wav',
  });
}

async function requestFromInputs(values: Values, signal: AbortSignal, command: string): Promise<unknown> {
  const hasSpeech = values.text !== undefined || values.kana !== undefined;
  const hasSong = values.lyrics !== undefined || values.melody !== undefined || values.mml !== undefined;
  if (values.input !== undefined) {
    const raw = await readText(values.input, signal);
    const trimmed = raw.trim();
    if (hasSpeech && !hasSong && !trimmed.startsWith("{"))
      return speechRequestFromFlags(values, raw.replace(/\r?\n$/u, ""));
    const json = parseJson(raw);
    if (isObject(json) && json["kind"] === "song") return songRequestFromFlags(values, json);
    if (isObject(json) && values.engine !== undefined) return { ...json, engine: values.engine };
    return json;
  }
  if (hasSong) return songRequestFromFlags(values, {});
  if (hasSpeech || values.text !== undefined) return speechRequestFromFlags(values, await textInput(values, signal));
  return invalid(
    "$flags.input",
    `Provide --input FILE|- (a request JSON), --text, or --lyrics/--melody/--mml for ${command}.`,
    {
      hint: `Examples: kongyoroid ${command} --input request.json | kongyoroid ${command} --text "こんにちは"`,
    },
  );
}

async function loadDictionaryFile(
  path: string | undefined,
  tolerateMissing: boolean,
): Promise<LocalDictionary | undefined> {
  if (path === undefined) return undefined;
  try {
    return await LocalDictionary.load(path);
  } catch (error) {
    if (
      tolerateMissing &&
      error instanceof KongyoroidError &&
      error.code === "IO_ERROR" &&
      /ENOENT/u.test(error.message)
    )
      return undefined;
    throw error;
  }
}

async function createAgent(values: Values, tolerateMissingDictionary: boolean = false): Promise<Kongyoroid> {
  const engineFlag = values.engine ?? env("KONGYOROID_ENGINE");
  const concurrency = numberFlag(values, "concurrency");
  const timeoutMs = numberFlag(values, "timeout-ms");
  const retries = numberFlag(values, "retries");
  const cacheDir = values["cache-dir"] ?? env("KONGYOROID_CACHE_DIR");
  const voice = values.voice ?? env("KONGYOROID_VOICE");
  const speaker = env("KONGYOROID_SPEAKER");
  const singer = env("KONGYOROID_SINGER");
  const teacher = env("KONGYOROID_TEACHER");
  const dictionaryPath = values.dictionary ?? env("KONGYOROID_DICTIONARY");
  const dictionary = await loadDictionaryFile(dictionaryPath, tolerateMissingDictionary);
  const options: KongyoroidOptions = {
    endpoint: values.endpoint ?? env("KONGYOROID_ENDPOINT") ?? env("VOICEVOX_URL") ?? "http://127.0.0.1:50021",
    ...(engineFlag === undefined || engineFlag === "all" ? {} : { engine: parseEngine(engineFlag, "$flags.engine") }),
    ...(voice === undefined ? {} : { voice }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(retries === undefined ? {} : { retries }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(dictionary === undefined ? {} : { dictionary }),
    ...(speaker === undefined ? {} : { speaker }),
    ...(singer === undefined ? {} : { singer }),
    ...(teacher === undefined ? {} : { teacher }),
    cache: {
      ...(cacheDir === undefined ? {} : { directory: cacheDir }),
      ...(values.cache === false ? { enabled: false } : {}),
    },
  };
  return new Kongyoroid(options);
}

function planDetail(values: Values): PlanDetail {
  return literal(values.detail ?? "summary", "$flags.detail", ["summary", "phonemes", "acoustics"]);
}

async function runValidate(agent: Kongyoroid, values: Values, signal: AbortSignal): Promise<void> {
  const request = await requestFromInputs(values, signal, "validate");
  const result = await agent.validate(request, { signal });
  if (values.diagnostics === "compact") {
    for (const warning of result.warnings)
      await writeStream(process.stdout, `${formatDiagnostic(warning, values.input ?? "<request>")}\n`);
    if (result.warnings.length === 0)
      await emit({ ok: true, operation: "validate", renderable: result.renderable, requestHash: result.requestHash });
    return;
  }
  const { request: resolved, ...rest } = result;
  await emit({ ...rest, request: resolved });
}

async function runPlan(agent: Kongyoroid, values: Values, signal: AbortSignal): Promise<void> {
  const request = await requestFromInputs(values, signal, "plan");
  const result = await agent.plan(request, { signal, detail: planDetail(values) });
  await emit(result);
}

async function runSpeakStream(agent: Kongyoroid, values: Values, signal: AbortSignal): Promise<void> {
  if (values.play) invalid("$flags.play", "--play cannot be combined with --stream.");
  const format = literal(values.format ?? "wav", "$flags.format", ["wav", "pcm", "ndjson"]);
  const output = values.output ?? "-";
  if (output !== "-" && format !== "wav")
    invalid("$flags.format", "Streaming to a file writes WAV; use --output - for pcm or ndjson.");
  const input = speechRequestFromFlags(values, "placeholder");
  delete input["text"];
  const source: AsyncIterable<string> =
    values.text !== undefined
      ? (async function* (): AsyncGenerator<string, void, void> {
          yield values.text ?? "";
        })()
      : readChunks(values.input ?? "-", signal);
  const events = agent.speakStream(source, input, { signal });
  const stdout = process.stdout;
  let sampleRate = 0;
  let file: Awaited<ReturnType<typeof import("node:fs/promises").open>> | undefined;
  let fileFrames = 0;
  let fileBytes = 0;
  let filePath = "";
  const sentences: JsonObject[] = [];
  const openFile = async (): Promise<void> => {
    if (output === "-") return;
    const { open } = await import("node:fs/promises");
    filePath = resolve(output);
    if (!values.force) {
      const existing = await existingFileSha256(filePath);
      if (existing !== undefined)
        invalid("$flags.output", `Refusing to overwrite ${filePath}.`, {
          hint: "Pass --force or choose another path.",
          repairOptions: [{ action: "use-force", description: "Overwrite with --force." }],
        });
    }
    file = await open(filePath, "w", 0o644);
    await file.write(wavHeader(0, sampleRate));
    fileBytes = 44;
  };
  let headerWritten = false;
  try {
    for await (const event of events) {
      if (event.type === "sentence") {
        const line = {
          type: "sentence",
          index: event.index,
          text: event.text,
          kana: event.kana,
          durationSeconds: Math.round(event.durationSeconds * 1000) / 1000,
          startSeconds: sampleRate === 0 ? 0 : Math.round((event.startFrame / sampleRate) * 1000) / 1000,
          warnings: event.warnings,
        };
        sentences.push(line);
        if (format === "ndjson" && output === "-")
          await writeWithBackpressure(stdout, `${JSON.stringify(line)}\n`, signal);
        else if (values.progress) await emit(line, true);
        continue;
      }
      if (event.type === "audio") {
        const block = event.block;
        if (sampleRate === 0) {
          sampleRate = block.sampleRate;
          await openFile();
        }
        const bytes = pcm16Bytes(block.samples);
        if (file !== undefined) {
          await file.write(bytes);
          fileFrames += block.samples.length;
          fileBytes += bytes.length;
          continue;
        }
        if (format === "ndjson") {
          await writeWithBackpressure(
            stdout,
            `${JSON.stringify({ type: "audio", sequence: event.sequence, sentence: event.index, sampleRate, encoding: "s16le", channels: 1, frames: block.samples.length, startFrame: block.start, base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") })}\n`,
            signal,
          );
          continue;
        }
        if (format === "wav" && !headerWritten) {
          await writeWithBackpressure(stdout, streamingWavHeader(sampleRate), signal);
          headerWritten = true;
        }
        await writeWithBackpressure(stdout, bytes, signal);
        continue;
      }
      const summary = {
        ok: true,
        operation: "speak",
        stream: true,
        format,
        output: output === "-" ? "stdout" : filePath,
        sentences: event.sentences,
        frames: event.frames,
        durationSeconds: Math.round(event.durationSeconds * 1000) / 1000,
        sampleRate: sampleRate === 0 ? null : sampleRate,
        ...(values.progress || format === "ndjson" ? {} : { segments: sentences }),
      };
      if (format === "ndjson" && output === "-")
        await writeWithBackpressure(stdout, `${JSON.stringify({ type: "end", ...summary })}\n`, signal);
      else await emit(summary, output === "-");
    }
  } finally {
    if (file !== undefined) {
      const header = wavHeader(fileFrames, sampleRate);
      await file.write(header, 0, 44, 0);
      await file.close();
      void fileBytes;
    }
  }
}

async function runBatch(agent: Kongyoroid, values: Values, signal: AbortSignal, onFailure: () => void): Promise<void> {
  const input = string(values.input, "$flags.input", 1, 4096);
  const directory = string(values["output-dir"], "$flags.output-dir", 1, 4096);
  const concurrency = numberFlag(values, "concurrency") ?? 2;
  const active = new Set<Promise<void>>();
  const ids = new Set<string>();
  let line = 0;
  let stop = false;
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
      const written = await writeAudioIdempotent(
        resolve(directory, `${id}.wav`),
        result.audio,
        values.force ?? false,
        signal,
      );
      await emit({
        ok: true,
        id,
        line: index,
        path: written.path,
        written: written.written,
        unchanged: written.unchanged,
        ...metadata(result),
      });
    } catch (error) {
      const failure = asKongyoroidError(error);
      onFailure();
      if (values["stop-on-error"]) stop = true;
      process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCodeOf(failure));
      await emit({ ok: false, id, line: index, error: failure.toJSON() });
      if (failure.code === "ABORTED") throw failure;
    }
  };
  try {
    for await (const text of readLines(input, signal)) {
      if (stop) break;
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
  const action = literal(positionals[1], "$.dict", ["list", "add", "update", "delete", "check"]);
  const scope = literal(values.scope ?? "local", "$flags.scope", ["local", "voicevox"]);
  const reading = values.reading ?? values.pronunciation;
  if (scope === "voicevox") {
    if (action === "check") invalid("$flags.scope", "dict check is only available for the local dictionary.");
    if (action === "list") {
      await emit({ ok: true, operation: "dict.list", scope, words: await agent.voicevoxDictionary.list({ signal }) });
      return;
    }
    if (action === "delete") {
      const uuid = string(values.id ?? positionals[2], "$flags.id", 1, 200);
      if (values["dry-run"]) {
        await emit({ ok: true, operation: "dict.delete", scope, dryRun: true, uuid });
        return;
      }
      await agent.voicevoxDictionary.remove(uuid, { signal });
      await emit({ ok: true, operation: "dict.delete", scope, deleted: uuid });
      return;
    }
    const priority = numberFlag(values, "priority");
    const draft: DictionaryWordDraft = {
      surface: string(values.surface, "$flags.surface", 1, 200),
      pronunciation: string(reading, "$flags.reading", 1, 200),
      accentType: numberFlag(values, "accent") ?? invalid("$flags.accent", "Provide --accent N (0 = flat)."),
      ...(values["word-type"] === undefined ? {} : { wordType: values["word-type"] }),
      ...(priority === undefined ? {} : { priority }),
    };
    if (action === "add") {
      if (values["dry-run"]) {
        await emit({ ok: true, operation: "dict.add", scope, dryRun: true, word: draft });
        return;
      }
      const uuid = await agent.voicevoxDictionary.add(draft, { signal });
      await emit({ ok: true, operation: "dict.add", scope, uuid, word: draft });
      return;
    }
    const uuid = string(values.id ?? positionals[2], "$flags.id", 1, 200);
    await agent.voicevoxDictionary.update(uuid, draft, { signal });
    await emit({ ok: true, operation: "dict.update", scope, updated: uuid, word: draft });
    return;
  }
  const path = values.dictionary ?? env("KONGYOROID_DICTIONARY") ?? "kongyoroid-dictionary.json";
  const dictionary = (await loadDictionaryFile(path, true)) ?? new LocalDictionary();
  if (action === "list") {
    await emit({
      ok: true,
      operation: "dict.list",
      scope,
      path: resolve(path),
      entries: dictionary.list(),
      digest: dictionary.digest(),
    });
    return;
  }
  if (action === "check") {
    const text = await textInput(values, signal);
    const merged = agent.dictionary.merge(dictionary);
    const analysed = await agent.reading(text, { signal, dictionary: merged, engine: "formant", strict: false });
    await emit({
      ok: true,
      operation: "dict.check",
      scope,
      path: resolve(path),
      text,
      kana: analysed.kana,
      hits: analysed.dictionaryHits,
      phrases: analysed.phrases.map((p) => ({ text: p.text, accent: p.accent, accentSource: p.accentSource })),
      warnings: analysed.warnings,
    });
    return;
  }
  if (action === "delete") {
    const id = string(values.id ?? positionals[2], "$flags.id", 1, 100);
    const entry = dictionary.get(id);
    if (entry === undefined) {
      await emit({
        ok: true,
        operation: "dict.delete",
        scope,
        path: resolve(path),
        id,
        deleted: false,
        message: "No such entry: nothing to do.",
      });
      return;
    }
    if (values["dry-run"]) {
      await emit({ ok: true, operation: "dict.delete", scope, path: resolve(path), dryRun: true, entry });
      return;
    }
    dictionary.remove(id);
    await writeTextFile(path, `${JSON.stringify(dictionary.toJSON(), null, 2)}\n`, true);
    await emit({
      ok: true,
      operation: "dict.delete",
      scope,
      path: resolve(path),
      id,
      deleted: true,
      digest: dictionary.digest(),
    });
    return;
  }
  const surface = string(values.surface, "$flags.surface", 1, 200);
  const accent = numberFlag(values, "accent");
  const priority = numberFlag(values, "priority");
  const input = {
    ...(values.id === undefined ? {} : { id: values.id }),
    surface,
    reading: string(reading, "$flags.reading", 1, 200),
    ...(accent === undefined ? {} : { accent }),
    ...(values.match === undefined ? {} : { match: literal(values.match, "$flags.match", ["word", "anywhere"]) }),
    ...(priority === undefined ? {} : { priority }),
  };
  if (action === "update" && values.id === undefined)
    invalid("$flags.id", "dict update needs --id ENTRY_ID.", { hint: "List ids with: kongyoroid dict list" });
  if (action === "add" && values.id === undefined) {
    const existing = dictionary
      .find(surface)
      .find((entry) => entry.reading === input.reading && (accent === undefined || entry.accent === accent));
    if (existing !== undefined) {
      await emit({
        ok: true,
        operation: "dict.add",
        scope,
        path: resolve(path),
        entry: existing,
        created: false,
        unchanged: true,
      });
      return;
    }
  }
  if (values["dry-run"]) {
    await emit({ ok: true, operation: `dict.${action}`, scope, path: resolve(path), dryRun: true, entry: input });
    return;
  }
  const result = dictionary.upsert(input);
  await writeTextFile(path, `${JSON.stringify(dictionary.toJSON(), null, 2)}\n`, true);
  await emit({
    ok: true,
    operation: `dict.${action}`,
    scope,
    path: resolve(path),
    entry: result.entry,
    created: result.created,
    digest: dictionary.digest(),
  });
}

async function runCache(values: Values, positionals: readonly string[]): Promise<void> {
  const action = literal(positionals[1], "$.cache", ["stats", "prune", "clear"]);
  const directory = values["cache-dir"] ?? env("KONGYOROID_CACHE_DIR");
  if (directory === undefined)
    invalid("$flags.cache-dir", "Provide --cache-dir DIR (or set KONGYOROID_CACHE_DIR).", {
      hint: "Example: kongyoroid cache stats --cache-dir ./cache",
    });
  const cache = new DiskCache(directory);
  if (action === "stats") {
    await emit({ ok: true, operation: "cache.stats", ...(await cache.stats()) });
    return;
  }
  const before = await cache.stats();
  if (values["dry-run"]) {
    await emit({
      ok: true,
      operation: `cache.${action}`,
      dryRun: true,
      directory: cache.directory,
      wouldRemove: action === "clear" ? before.entries : null,
      ...before,
    });
    return;
  }
  const removed =
    action === "clear"
      ? await cache.clear()
      : await cache.prune(numberFlag(values, "max-bytes"), numberFlag(values, "max-entries"));
  await emit({ ok: true, operation: `cache.${action}`, directory: cache.directory, removed, ...(await cache.stats()) });
}

async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseCommandLine(argv);
  const command = positionals[0];
  if (values.version) {
    await emit({ ok: true, name: PACKAGE_NAME, version: VERSION });
    return;
  }
  if (command === "help") {
    await writeStream(process.stdout, positionals[1] === undefined ? rootHelp() : commandHelp(positionals[1]));
    return;
  }
  if (values.help || command === undefined) {
    if (command === undefined && !values.help) {
      await writeStream(process.stderr, rootHelp());
      process.exitCode = EXIT_CODES.input;
      return;
    }
    await writeStream(process.stdout, command === undefined ? rootHelp() : commandHelp(command));
    return;
  }
  if (!Object.hasOwn(ALLOWED, command)) {
    invalid("$.command", `Unknown command ${JSON.stringify(command)}.`, {
      hint: `Commands: ${Object.keys(ALLOWED)
        .filter((name) => name !== "help")
        .join(", ")}. Run kongyoroid --help.`,
    });
  }
  checkAllowed(command, values);
  if (command === "schema") {
    const kind = literal(values.kind ?? "request", "$flags.kind", ["request", "batch", "dictionary"]);
    await emit(kind === "batch" ? BATCH_JOB_SCHEMA : kind === "dictionary" ? DICTIONARY_SCHEMA : REQUEST_SCHEMA);
    return;
  }
  if (command === "capabilities") {
    await emit(CAPABILITIES);
    return;
  }
  if (command === "cache") {
    await runCache(values, positionals);
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
      await emit({ ok: true, operation: "play", path: resolve(path), ...(await playWav(resolve(path), signal)) });
      return;
    }
    if (command === "inspect") {
      const path = string(positionals[1] ?? values.input, "$.inspect.file", 1, 4096);
      const agent = new Kongyoroid({ cache: { enabled: false } });
      const bytes = await readBytes(resolve(path));
      const windowMs = numberFlag(values, "window-ms");
      const result = agent.inspect(bytes, {
        pitchTrack: values["pitch-track"] ?? false,
        ...(windowMs === undefined ? {} : { windowMs }),
      });
      await emit({ ok: true, operation: "inspect", path: resolve(path), ...result });
      return;
    }
    if (positionals.length > 1 && command !== "dict") {
      invalid("$.command", `Unexpected argument ${JSON.stringify(positionals[1])} for ${command}.`, {
        hint: `Run: kongyoroid ${command} --help`,
      });
    }
    const agent = await createAgent(values, command === "dict");
    switch (command) {
      case "speak": {
        if (values.stream) {
          await runSpeakStream(agent, values, signal);
          return;
        }
        const request = speechRequestFromFlags(values, await textInput(values, signal));
        if (values["dry-run"]) {
          await runValidateRequest(agent, request, values, signal);
          return;
        }
        const result = await agent.render(request, { signal });
        const plan =
          values["plan-out"] === undefined || result.engine !== "formant"
            ? undefined
            : (await agent.plan(request, { signal, detail: "phonemes" })).plan;
        await emit(await deliver(agent, result, values, signal, plan), values.output === "-");
        return;
      }
      case "sing": {
        const base = values.input === undefined ? {} : object(parseJson(await readText(values.input, signal)), "$");
        if (base["kind"] !== undefined && base["kind"] !== "song")
          invalid("$.kind", "sing accepts only song requests.");
        const request = songRequestFromFlags(values, base);
        if (values["dry-run"]) {
          await runValidateRequest(agent, request, values, signal);
          return;
        }
        const result = await agent.render(request, { signal });
        const plan =
          values["plan-out"] === undefined || result.engine !== "formant"
            ? undefined
            : (await agent.plan(request, { signal, detail: "phonemes" })).plan;
        await emit(await deliver(agent, result, values, signal, plan), values.output === "-");
        return;
      }
      case "render": {
        const input = string(values.input, "$flags.input", 1, 4096);
        const request = parseJson(await readText(input, signal));
        const withFlags = isObject(request)
          ? {
              ...request,
              ...(values.engine === undefined ? {} : { engine: values.engine }),
              ...(values.voice === undefined ? {} : { voice: values.voice }),
            }
          : request;
        if (values["dry-run"]) {
          await runValidateRequest(agent, withFlags, values, signal);
          return;
        }
        const result = await agent.render(withFlags, { signal });
        const plan =
          values["plan-out"] === undefined || result.engine !== "formant"
            ? undefined
            : (await agent.plan(withFlags, { signal, detail: "phonemes" })).plan;
        await emit(await deliver(agent, result, values, signal, plan), values.output === "-");
        return;
      }
      case "validate":
        await runValidate(agent, values, signal);
        return;
      case "plan":
        await runPlan(agent, values, signal);
        return;
      case "batch": {
        let failures = 0;
        await runBatch(agent, values, signal, () => {
          failures += 1;
        });
        if (failures === 0) process.exitCode = EXIT_CODES.success;
        return;
      }
      case "reading": {
        const text =
          values.kana !== undefined && values.text === undefined && values.input === undefined
            ? values.kana
            : await textInput(values, signal);
        const speakerRef = styleFlag(values, "speaker");
        const entries = parseDictEntries(values);
        const reading = await agent.reading(text, {
          signal,
          ...(values.kana === undefined ? {} : { kana: values.kana }),
          ...(speakerRef === undefined ? {} : { speaker: speakerRef }),
          ...(values.engine === undefined ? {} : { engine: parseEngine(values.engine, "$flags.engine") }),
          ...(entries.length === 0
            ? {}
            : {
                dictionary: new LocalDictionary(
                  entries.map((entry, index) => ({
                    id: `flag-${index + 1}`,
                    surface: entry.surface,
                    reading: entry.reading,
                    accent: entry.accent ?? null,
                    match: "word",
                    priority: 10,
                    caseSensitive: false,
                  })),
                ),
              }),
          ...(values["strict-reading"] === false ? { strict: false } : {}),
        });
        await emit({ ok: true, operation: "reading", text, ...reading });
        return;
      }
      case "voices": {
        const kind: VoiceKind = literal(values.kind ?? "all", "$flags.kind", ["speech", "song", "all"]);
        const engine = literal(values.engine ?? "all", "$flags.engine", ["formant", "voicevox", "auto", "all"]);
        const query = values.query?.normalize("NFKC").toLowerCase();
        const result = await agent.voices({ signal, engine, kind });
        const voices = result.voices.filter(
          (voice) =>
            query === undefined ||
            `${voice.id} ${voice.name} ${voice.character ?? ""}`.normalize("NFKC").toLowerCase().includes(query),
        );
        await emit({
          ok: true,
          operation: "voices",
          kind,
          engine,
          count: voices.length,
          voices,
          voicevox: result.voicevox,
        });
        return;
      }
      case "doctor": {
        const engine =
          values.engine === undefined
            ? undefined
            : literal(values.engine, "$flags.engine", ["formant", "voicevox", "auto", "all"]);
        const diagnosis = await agent.doctor({ signal, ...(engine === undefined ? {} : { engine }) });
        const speakerRef = styleFlag(values, "speaker");
        let style: JsonObject | undefined;
        if (diagnosis.voicevox?.ok === true && speakerRef !== undefined) {
          const all = await agent.styles.all({ signal });
          const selected = all.find(
            (s) => s.id === speakerRef || `${s.character}/${s.name}` === speakerRef || s.character === speakerRef,
          );
          if (selected === undefined) invalid("$flags.speaker", `No style matches ${JSON.stringify(speakerRef)}.`);
          if (values.initialize) await agent.client.initializeSpeaker(selected.id, true, { signal });
          style = { ...selected, initialized: await agent.client.isInitializedSpeaker(selected.id, { signal }) };
        }
        await emit({ ...diagnosis, operation: "doctor", ...(style === undefined ? {} : { style }) });
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

async function runValidateRequest(
  agent: Kongyoroid,
  request: unknown,
  values: Values,
  signal: AbortSignal,
): Promise<void> {
  const result = await agent.validate(request, { signal });
  await reportDiagnostics(values, result.warnings, values.input ?? "<request>");
  const { request: resolved, ...rest } = result;
  await emit({ ...rest, dryRun: true, request: resolved });
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
        hint: "Run kongyoroid --help, or kongyoroid <command> --help for the accepted flags.",
      }
    : asKongyoroidError(error).toJSON();
  process.exitCode = exitCodeOf(new KongyoroidError(data));
  await emit({ ok: false, error: data }, true);
}

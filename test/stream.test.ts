import assert from "node:assert/strict";
import { before, test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { parseRequest } from "../src/request.ts";
import { compileRequest } from "../src/synth/engine.ts";
import { renderPcm } from "../src/synth/renderer.ts";
import { renderPcmStream, streamingWavHeader } from "../src/synth/stream.ts";
import { synthesizeTextStream, takeSentences } from "../src/synth/textstream.ts";
import { loadFrontend } from "../src/text/frontend.ts";
import type { ResolvedSpeech } from "../src/types.ts";
import { inspectWav } from "../src/wav.ts";
import { maxAbsDiff } from "./helpers/audio.ts";

before(async () => {
  await loadFrontend();
});

function speech(request: Record<string, unknown>): ResolvedSpeech {
  const parsed = parseRequest({ kind: "speech", ...request });
  assert.ok(parsed.kind === "speech");
  return parsed;
}

async function* chunks(parts: readonly string[], delayMs: number = 0): AsyncGenerator<string, void, void> {
  for (const part of parts) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield part;
  }
}

test("renderPcmStream produces the same samples as a whole render, in order", async () => {
  const compiled = await compileRequest(parseRequest({ kind: "speech", text: "て", kana: "テ'_スト。" }), 16000);
  const whole = renderPcm(compiled.plan).pcm;
  const joined = new Float32Array(compiled.plan.frames);
  let offset = 0;
  const iterator = renderPcmStream(compiled.plan, { blockFrames: 300 });
  let stats;
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      stats = next.value;
      break;
    }
    assert.equal(next.value.start, offset);
    joined.set(next.value.samples, offset);
    offset += next.value.samples.length;
  }
  assert.equal(offset, compiled.plan.frames);
  assert.equal(maxAbsDiff(whole, joined), 0);
  assert.ok(stats !== undefined && stats.frames === compiled.plan.frames);
});

test("takeSentences cuts at terminals and at a length limit near a pause", () => {
  assert.deepEqual(takeSentences("一。二？三", 100), { sentences: ["一。", "二？"], rest: "三" });
  assert.deepEqual(takeSentences("改行で\n区切る", 100), { sentences: ["改行で\n"], rest: "区切る" });
  assert.deepEqual(takeSentences("一。二。", 100, false), { sentences: ["一。"], rest: "二。" });
  assert.deepEqual(takeSentences("一。二。", 100), { sentences: ["一。", "二。"], rest: "" });
  assert.deepEqual(takeSentences("「やった！", 100, false), { sentences: [], rest: "「やった！" });
  assert.deepEqual(takeSentences("「やった！」と", 100, false), { sentences: ["「やった！」"], rest: "と" });
  const long = `${"あ".repeat(30)}、${"い".repeat(30)}`;
  const taken = takeSentences(long, 40);
  assert.equal(taken.sentences[0], `${"あ".repeat(30)}、`);
  assert.equal(taken.rest, "い".repeat(30));
});

test("text streaming emits sentence events and audio in order as text arrives", async () => {
  const request = speech({ text: "x" });
  const events = synthesizeTextStream(chunks(["最初の文で", "す。次の文。", "最後"], 5), request, {
    sampleRate: 16000,
  });
  const sentences: string[] = [];
  let frames = 0;
  let sequence = -1;
  let end: { frames: number; sentences: number } | undefined;
  for await (const event of events) {
    if (event.type === "sentence") {
      sentences.push(event.text);
      assert.ok(event.kana.length > 0);
      assert.equal(event.startFrame, frames);
    } else if (event.type === "audio") {
      assert.equal(event.sequence, sequence + 1);
      sequence = event.sequence;
      assert.equal(event.block.start, frames);
      frames += event.block.samples.length;
    } else {
      end = { frames: event.frames, sentences: event.sentences };
    }
  }
  assert.deepEqual(sentences, ["最初の文です。", "次の文。", "最後"]);
  assert.deepEqual(end, { frames, sentences: 3 });
  const header = streamingWavHeader(16000);
  assert.equal(header.length, 44);
  assert.equal(new DataView(header.buffer).getUint32(40, true), 0xffffffff);
  assert.equal(
    inspectWav(
      new Uint8Array([...header.subarray(0, 4), 40, 0, 0, 0, ...header.subarray(8, 40), 4, 0, 0, 0, 0, 0, 0, 0]),
    ).frames,
    2,
  );
});

test("flushMs speaks a pending fragment after inactivity, and punctuation-only fragments are skipped", async () => {
  const request = speech({ text: "x" });
  const texts = async (source: AsyncIterable<string>, flushMs?: number): Promise<string[]> => {
    const out: string[] = [];
    for await (const event of synthesizeTextStream(source, request, {
      sampleRate: 16000,
      ...(flushMs === undefined ? {} : { flushMs }),
    })) {
      if (event.type === "sentence") out.push(event.text);
    }
    return out;
  };
  assert.deepEqual(await texts(chunks(["途中で", "止まる", "文。次"], 120), 40), ["途中で", "止まる", "文。", "次"]);
  assert.deepEqual(await texts(chunks(["途中で", "止まる", "文。次"], 120)), ["途中で止まる文。", "次"]);
  assert.deepEqual(await texts(chunks(["。。。", "！", "はい。", "…"], 1)), ["はい。"]);
  assert.deepEqual(takeSentences("「やった！」と言った。", 100), {
    sentences: ["「やった！」", "と言った。"],
    rest: "",
  });
  assert.deepEqual(await texts(chunks(["「やった！", "」と言った。"], 1)), ["「やった！」", "と言った。"]);
  assert.deepEqual(await texts(chunks(["「やった！」と言った。"], 1)), ["「やった！」", "と言った。"]);
  assert.deepEqual(await texts(chunks(["一。", "二。", "三"], 1)), ["一。", "二。", "三"]);
});

test("a chunk that arrives while the consumer is busy keeps its arrival time for the flushMs deadline", async () => {
  const request = speech({ text: "x" });
  const source = (async function* (): AsyncGenerator<string, void, void> {
    yield "一。あ";
    yield "いう";
    await new Promise((resolve) => setTimeout(resolve, 1500));
  })();
  const texts: string[] = [];
  let resumedAt = 0;
  let gapMs = -1;
  for await (const event of synthesizeTextStream(source, request, { sampleRate: 16000, flushMs: 500 })) {
    if (event.type !== "sentence") continue;
    texts.push(event.text);
    if (event.index === 0) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      resumedAt = performance.now();
    } else {
      gapMs = performance.now() - resumedAt;
    }
  }
  assert.deepEqual(texts, ["一。", "あいう"]);
  assert.ok(gapMs >= 0 && gapMs < 300, `the fragment came ${gapMs.toFixed(0)} ms after the consumer resumed`);
});

test("the frontend decides what is readable: symbols it reads are spoken, unreadable sentences are dropped", async () => {
  const request = speech({ text: "x" });
  const collect = async (source: AsyncIterable<string>): Promise<{ text: string; kana: string }[]> => {
    const out: { text: string; kana: string }[] = [];
    for await (const event of synthesizeTextStream(source, request, { sampleRate: 16000 })) {
      if (event.type === "sentence") out.push({ text: event.text, kana: event.kana });
    }
    return out;
  };
  assert.deepEqual(await collect(chunks(["℃。", "🎉🎉🎉。", "＆。", "次。"], 1)), [
    { text: "℃。", kana: "ド。" },
    { text: "＆。", kana: "アンド。" },
    { text: "次。", kana: "ツギ'。" },
  ]);
  await assert.rejects(
    collect(chunks(["🎉", "🎉🎉。", "…"], 1)),
    (error: unknown) => error instanceof KongyoroidError && error.code === "INVALID_INPUT" && error.path === "$.text",
  );
  const slowConsumer = (async () => {
    const seen: string[] = [];
    for await (const event of synthesizeTextStream(chunks(["一。", "々。"], 1), request, { sampleRate: 16000 })) {
      if (event.type !== "sentence") continue;
      seen.push(event.text);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return seen;
  })();
  await assert.rejects(
    slowConsumer,
    (error: unknown) => error instanceof KongyoroidError && error.code === "UNREADABLE_TEXT",
  );
});

test("flushMs counts from the last input, so a fragment left behind a busy consumer is spoken at once", async () => {
  const request = speech({ text: "x" });
  const source = (async function* (): AsyncGenerator<string, void, void> {
    yield "一。断片";
    await new Promise((resolve) => setTimeout(resolve, 1500));
  })();
  const texts: string[] = [];
  let resumedAt = 0;
  let gapMs = -1;
  for await (const event of synthesizeTextStream(source, request, { sampleRate: 16000, flushMs: 500 })) {
    if (event.type !== "sentence") continue;
    texts.push(event.text);
    if (event.index === 0) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      resumedAt = performance.now();
    } else {
      gapMs = performance.now() - resumedAt;
    }
  }
  assert.deepEqual(texts, ["一。", "断片"]);
  assert.ok(gapMs >= 0 && gapMs < 300, `the fragment came ${gapMs.toFixed(0)} ms after the consumer resumed`);
});

test("text streaming stops with ABORTED when the signal fires", async () => {
  const request = speech({ text: "x" });
  const controller = new AbortController();
  const events = synthesizeTextStream(chunks(["一。", "二。", "三。"], 1), request, {
    sampleRate: 16000,
    signal: controller.signal,
  });
  await assert.rejects(
    (async () => {
      for await (const event of events) {
        if (event.type === "audio") controller.abort();
      }
    })(),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
  const waiting = new AbortController();
  const stalled = synthesizeTextStream(
    (async function* (): AsyncGenerator<string, void, void> {
      yield "一。未完";
      await new Promise((resolve) => setTimeout(resolve, 1500));
    })(),
    request,
    { sampleRate: 16000, signal: waiting.signal, flushMs: 10_000 },
  );
  const startedAt = performance.now();
  await assert.rejects(
    (async () => {
      for await (const event of stalled) {
        if (event.type === "end") throw new Error("the stream ended before the abort");
        if (event.type === "sentence") setTimeout(() => waiting.abort(), 80);
      }
    })(),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
  assert.ok(performance.now() - startedAt < 1200, "an abort while waiting for input is not delayed by the source");
  const idle = new AbortController();
  const drained = synthesizeTextStream(
    (async function* (): AsyncGenerator<string, void, void> {
      yield "一。二";
      await new Promise((resolve) => setTimeout(resolve, 1500));
    })(),
    request,
    { sampleRate: 16000, signal: idle.signal, flushMs: 100 },
  );
  const idleStart = performance.now();
  const flushed: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of drained) {
        if (event.type === "end") throw new Error("the stream ended before the abort");
        if (event.type !== "sentence") continue;
        flushed.push(event.text);
        if (event.index === 1) setTimeout(() => idle.abort(), 80);
      }
    })(),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
  assert.deepEqual(flushed, ["一。", "二"]);
  assert.ok(performance.now() - idleStart < 1200, "an abort with nothing buffered is not delayed by the source either");
});

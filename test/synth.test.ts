import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { parseRequest } from "../src/request.ts";
import { midiToHz } from "../src/song/pitch.ts";
import { lfDerivative, solveLfShape } from "../src/synth/glottal.ts";
import { compileRequest } from "../src/synth/engine.ts";
import { renderBlocks, renderPcm } from "../src/synth/renderer.ts";
import { encodePlanAsync, encodePlanSync, renderInto } from "../src/synth/stream.ts";
import { decodeWav, inspectWav } from "../src/wav.ts";
import { maxAbsDiff, pitchCents, rmsBetween, wavStats } from "./helpers/audio.ts";

const RATE = 24000;

async function render(
  request: Record<string, unknown>,
  sampleRate: number = RATE,
): Promise<{ wav: Uint8Array; pcm: Float32Array; plan: Awaited<ReturnType<typeof compileRequest>>["plan"] }> {
  const compiled = await compileRequest(parseRequest({ engine: "formant", ...request }), sampleRate);
  const encoded = encodePlanSync(compiled.plan);
  return { wav: encoded.audio, pcm: decodeWav(encoded.audio).samples, plan: compiled.plan };
}

test("the LF glottal model integrates to zero and peaks at the excitation instant", () => {
  for (const rd of [0.3, 1, 2.7]) {
    const shape = solveLfShape(rd);
    let area = 0;
    let min = 0;
    let minAt = 0;
    const steps = 4000;
    for (let index = 0; index < steps; index++) {
      const value = lfDerivative(shape, index / steps);
      area += value / steps;
      if (value < min) {
        min = value;
        minAt = index / steps;
      }
    }
    assert.ok(Math.abs(area) < 1e-3, `rd ${rd} area ${area}`);
    assert.ok(Math.abs(min + 1) < 0.02, `rd ${rd} min ${min}`);
    assert.ok(Math.abs(minAt - shape.te) < 0.02, `rd ${rd} minAt ${minAt} te ${shape.te}`);
  }
});

test("speech rendering is deterministic, bounded, and seed-sensitive", async () => {
  const request = { kind: "speech", text: "こんにちは", kana: "コンニチワ'/セカ'イ。" };
  const first = await render(request);
  const second = await render(request);
  assert.deepEqual(first.wav, second.wav);
  const info = inspectWav(first.wav);
  assert.equal(info.sampleRate, RATE);
  assert.ok(info.durationSeconds > 0.8 && info.durationSeconds < 2.5, String(info.durationSeconds));
  const stats = wavStats(first.wav);
  assert.equal(stats.finite, true);
  assert.ok(stats.peak <= 1 && stats.peak > 0.15, String(stats.peak));
  assert.ok(stats.rms > 0.03, String(stats.rms));
  const other = await render({ ...request, seed: 9 });
  assert.notDeepEqual(first.wav, other.wav);
  assert.equal(inspectWav(other.wav).frames, info.frames);
});

test("rendering is independent of block size and of sync versus async paths", async () => {
  const compiled = await compileRequest(
    parseRequest({ kind: "speech", text: "てすと", kana: "テ'_スト、テ_ストデ_ス。" }),
    16000,
  );
  const whole = renderPcm(compiled.plan).pcm;
  for (const blockFrames of [257, 512, 4096]) {
    const joined = new Float32Array(compiled.plan.frames);
    let offset = 0;
    for (const block of renderBlocks(compiled.plan, { blockFrames })) {
      joined.set(block, offset);
      offset += block.length;
    }
    assert.equal(offset, compiled.plan.frames);
    assert.equal(maxAbsDiff(whole, joined), 0, `block ${blockFrames}`);
  }
  const sync = encodePlanSync(compiled.plan).audio;
  const async = (await encodePlanAsync(compiled.plan)).audio;
  assert.deepEqual(sync, async);
});

test("sung notes land on their target pitch within a few cents", async () => {
  const { pcm, plan } = await render({
    kind: "song",
    notes: { lyrics: "ドレミファソラシド", melody: "C4 D4 E4 F4 G4 A4 B4 C5", beats: "1 1 1 1 1 1 1 2" },
    tempo: 100,
    vibratoDepth: 0,
  });
  for (const note of plan.notes) {
    if (note.key === null || note.vowelStart === null) continue;
    const from = Math.round(note.vowelStart + (note.end - note.vowelStart) * 0.45);
    const measured = pitchCents(pcm, RATE, from, Math.min(note.end, from + 2400), midiToHz(note.key));
    assert.ok(Math.abs(measured.cents) < 8, `${note.id} ${note.lyric}: ${measured.cents.toFixed(1)} cents`);
    assert.ok(measured.clarity > 0.8, `${note.id} clarity ${measured.clarity}`);
  }
});

test("melismas and ties hold the vowel while portamento moves the pitch in the specified window", async () => {
  const { pcm, plan } = await render({
    kind: "song",
    notes: { lyrics: "あ", melody: "C4 ~E4 ~G4", beats: "2 2 2" },
    vibratoDepth: 0,
    portamentoMs: 40,
    tempo: 60,
  });
  assert.equal(plan.segments.filter((segment) => segment.phoneme === "a").length, 3);
  assert.deepEqual(
    plan.segments.filter((segment) => segment.phoneme === "a").map((segment) => segment.articulation),
    ["onset", "continue", "continue"],
  );
  const second = plan.notes[1];
  assert.ok(second !== undefined && second.vowelStart !== null);
  const early = pitchCents(
    pcm,
    RATE,
    second.vowelStart + Math.round(0.08 * RATE),
    second.vowelStart + Math.round(0.16 * RATE),
    midiToHz(64),
  );
  assert.ok(Math.abs(early.cents) < 12, `pitch 80 ms after a 2 s note boundary: ${early.cents.toFixed(1)} cents`);
  const beforeBoundary = pitchCents(
    pcm,
    RATE,
    second.vowelStart - Math.round(0.2 * RATE),
    second.vowelStart - Math.round(0.1 * RATE),
    midiToHz(60),
  );
  assert.ok(
    Math.abs(beforeBoundary.cents) < 12,
    `pitch 100 ms before the boundary: ${beforeBoundary.cents.toFixed(1)} cents`,
  );
});

test("repeating a vowel re-articulates while a tie continues it", async () => {
  const repeated = await render({
    kind: "song",
    notes: { lyrics: "ああ", melody: "C4 C4" },
    leadIn: 0,
    leadOut: 0,
    vibratoDepth: 0,
  });
  const tied = await render({
    kind: "song",
    notes: { lyrics: "あ", melody: "C4 ~" },
    leadIn: 0,
    leadOut: 0,
    vibratoDepth: 0,
  });
  assert.equal(repeated.pcm.length, tied.pcm.length);
  assert.ok(maxAbsDiff(repeated.pcm, tied.pcm) > 0.05);
  assert.equal(repeated.plan.segments[1]?.articulation, "rearticulate");
  assert.equal(tied.plan.segments[1]?.articulation, "continue");
  const boundary = repeated.plan.segments[1]?.start ?? 0;
  const dip = rmsBetween(repeated.pcm, boundary, boundary + Math.round(0.02 * RATE));
  const steady = rmsBetween(repeated.pcm, boundary + Math.round(0.15 * RATE), boundary + Math.round(0.25 * RATE));
  assert.ok(dip < steady * 0.8, `re-articulation dip ${dip} vs steady ${steady}`);
});

test("volume is continuous around 1 and vibrato depth does not change the level", async () => {
  const notes = [{ key: "A3", beats: 2, lyric: "あ" }];
  const levels = await Promise.all(
    [0.999, 1, 1.001].map((volume) => render({ kind: "song", notes, volume, vibratoDepth: 0 })),
  );
  const rms = levels.map((result) => wavStats(result.wav).rms);
  assert.ok((rms[0] ?? 0) <= (rms[1] ?? 0) + 1e-6 && (rms[1] ?? 0) <= (rms[2] ?? 0) + 1e-6, JSON.stringify(rms));
  assert.ok(Math.abs((rms[2] ?? 0) / (rms[0] ?? 1) - 1) < 0.01);
  const plain = wavStats((await render({ kind: "song", notes, vibratoDepth: 0 })).wav).rms;
  const tiny = wavStats((await render({ kind: "song", notes, vibratoDepth: 0.000001 })).wav).rms;
  assert.ok(Math.abs(tiny / plain - 1) < 0.005, `${plain} vs ${tiny}`);
  const louder = wavStats((await render({ kind: "song", notes, volume: 2.5 })).wav);
  assert.ok(louder.peak <= 1 && louder.finite);
});

test("speed scales every part of a mora, including the palatal glide", async () => {
  const durations = await Promise.all(
    [1, 2, 4].map(async (speed) => {
      const { plan } = await render({ kind: "speech", text: "きゃ", kana: "キャ", prePause: 0, postPause: 0, speed });
      return plan.segments.filter((segment) => segment.phoneme !== "pau").map((segment) => segment.end - segment.start);
    }),
  );
  const [one, two, four] = durations;
  assert.ok(one !== undefined && two !== undefined && four !== undefined);
  assert.equal(one.length, two.length);
  for (const [index, frames] of one.entries()) {
    const half = two[index] ?? 0;
    const quarter = four[index] ?? 0;
    assert.ok(Math.abs(half / frames - 0.5) < 0.06, `speed 2: ${half}/${frames}`);
    assert.ok(Math.abs(quarter / frames - 0.25) < 0.06, `speed 4: ${quarter}/${frames}`);
  }
});

test("a trailing pause mark in kana notation survives normalization and produces silence", async () => {
  const withPause = await render({ kind: "speech", text: "あ", kana: "ア'、", postPause: 0 });
  const without = await render({ kind: "speech", text: "あ", kana: "ア'", postPause: 0 });
  assert.ok(withPause.plan.frames > without.plan.frames + 0.15 * RATE);
  assert.equal(withPause.plan.segments.at(-1)?.phoneme, "pau");
});

test("pitch outside the synthesizable range is rejected before rendering, and voice ranges warn", async () => {
  await assert.rejects(
    compileRequest(
      parseRequest({ kind: "song", notes: [{ key: 127, beats: 1, lyric: "あ" }], sampleRate: 8000 }),
      8000,
    ),
    (error: unknown) =>
      error instanceof KongyoroidError && error.code === "PITCH_OUT_OF_RANGE" && error.repairOptions !== undefined,
  );
  await assert.rejects(
    compileRequest(parseRequest({ kind: "speech", text: "あ", kana: "ア'", pitch: 1 }), RATE),
    (error: unknown) => error instanceof KongyoroidError && error.code === "PITCH_OUT_OF_RANGE",
  );
  const high = await compileRequest(
    parseRequest({ kind: "song", voice: "deep", notes: [{ key: "C7", beats: 1, lyric: "あ" }] }),
    RATE,
  );
  assert.ok(high.plan.warnings.some((warning) => warning.code === "F0_OUTSIDE_VOICE_RANGE"));
});

test("low sample rates render with fewer formants, and the length limit is enforced before rendering", async () => {
  const low = await render({ kind: "speech", text: "さしすせそ", kana: "サシスセソ" }, 8000);
  assert.equal(inspectWav(low.wav).sampleRate, 8000);
  assert.ok(wavStats(low.wav).peak > 0.1);
  const notes = Array.from({ length: 31 }, () => ({ key: null, beats: 64 }));
  await assert.rejects(
    compileRequest(parseRequest({ kind: "song", notes, tempo: 60 }), RATE),
    (error: unknown) =>
      error instanceof KongyoroidError && error.code === "INVALID_INPUT" && error.message.includes("1800"),
  );
});

test("async rendering awaits the sink, yields to the event loop, and honors abort", async () => {
  const compiled = await compileRequest(parseRequest({ kind: "speech", text: "か", kana: "カ'" }), RATE);
  let started = 0;
  let finished = 0;
  await renderInto(compiled.plan, async () => {
    started += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    finished += 1;
  });
  assert.ok(started > 0);
  assert.equal(started, finished);
  const long = await compileRequest(
    parseRequest({ kind: "song", notes: [{ key: "A3", beats: 64, lyric: "あ" }], tempo: 60 }),
    48000,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const startedAt = performance.now();
  await assert.rejects(
    encodePlanAsync(long.plan, { signal: controller.signal }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
  assert.ok(performance.now() - startedAt < 2000);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    encodePlanAsync(compiled.plan, { signal: pre.signal }),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
});

test("every built-in voice renders speech and song without clipping", async () => {
  for (const voice of ["neutral", "female", "male", "child", "soft", "bright", "deep"]) {
    const speech = wavStats(
      (await render({ kind: "speech", text: "はい", kana: "ハ'イ、ワカリマ'_シタ。", voice })).wav,
    );
    assert.ok(speech.finite && speech.peak <= 1 && speech.rms > 0.02, `${voice} speech ${JSON.stringify(speech)}`);
    const song = wavStats((await render({ kind: "song", notes: { lyrics: "らら", melody: "C4 G4" }, voice })).wav);
    assert.ok(song.finite && song.peak <= 1 && song.rms > 0.02, `${voice} song ${JSON.stringify(song)}`);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { planRequest, renderChunks, renderFormant, renderPlan } from "../src/formant.ts";
import { parseRequest } from "../src/request.ts";
import { decodeWav, inspectWav } from "../src/wav.ts";

function stats(samples: Float32Array): { peak: number; rms: number; finite: boolean } {
  let peak = 0;
  let sum = 0;
  let finite = true;
  for (const value of samples) {
    if (!Number.isFinite(value)) finite = false;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, samples.length)), finite };
}

test("speech rendering is deterministic and bounded", () => {
  const request = parseRequest({
    kind: "speech",
    engine: "formant",
    text: "こんにちは、せかい。きょうは いいてんきですね？",
  });
  const first = renderFormant(request, 24000);
  const second = renderFormant(request, 24000);
  assert.deepEqual(first, second);
  const info = inspectWav(first);
  assert.equal(info.sampleRate, 24000);
  assert.ok(info.durationSeconds > 2 && info.durationSeconds < 6, String(info.durationSeconds));
  const { peak, rms, finite } = stats(decodeWav(first).samples);
  assert.equal(finite, true);
  assert.ok(peak <= 1 && peak > 0.2, String(peak));
  assert.ok(rms > 0.05, String(rms));
  const other = renderFormant(
    parseRequest({
      kind: "speech",
      engine: "formant",
      text: "こんにちは、せかい。きょうは いいてんきですね？",
      seed: 9,
    }),
    24000,
  );
  assert.notDeepEqual(first, other);
});

test("kana notation drives the speech contour and changes the output", () => {
  const plain = parseRequest({ kind: "speech", engine: "formant", text: "はし" });
  const accented = parseRequest({ kind: "speech", engine: "formant", text: "はし", kana: "ハ'シ" });
  const flat = parseRequest({ kind: "speech", engine: "formant", text: "はし", kana: "ハシ'" });
  const a = renderFormant(accented, 24000);
  const b = renderFormant(flat, 24000);
  assert.notDeepEqual(a, b);
  assert.equal(inspectWav(a).frames, inspectWav(b).frames);
  assert.notDeepEqual(renderFormant(plain, 24000), a);
});

test("speech parameters scale duration and respect limits", () => {
  const base = parseRequest({ kind: "speech", engine: "formant", text: "あいうえお、かきくけこ。" });
  const fast = parseRequest({ kind: "speech", engine: "formant", text: "あいうえお、かきくけこ。", speed: 2 });
  const slowPause = parseRequest({
    kind: "speech",
    engine: "formant",
    text: "あいうえお、かきくけこ。",
    pauseScale: 3,
    prePause: 0.5,
    postPause: 0.5,
  });
  const baseSeconds = inspectWav(renderFormant(base, 24000)).durationSeconds;
  const fastSeconds = inspectWav(renderFormant(fast, 24000)).durationSeconds;
  const pausedSeconds = inspectWav(renderFormant(slowPause, 24000)).durationSeconds;
  assert.ok(fastSeconds < baseSeconds * 0.65, `${fastSeconds} vs ${baseSeconds}`);
  assert.ok(pausedSeconds > baseSeconds + 1, `${pausedSeconds} vs ${baseSeconds}`);
  assert.equal(inspectWav(renderFormant(base, 8000)).sampleRate, 8000);
  assert.throws(
    () => renderFormant(parseRequest({ kind: "speech", engine: "formant", text: "漢字" }), 24000),
    (error: unknown) => error instanceof KongyoroidError && error.code === "UNSUPPORTED_TEXT",
  );
});

test("song rendering follows the score timing with ties and rests", () => {
  const request = parseRequest({
    kind: "song",
    engine: "formant",
    tempo: 120,
    notes: { lyrics: "きらきらぼしー", melody: "C4 C4 G4 G4 A4 A4 G4 ~ R", beats: "1 1 1 1 1 1 1 1 2" },
    leadIn: 0.2,
    leadOut: 0.1,
  });
  const wav = renderFormant(request, 24000);
  const info = inspectWav(wav);
  const expected = 0.2 + (10 * 60) / 120;
  assert.ok(Math.abs(info.durationSeconds - expected) < 0.02, `${info.durationSeconds} vs ${expected}`);
  const { peak, finite } = stats(decodeWav(wav).samples);
  assert.equal(finite, true);
  assert.ok(peak <= 1 && peak > 0.3);
  const plan = planRequest(request, 24000);
  assert.ok(plan.segments.some((segment) => segment.vibrato));
  assert.equal(plan.frames, info.frames);
});

test("vibrato depth and transposition change the rendered song", () => {
  const notes = [{ key: "A3", beats: 2, lyric: "あ" }];
  const plain = renderFormant(parseRequest({ kind: "song", engine: "formant", notes, vibratoDepth: 0 }), 24000);
  const vibrato = renderFormant(parseRequest({ kind: "song", engine: "formant", notes, vibratoDepth: 60 }), 24000);
  const high = renderFormant(parseRequest({ kind: "song", engine: "formant", notes, transpose: 12 }), 24000);
  assert.notDeepEqual(plain, vibrato);
  assert.notDeepEqual(plain, high);
  assert.equal(inspectWav(plain).frames, inspectWav(high).frames);
});

test("chunked rendering matches whole rendering and honors abort", () => {
  const plan = planRequest(parseRequest({ kind: "speech", engine: "formant", text: "てすとです。" }), 16000);
  const whole = renderPlan(plan);
  const joined = new Float32Array(plan.frames);
  let offset = 0;
  for (const chunk of renderChunks(plan)) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  assert.equal(offset, plan.frames);
  assert.deepEqual(joined, whole);
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => [...renderChunks(plan, { signal: controller.signal })],
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
});

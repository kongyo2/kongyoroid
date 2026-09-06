import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { concatWav, decodeWav, encodeWav, inspectWav, pcm16Samples, silenceWav, wavHeader } from "../src/wav.ts";

test("encode, inspect, and decode round-trip PCM16 mono", () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const wav = encodeWav(pcm, 24000);
  assert.equal(wav.length, 44 + pcm.length * 2);
  const layout = inspectWav(wav);
  assert.equal(layout.frames, pcm.length);
  assert.equal(layout.sampleRate, 24000);
  assert.equal(layout.channels, 1);
  assert.equal(layout.format, "pcm");
  assert.equal(layout.dataOffset, 44);
  const decoded = decodeWav(wav);
  assert.ok(Math.abs((decoded.samples[1] ?? 0) - 0.5) < 1e-4);
  assert.ok(Math.abs((decoded.samples[3] ?? 0) - 32767 / 32768) < 1e-6);
  assert.equal(decoded.samples[5], 32767 / 32768);
  assert.equal(decoded.samples[6], -1);
  assert.equal(pcm16Samples(wav)[4], -32768);
});

test("inspectWav walks chunks and tolerates extra chunks", () => {
  const body = encodeWav(new Float32Array(10), 8000);
  const extra = new Uint8Array(44 + 12 + 20);
  extra.set(body.subarray(0, 36));
  const view = new DataView(extra.buffer);
  view.setUint32(4, extra.length - 8, true);
  view.setUint32(36, 0x4c495354);
  view.setUint32(40, 4, true);
  extra.set([1, 2, 3, 4], 44);
  extra.set(body.subarray(36), 48);
  assert.equal(inspectWav(extra).frames, 10);
  assert.equal(inspectWav(extra).dataOffset, 56);
});

test("malformed WAV data is reported as a protocol error", () => {
  for (const bytes of [new Uint8Array(10), new Uint8Array(64), encodeWav(new Float32Array(4), 8000).subarray(0, 40)]) {
    assert.throws(
      () => inspectWav(bytes),
      (error: unknown) => error instanceof KongyoroidError && error.code === "ENGINE_PROTOCOL",
    );
  }
  const header = wavHeader(4, 8000);
  header[34] = 8;
  assert.throws(() => inspectWav(new Uint8Array([...header, 0, 0, 0, 0, 0, 0, 0, 0])), KongyoroidError);
});

test("float32 WAV decodes and concatenation mixes formats", () => {
  const floatWav = new Uint8Array(44 + 8);
  floatWav.set(wavHeader(2, 16000));
  const view = new DataView(floatWav.buffer);
  view.setUint32(4, 44, true);
  view.setUint16(20, 3, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, 8, true);
  view.setFloat32(44, 0.25, true);
  view.setFloat32(48, -0.25, true);
  const decoded = decodeWav(floatWav);
  assert.equal(decoded.info.format, "float");
  assert.deepEqual([...decoded.samples], [0.25, -0.25]);
  const joined = concatWav([encodeWav(new Float32Array([0.1, 0.2]), 16000), floatWav, silenceWav(0.001, 16000)], 0.001);
  const info = inspectWav(joined);
  assert.equal(info.frames, 2 + 16 + 2 + 16 + 16);
  const samples = decodeWav(joined).samples;
  assert.ok(Math.abs((samples[18] ?? 0) - 0.25) < 1e-4);
  assert.throws(
    () => concatWav([encodeWav(new Float32Array(1), 8000), encodeWav(new Float32Array(1), 16000)]),
    KongyoroidError,
  );
  assert.throws(() => concatWav([]), KongyoroidError);
});

test("truncated WAV payloads are rejected", () => {
  const wav = encodeWav(new Float32Array(100), 8000);
  assert.throws(
    () => inspectWav(wav.subarray(0, wav.length - 10)),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ENGINE_PROTOCOL",
  );
  const overlong = new Uint8Array(wav);
  new DataView(overlong.buffer).setUint32(40, 1000, true);
  assert.throws(() => inspectWav(overlong), KongyoroidError);
  assert.equal(inspectWav(wav).frames, 100);
});

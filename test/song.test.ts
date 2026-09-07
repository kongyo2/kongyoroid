import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { parseRequest } from "../src/request.ts";
import { midiToHz } from "../src/song/pitch.ts";
import { compileRequest, summarizePlan } from "../src/synth/engine.ts";
import { interpolatePitchLog } from "../src/synth/plan.ts";
import type { SynthesisPlan } from "../src/synth/plan.ts";
import { renderPcm } from "../src/synth/renderer.ts";
import { isObject } from "../src/validate.ts";
import { rmsBetween } from "./helpers/audio.ts";

const RATE = 24000;

async function plan(request: Record<string, unknown>): Promise<SynthesisPlan> {
  return (await compileRequest(parseRequest({ kind: "song", ...request }), RATE)).plan;
}

async function planError(request: Record<string, unknown>): Promise<KongyoroidError> {
  try {
    await plan(request);
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

test("note markers report onset, vowel start, continuation, and sustain ids", async () => {
  const planned = await plan({
    notes: { lyrics: "きらきら", melody: "C4 C4 G4 G4 ~ ~A4 R", beats: "1 1 1 1 1 1 1" },
    leadIn: 0.2,
  });
  assert.equal(planned.notes.length, 7);
  const [first, second, third, fourth, tie, melisma, rest] = planned.notes;
  assert.ok(first !== undefined && second !== undefined && third !== undefined && fourth !== undefined);
  assert.ok(tie !== undefined && melisma !== undefined && rest !== undefined);
  assert.ok(first.start < Math.round(0.2 * RATE), "the first consonant starts inside the lead-in");
  assert.ok((first.vowelStart ?? 0) >= first.start);
  assert.ok(second.start <= first.end && second.start >= (first.vowelStart ?? 0));
  assert.equal(tie.continuation, "tie");
  assert.equal(melisma.continuation, "melisma");
  assert.equal(tie.sustainId, fourth.sustainId);
  assert.equal(melisma.sustainId, fourth.sustainId);
  assert.notEqual(first.sustainId, second.sustainId);
  assert.notEqual(third.sustainId, fourth.sustainId);
  assert.equal(rest.key, null);
  assert.equal(planned.vibrato.length, 4);
  const sustain = planned.vibrato.at(-1);
  assert.equal(sustain?.end, melisma.end);
  assert.equal(planned.moras.length, 4 + 2);
  assert.deepEqual(
    planned.moras.map((mora) => mora.text),
    ["キ", "ラ", "キ", "ラ", "ア", "ア"],
  );
});

test("too-short notes fail with repair options unless consonant compression is allowed", async () => {
  const notes = Array.from({ length: 4 }, () => ({ key: "C4", beats: 1 / 4, lyric: "か" }));
  const error = await planError({ notes, tempo: 200, consonantCompression: false });
  assert.equal(error.code, "NOTE_TOO_SHORT");
  assert.equal(error.path, "$.notes[1].beats");
  assert.ok(error.repairOptions?.some((option) => option.action === "allow-consonant-compression"));
  assert.ok(isObject(error.detail) && typeof error.detail["availableMs"] === "number");
  const compressed = await plan({ notes, tempo: 200 });
  assert.ok(compressed.adjustments.some((adjustment) => adjustment.code === "CONSONANT_COMPRESSED"));
  assert.equal(compressed.notes.length, 4);
  const impossible = await planError({ notes: [{ key: "C4", beats: 1 / 64, lyric: "きらきらぼし" }], tempo: 400 });
  assert.equal(impossible.code, "NOTE_TOO_SHORT");
});

test("melismas, portamento, and scoops shape the pitch track in log space", async () => {
  const stepped = await plan({
    notes: { lyrics: "あ", melody: "C4 ~E4", beats: "1 1" },
    portamentoMs: 0,
    vibratoDepth: 0,
    leadIn: 0,
  });
  const second = stepped.notes[1];
  assert.ok(second !== undefined && second.vowelStart !== null);
  const cursor = { index: 0 };
  assert.ok(Math.abs(interpolatePitchLog(stepped.pitch, second.vowelStart - 5, cursor) - midiToHz(60)) < 0.5);
  assert.ok(Math.abs(interpolatePitchLog(stepped.pitch, second.vowelStart + 5, cursor) - midiToHz(64)) < 0.5);
  const glide = await plan({
    notes: { lyrics: "あ", melody: "C4 ~E4", beats: "1 1" },
    portamentoMs: 200,
    vibratoDepth: 0,
    leadIn: 0,
  });
  const glideNote = glide.notes[1];
  assert.ok(glideNote !== undefined && glideNote.vowelStart !== null);
  const midway = interpolatePitchLog(glide.pitch, glideNote.vowelStart - Math.round(0.1 * RATE), { index: 0 });
  assert.ok(midway > midiToHz(60) * 1.05 && midway < midiToHz(64) * 0.97, `midway ${midway}`);
  const scooped = await plan({
    notes: [{ key: "A4", beats: 2, lyric: "あ" }],
    scoopCents: 200,
    scoopMs: 100,
    vibratoDepth: 0,
  });
  const note = scooped.notes[0];
  assert.ok(note !== undefined && note.vowelStart !== null);
  const onset = interpolatePitchLog(scooped.pitch, note.vowelStart, { index: 0 });
  assert.ok(Math.abs(1200 * Math.log2(onset / 440) + 200) < 5, `scoop onset ${onset}`);
  assert.ok(
    Math.abs(interpolatePitchLog(scooped.pitch, note.vowelStart + Math.round(0.2 * RATE), { index: 0 }) - 440) < 0.5,
  );
});

test("velocity, gainDb, per-note vibrato, and articulation are applied per note", async () => {
  const planned = await plan({
    notes: [
      { id: "soft", key: "A3", beats: 1, lyric: "あ", velocity: 40 },
      { id: "loud", key: "A3", beats: 1, lyric: "あ", velocity: 120 },
      { id: "quiet", key: "A3", beats: 1, lyric: "あ", gainDb: -20, vibrato: false },
      { id: "legato", key: "A3", beats: 1, lyric: "あ", articulation: "legato" },
    ],
    vibratoDepth: 40,
  });
  const { pcm } = renderPcm(planned);
  const level = (id: string): number => {
    const note = planned.notes.find((n) => n.id === id);
    assert.ok(note !== undefined && note.vowelStart !== null);
    return rmsBetween(pcm, note.vowelStart + Math.round(0.1 * RATE), note.end - Math.round(0.05 * RATE));
  };
  assert.ok(level("loud") > level("soft") * 1.6, `${level("loud")} vs ${level("soft")}`);
  assert.ok(level("quiet") < level("soft") * 0.5);
  assert.equal(planned.notes[2]?.articulation, "rearticulate");
  assert.equal(planned.notes[3]?.articulation, "onset");
  assert.equal(planned.segments.filter((segment) => segment.phoneme === "a").at(-1)?.articulation, "continue");
  const quiet = planned.notes[2];
  assert.ok(quiet !== undefined);
  assert.ok(!planned.vibrato.some((region) => region.start >= (quiet.vowelStart ?? 0) && region.end <= quiet.end));
});

test("multi-mora lyrics split inside a note and the plan summary exposes timing", async () => {
  const planned = await plan({
    notes: [
      { key: "C4", beats: 2, lyric: "きら" },
      { key: "D4", beats: 2, lyric: "ぼしん" },
    ],
  });
  assert.deepEqual(
    planned.moras.map((mora) => mora.text),
    ["キ", "ラ", "ボ", "シ", "ン"],
  );
  const summary = summarizePlan(planned, "hash", "phonemes");
  assert.equal(summary.kind, "song");
  assert.equal(summary.notes.length, 2);
  assert.ok(summary.phonemes !== undefined && summary.phonemes.length > 5);
  assert.ok(summary.durationSeconds > 1.9);
  assert.equal(summary.wavBytes, 44 + planned.frames * 2);
  const detailed = summarizePlan(planned, "hash", "acoustics");
  assert.ok(detailed.phonemes?.[1]?.keyframes !== undefined);
});

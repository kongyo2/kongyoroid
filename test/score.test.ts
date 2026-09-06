import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import {
  engineScoreFrames,
  notesToEngineScore,
  parseNotes,
  parseScoreText,
  resolveNotes,
  scoreSeconds,
} from "../src/score.ts";

function failure(fn: () => unknown): KongyoroidError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

test("parseScoreText pairs lyric moras with melody notes, rests, and ties", () => {
  const notes = parseScoreText({ lyrics: "きゃらめる", melody: "C4 D4 R E4 ~ F4", beats: "1 1 0.5 1/2 2 1" });
  assert.deepEqual(notes, [
    { key: 60, beats: 1, lyric: "キャ" },
    { key: 62, beats: 1, lyric: "ラ" },
    { key: null, beats: 0.5, lyric: "" },
    { key: 64, beats: 0.5, lyric: "メ" },
    { key: 64, beats: 2, lyric: "ー" },
    { key: 65, beats: 1, lyric: "ル" },
  ]);
});

test("parseScoreText broadcasts a single beat value and defaults to one beat", () => {
  assert.deepEqual(
    parseScoreText({ lyrics: "あい", melody: "60 62", beats: "2" }).map((n) => n.beats),
    [2, 2],
  );
  assert.deepEqual(
    parseScoreText({ lyrics: "あい", melody: "60,62" }).map((n) => n.beats),
    [1, 1],
  );
  assert.deepEqual(
    parseScoreText({ lyrics: "あい", melody: "60 62", beats: [1.5, 0.25] }).map((n) => n.beats),
    [1.5, 0.25],
  );
});

test("parseScoreText rejects mismatched counts with hints", () => {
  const tooFew = failure(() => parseScoreText({ lyrics: "あ", melody: "C4 D4" }));
  assert.equal(tooFew.path, "$.lyrics");
  assert.ok(tooFew.hint?.includes("R for rests"));
  const tooMany = failure(() => parseScoreText({ lyrics: "あいう", melody: "C4" }));
  assert.ok(tooMany.message.includes("2 more moras"));
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "C4 D4", beats: "1 1 1" })).path, "$.beats");
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "~ C4" })).path, "$.melody[0]");
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "H4" })).path, "$.melody[0]");
});

test("resolveNotes validates single-mora lyrics, ties, and transposition", () => {
  const resolved = resolveNotes(
    [
      { key: "C4", beats: 1, lyric: "か" },
      { key: "C4", beats: 1, lyric: "ー" },
      { key: null, beats: 1, lyric: "" },
      { key: 64, beats: 1, lyric: "ん" },
      { key: 64, beats: 1, lyric: "-" },
    ],
    "$.notes",
    2,
  );
  assert.deepEqual(
    resolved.map((n) => [n.key, n.lyric]),
    [
      [62, "カ"],
      [62, "ア"],
      [null, ""],
      [66, "ン"],
      [66, "ン"],
    ],
  );
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "かき" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: null, beats: 1, lyric: "あ" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "ー" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: 127, beats: 1, lyric: "あ" }], "$.notes", 1)).path, "$.notes[0].key");
  assert.equal(
    failure(() =>
      resolveNotes([
        { key: 60, beats: 1, lyric: "っ" },
        { key: 60, beats: 1, lyric: "ー" },
      ]),
    ).path,
    "$.notes[1].lyric",
  );
});

test("parseNotes accepts both the note list and the compact score object", () => {
  const fromList = parseNotes([{ key: "C4", beats: 1, lyric: "ア" }]);
  assert.equal(fromList[0]?.key, "C4");
  const fromText = parseNotes({ lyrics: "ア", melody: "C4", beats: [1] });
  assert.equal(fromText[0]?.key, 60);
  assert.equal(failure(() => parseNotes({ lyrics: "ア", melody: "C4", extra: 1 })).path, "$.notes.extra");
  assert.equal(failure(() => parseNotes([{ key: "C4", beats: 1, lyric: "ア", x: 1 }])).path, "$.notes[0].x");
  assert.equal(failure(() => parseNotes([])).path, "$.notes");
  assert.equal(failure(() => parseNotes({ lyrics: "ア", melody: "C4", beats: 5 })).path, "$.notes.beats");
});

test("notesToEngineScore pads rests and rounds cumulatively without drift", () => {
  const notes = resolveNotes(Array.from({ length: 30 }, () => ({ key: 60, beats: 1 / 3, lyric: "あ" })));
  const score = notesToEngineScore(notes, 120, 93.75, 0.16, 0.16);
  assert.equal(score.notes[0]?.id, "lead-in");
  assert.equal(score.notes[0]?.frame_length, 15);
  assert.equal(score.notes.at(-1)?.id, "lead-out");
  const body = score.notes.slice(1, -1);
  assert.equal(body.length, 30);
  const total = body.reduce((sum, n) => sum + n.frame_length, 0);
  assert.equal(total, Math.round(scoreSeconds(notes, 120) * 93.75));
  assert.ok(body.every((n) => n.frame_length >= 15 && n.frame_length <= 16));
  assert.equal(engineScoreFrames(score), total + 30);
  const withRests = notesToEngineScore(
    resolveNotes([
      { key: null, beats: 1, lyric: "" },
      { key: 60, beats: 1, lyric: "あ" },
      { key: null, beats: 1, lyric: "" },
    ]),
    120,
  );
  assert.equal(withRests.notes.length, 3);
  assert.equal(withRests.notes[0]?.id, "n0");
});

test("notesToEngineScore rejects notes shorter than one frame", () => {
  const error = failure(() => notesToEngineScore(resolveNotes([{ key: 60, beats: 1 / 64, lyric: "あ" }]), 400, 93.75));
  assert.equal(error.path, "$.notes[0].beats");
});

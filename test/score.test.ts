import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import {
  alignLyrics,
  engineScoreFrames,
  notesToEngineScore,
  parseNotes,
  parseScoreText,
  resolveNotes,
  scoreSeconds,
} from "../src/song/score.ts";

function failure(fn: () => unknown): KongyoroidError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

test("parseScoreText pairs lyric moras with melody notes, rests, ties, and melismas", () => {
  const notes = parseScoreText({ lyrics: "きゃらめる", melody: "C4 D4 R E4 ~ ~G4 F4", beats: "1 1 0.5 1/2 2 1 1" });
  assert.deepEqual(notes, [
    { key: 60, beats: 1, lyric: "キャ" },
    { key: 62, beats: 1, lyric: "ラ" },
    { key: null, beats: 0.5, lyric: "" },
    { key: 64, beats: 0.5, lyric: "メ" },
    { key: 64, beats: 2, continuation: "tie" },
    { key: 67, beats: 1, continuation: "melisma" },
    { key: 65, beats: 1, lyric: "ル" },
  ]);
});

test("parseScoreText broadcasts a single beat value, ignores bars, and defaults to one beat", () => {
  assert.deepEqual(
    parseScoreText({ lyrics: "あい", melody: "60 62", beats: "2" }).map((n) => n.beats),
    [2, 2],
  );
  assert.deepEqual(
    parseScoreText({ lyrics: "あい", melody: "60 | 62" }).map((n) => n.beats),
    [1, 1],
  );
  assert.deepEqual(
    parseScoreText({ lyrics: "あい", melody: "60 62", beats: [1.5, 0.25] }).map((n) => n.beats),
    [1.5, 0.25],
  );
});

test("parseScoreText rejects mismatched counts with alignment details and repair options", () => {
  const tooFew = failure(() => parseScoreText({ lyrics: "あ", melody: "C4 D4" }));
  assert.equal(tooFew.path, "$.lyrics");
  assert.ok(tooFew.repairOptions?.some((option) => option.action === "use-vowel-continuation"));
  const alignment = alignLyrics("あ", ["C4", "D4"]);
  assert.deepEqual(alignment.unfilledNotes, [1]);
  const tooMany = failure(() => parseScoreText({ lyrics: "あいう", melody: "C4" }));
  assert.ok(tooMany.message.includes("2 more moras"));
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "C4 D4", beats: "1 1 1" })).path, "$.beats");
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "~ C4" })).path, "$.melody[0]");
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "C4 R ~" })).path, "$.melody[2]");
  assert.equal(failure(() => parseScoreText({ lyrics: "あ", melody: "H4" })).path, "$.melody[0]");
});

test("resolveNotes validates lyrics, continuations, ids, dynamics, and transposition", () => {
  const resolved = resolveNotes(
    [
      { key: "C4", beats: 1, lyric: "か" },
      { key: "C4", beats: 1, lyric: "ー" },
      { key: "E4", beats: 1, continuation: "melisma" },
      { key: null, beats: 1, lyric: "" },
      { id: "n", key: 64, beats: 1, lyric: "ん", velocity: 80 },
      { key: 64, beats: 1, continueFrom: "n" },
      { key: "G4", beats: 2, lyric: "きら", gainDb: -6 },
    ],
    "$.notes",
    2,
  );
  assert.deepEqual(
    resolved.map((n) => [n.id, n.key, n.lyric, n.continuation, n.moras.length]),
    [
      ["n1", 62, "カ", "none", 1],
      ["n2", 62, "ー", "tie", 1],
      ["n3", 66, "ー", "melisma", 1],
      ["n4", null, "", "none", 0],
      ["n", 66, "ン", "none", 1],
      ["n6", 66, "ー", "tie", 1],
      ["n7", 69, "キラ", "none", 2],
    ],
  );
  assert.ok(Math.abs((resolved[4]?.gainDb ?? 0) - 20 * Math.log10(0.8)) < 1e-9);
  assert.equal(resolved[6]?.gainDb, -6);
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: null, beats: 1, lyric: "あ" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "ー" }])).path, "$.notes[0].continuation");
  assert.equal(failure(() => resolveNotes([{ key: 127, beats: 1, lyric: "あ" }], "$.notes", 1)).path, "$.notes[0].key");
  assert.equal(
    failure(() =>
      resolveNotes([
        { key: 60, beats: 1, lyric: "あ" },
        { key: 62, beats: 1, continuation: "tie" },
      ]),
    ).path,
    "$.notes[1].continuation",
  );
  assert.equal(
    failure(() =>
      resolveNotes([
        { key: 60, beats: 1, lyric: "あ" },
        { key: null, beats: 1 },
        { key: 60, beats: 1, continuation: "tie" },
      ]),
    ).path,
    "$.notes[2].continuation",
  );
  assert.equal(
    failure(() =>
      resolveNotes([
        { key: 60, beats: 1, lyric: "あ" },
        { key: 60, beats: 1, lyric: "い", continuation: "tie" },
      ]),
    ).path,
    "$.notes[1].lyric",
  );
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "っ" }])).path, "$.notes[0].lyric");
  assert.equal(failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "きっ" }])).path, "$.notes[0].lyric");
  assert.equal(
    failure(() => resolveNotes([{ key: 60, beats: 1, lyric: "あいうえおかきくけ" }])).path,
    "$.notes[0].lyric",
  );
  assert.equal(
    failure(() =>
      resolveNotes([
        { id: "x", key: 60, beats: 1, lyric: "あ" },
        { id: "x", key: 60, beats: 1, lyric: "い" },
      ]),
    ).path,
    "$.notes[1].id",
  );
  assert.equal(
    failure(() =>
      resolveNotes([
        { key: 60, beats: 1, lyric: "あ" },
        { key: 60, beats: 1, continueFrom: "nope" },
      ]),
    ).path,
    "$.notes[1].continueFrom",
  );
});

test("parseNotes accepts note lists, compact scores, and MML", () => {
  const fromList = parseNotes([{ key: "C4", beats: 1, lyric: "ア" }]);
  assert.equal(fromList.form, "list");
  assert.equal(fromList.notes[0]?.key, "C4");
  const fromText = parseNotes({ lyrics: "ア", melody: "C4", beats: [1] });
  assert.equal(fromText.form, "compact");
  assert.equal(fromText.notes[0]?.key, 60);
  const fromMml = parseNotes({ mml: "t90 o4 c4 d8&d8", lyrics: "どれ" });
  assert.equal(fromMml.form, "mml");
  assert.equal(fromMml.tempo, 90);
  assert.deepEqual(fromMml.notes, [
    { key: 60, beats: 1, lyric: "ド" },
    { key: 62, beats: 0.5, lyric: "レ" },
    { key: 62, beats: 0.5, continuation: "tie" },
  ]);
  assert.equal(failure(() => parseNotes({ lyrics: "ア", melody: "C4", extra: 1 })).path, "$.notes.extra");
  assert.equal(failure(() => parseNotes([{ key: "C4", beats: 1, lyric: "ア", x: 1 }])).path, "$.notes[0].x");
  assert.equal(failure(() => parseNotes([])).path, "$.notes");
  assert.equal(failure(() => parseNotes({ lyrics: "ア", melody: "C4", beats: 5 })).path, "$.notes.beats");
  assert.equal(
    failure(() => parseNotes([{ key: 60, beats: 1, lyric: "ア", velocity: 90, gainDb: -3 }])).path,
    "$.notes[0]",
  );
  assert.equal(
    failure(() => parseNotes([{ key: 60, beats: 1, lyric: "ア", continuation: "hold" }])).path,
    "$.notes[0].continuation",
  );
  assert.equal(failure(() => parseNotes({ mml: "c d e", lyrics: "ど" })).path, "$.notes.lyrics");
});

test("notesToEngineScore pads rests, rounds cumulatively, and rejects multi-mora lyrics", () => {
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
  const tied = notesToEngineScore(
    resolveNotes([
      { key: 60, beats: 1, lyric: "か" },
      { key: 60, beats: 1, continuation: "tie" },
    ]),
    120,
  );
  assert.equal(tied.notes[2]?.lyric, "ア");
  assert.equal(
    failure(() => notesToEngineScore(resolveNotes([{ key: 60, beats: 1 / 64, lyric: "あ" }]), 400, 93.75)).path,
    "$.notes[0].beats",
  );
  assert.equal(
    failure(() => notesToEngineScore(resolveNotes([{ key: 60, beats: 2, lyric: "きら" }]), 120)).path,
    "$.notes[0].lyric",
  );
});

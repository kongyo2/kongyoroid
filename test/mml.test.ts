import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { parseMml } from "../src/song/mml.ts";

function failure(fn: () => unknown): KongyoroidError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

test("parseMml reads tempo, octaves, lengths, dots, rests, ties, and velocity", () => {
  const result = parseMml("t120 o4 l8 c d+ e-4. r4 >c< b2 v10 a4&a8 n60");
  assert.equal(result.tempo, 120);
  assert.deepEqual(
    result.notes.map((n) => [n.key, n.beats, n.continuation, n.velocity ?? null]),
    [
      [60, 0.5, "none", null],
      [63, 0.5, "none", null],
      [63, 1.5, "none", null],
      [null, 1, "none", null],
      [72, 0.5, "none", null],
      [71, 2, "none", null],
      [69, 1, "none", 85],
      [69, 0.5, "tie", 85],
      [60, 0.5, "none", 85],
    ],
  );
});

test("parseMml distinguishes ties from melismas and supports inline lyrics", () => {
  const result = parseMml("c4&c4 c4&e4 [きゃ]g4");
  assert.deepEqual(
    result.notes.map((n) => [n.key, n.continuation, n.lyric ?? null]),
    [
      [60, "none", null],
      [60, "tie", null],
      [60, "none", null],
      [64, "melisma", null],
      [67, "none", "きゃ"],
    ],
  );
});

test("parseMml rejects malformed input with positions", () => {
  assert.equal(failure(() => parseMml("t999")).path, "$.mml[0]");
  assert.equal(failure(() => parseMml("c4 & r4")).path, "$.mml[5]");
  assert.equal(failure(() => parseMml("c4&")).code, "INVALID_INPUT");
  assert.equal(failure(() => parseMml("x")).path, "$.mml[0]");
  assert.ok(failure(() => parseMml("?")).hint?.includes("Supported"));
  assert.equal(failure(() => parseMml("o9 >c")).code, "INVALID_INPUT");
});

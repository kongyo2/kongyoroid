import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { midiToHz, midiToNoteName, noteToMidi } from "../src/pitch.ts";

test("note names convert to MIDI keys", () => {
  assert.equal(noteToMidi("C4"), 60);
  assert.equal(noteToMidi("c4"), 60);
  assert.equal(noteToMidi("A4"), 69);
  assert.equal(noteToMidi("F#4"), 66);
  assert.equal(noteToMidi("Gb4"), 66);
  assert.equal(noteToMidi("B♭3"), 58);
  assert.equal(noteToMidi("C♯5"), 73);
  assert.equal(noteToMidi("Cx4"), 62);
  assert.equal(noteToMidi("C-1"), 0);
  assert.equal(noteToMidi("G9"), 127);
  assert.equal(noteToMidi(72), 72);
  assert.equal(noteToMidi("Ｃ４"), 60);
});

test("invalid keys are rejected with the given path", () => {
  for (const value of ["H4", "C", "C10", 128, -1, 60.5, "G#9"]) {
    assert.throws(
      () => noteToMidi(value, "$.notes[2].key"),
      (error: unknown) =>
        error instanceof KongyoroidError && error.code === "INVALID_INPUT" && error.path === "$.notes[2].key",
      String(value),
    );
  }
});

test("MIDI keys convert back to names and frequencies", () => {
  assert.equal(midiToNoteName(60), "C4");
  assert.equal(midiToNoteName(61), "C#4");
  assert.equal(midiToNoteName(0), "C-1");
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(60) - 261.6256) < 0.001);
});

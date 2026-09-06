import { invalid } from "./errors.ts";

export const A4_HZ: number = 440;

const SEMITONES: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES: readonly string[] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_NAME: RegExp = /^([A-Ga-g])(#|♯|b|♭|x)?(-?\d)$/u;

export function noteToMidi(value: number | string, path: string = "$.key"): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 127) {
      invalid(
        path,
        "A MIDI key must be an integer in [0, 127].",
        "Use a note name such as C4 or an integer such as 60.",
      );
    }
    return value;
  }
  const text = value.trim().normalize("NFKC");
  if (/^-?\d+$/u.test(text)) return noteToMidi(Number(text), path);
  const match = NOTE_NAME.exec(text);
  if (match === null) {
    invalid(
      path,
      `Unrecognized note ${JSON.stringify(value)}.`,
      "Use scientific pitch such as C4, F#4, Bb3 (octave -1 to 9) or a MIDI integer 0–127.",
    );
  }
  const letter = (match[1] ?? "C").toUpperCase();
  const accidental = match[2] ?? "";
  const octave = Number(match[3]);
  const shift = accidental === "#" || accidental === "♯" ? 1 : accidental === "x" ? 2 : accidental === "" ? 0 : -1;
  const midi = (octave + 1) * 12 + (SEMITONES[letter] ?? 0) + shift;
  if (midi < 0 || midi > 127) invalid(path, `Note ${value} is outside the MIDI range 0–127.`);
  return midi;
}

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  return `${NAMES[((rounded % 12) + 12) % 12] ?? "C"}${Math.floor(rounded / 12) - 1}`;
}

export function midiToHz(midi: number): number {
  return A4_HZ * 2 ** ((midi - 69) / 12);
}

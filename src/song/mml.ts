import { invalid } from "../errors.ts";
import type { Continuation } from "./score.ts";

export interface MmlNote {
  readonly key: number | null;
  readonly beats: number;
  readonly continuation: Continuation;
  readonly velocity: number | undefined;
  readonly lyric: string | undefined;
  readonly offset: number;
}

export interface MmlResult {
  readonly tempo: number | undefined;
  readonly notes: readonly MmlNote[];
}

const NOTE_OFFSETS: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function lengthToBeats(length: number, dots: number, path: string, offset: number): number {
  if (length <= 0 || length > 256)
    invalid(`${path}[${offset}]`, `Invalid note length ${length}; use 1–256 (4 = quarter note).`);
  let beats = 4 / length;
  let extra = beats / 2;
  for (let dot = 0; dot < dots; dot++) {
    beats += extra;
    extra /= 2;
  }
  return beats;
}

export function parseMml(text: string, path: string = "$.mml"): MmlResult {
  const chars = Array.from(text.normalize("NFKC"));
  const notes: MmlNote[] = [];
  let tempo: number | undefined;
  let octave = 4;
  let defaultLength = 4;
  let velocity: number | undefined;
  let index = 0;
  let pendingTie = false;
  let pendingLyric: string | undefined;
  const readNumber = (): number | undefined => {
    let digits = "";
    while (index < chars.length && /^[0-9]$/u.test(chars[index] ?? "")) {
      digits += chars[index];
      index += 1;
    }
    return digits.length === 0 ? undefined : Number(digits);
  };
  const readDots = (): number => {
    let dots = 0;
    while (chars[index] === ".") {
      dots += 1;
      index += 1;
    }
    return dots;
  };
  while (index < chars.length) {
    const char = chars[index] ?? "";
    const lower = char.toLowerCase();
    const start = index;
    if (/\s/u.test(char) || char === "|" || char === ",") {
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = chars.indexOf("]", index);
      if (close < 0) invalid(`${path}[${index}]`, "Unclosed [ in MML lyric.");
      pendingLyric = chars.slice(index + 1, close).join("");
      index = close + 1;
      continue;
    }
    if (lower === "t") {
      index += 1;
      const value = readNumber();
      if (value === undefined || value < 20 || value > 400)
        invalid(`${path}[${start}]`, "t must be followed by a tempo in 20–400.");
      tempo = value;
      continue;
    }
    if (lower === "o") {
      index += 1;
      const value = readNumber();
      if (value === undefined || value > 9) invalid(`${path}[${start}]`, "o must be followed by an octave 0–9.");
      octave = value;
      continue;
    }
    if (char === "<") {
      octave -= 1;
      index += 1;
      continue;
    }
    if (char === ">") {
      octave += 1;
      index += 1;
      continue;
    }
    if (lower === "l") {
      index += 1;
      const value = readNumber();
      if (value === undefined || value <= 0 || value > 256)
        invalid(`${path}[${start}]`, "l must be followed by a length 1–256.");
      defaultLength = value;
      continue;
    }
    if (lower === "v") {
      index += 1;
      const value = readNumber();
      if (value === undefined || value > 127)
        invalid(`${path}[${start}]`, "v must be followed by a velocity 0–15 (or 16–127).");
      velocity = value <= 15 ? Math.max(1, Math.round((value / 15) * 127)) : value;
      continue;
    }
    if (lower === "q") {
      index += 1;
      readNumber();
      continue;
    }
    if (char === "&" || char === "^") {
      pendingTie = true;
      index += 1;
      continue;
    }
    if (lower === "r" || lower === "p") {
      if (pendingTie) invalid(`${path}[${start}]`, "& must join two pitched notes; a rest cannot be tied.");
      index += 1;
      const length = readNumber() ?? defaultLength;
      const dots = readDots();
      notes.push({
        key: null,
        beats: lengthToBeats(length, dots, path, start),
        continuation: "none",
        velocity: undefined,
        lyric: undefined,
        offset: start,
      });
      pendingTie = false;
      continue;
    }
    if (lower === "n") {
      index += 1;
      const value = readNumber();
      if (value === undefined || value > 127)
        invalid(`${path}[${start}]`, "n must be followed by a MIDI note number 0–127.");
      const dots = readDots();
      notes.push({
        key: value,
        beats: lengthToBeats(defaultLength, dots, path, start),
        continuation: pendingTie ? (notes.at(-1)?.key === value ? "tie" : "melisma") : "none",
        velocity,
        lyric: pendingTie ? undefined : pendingLyric,
        offset: start,
      });
      pendingTie = false;
      pendingLyric = undefined;
      continue;
    }
    const base = NOTE_OFFSETS[lower];
    if (base !== undefined) {
      index += 1;
      let shift = 0;
      while (chars[index] === "+" || chars[index] === "#" || chars[index] === "-") {
        shift += chars[index] === "-" ? -1 : 1;
        index += 1;
      }
      const length = readNumber() ?? defaultLength;
      const dots = readDots();
      const key = (octave + 1) * 12 + base + shift;
      if (key < 0 || key > 127)
        invalid(`${path}[${start}]`, `Note ${char} in octave ${octave} is outside the MIDI range.`);
      const previous = notes.at(-1);
      const continuation: Continuation =
        pendingTie && previous !== undefined && previous.key !== null
          ? previous.key === key
            ? "tie"
            : "melisma"
          : "none";
      if (pendingTie && (previous === undefined || previous.key === null))
        invalid(`${path}[${start}]`, "& must join two pitched notes.");
      notes.push({
        key,
        beats: lengthToBeats(length, dots, path, start),
        continuation,
        velocity,
        lyric: continuation === "none" ? pendingLyric : undefined,
        offset: start,
      });
      pendingTie = false;
      pendingLyric = undefined;
      continue;
    }
    invalid(`${path}[${start}]`, `Unexpected character ${JSON.stringify(char)} in MML.`, {
      hint: "Supported: t120 (tempo), o4 (octave), < > (octave shift), l8 (default length), v12 (velocity), c d e f g a b with + - #, lengths 1–256 and dots, r (rest), & (tie/melisma), n60 (MIDI), [きゃ] (inline lyric).",
    });
  }
  if (pendingTie) invalid(`${path}[${chars.length}]`, "MML ends with a dangling &.");
  return { tempo, notes };
}

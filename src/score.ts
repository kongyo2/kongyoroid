import { invalid } from "./errors.ts";
import { kanaToUnits, lookupMora, toKatakana, vowelToKana } from "./mora.ts";
import { noteToMidi } from "./pitch.ts";
import { array, has, integer, isObject, keys, number, object, string } from "./validate.ts";

export const DEFAULT_FRAME_RATE: number = 93.75;
export const MAX_NOTES: number = 4096;
export const MIN_BEATS: number = 1 / 64;
export const MAX_BEATS: number = 64;

export interface NoteInput {
  readonly key: number | string | null;
  readonly beats: number;
  readonly lyric: string;
}

export interface Note {
  readonly key: number | null;
  readonly beats: number;
  readonly lyric: string;
}

export interface EngineNote {
  readonly id: string;
  readonly key: number | null;
  readonly frame_length: number;
  readonly lyric: string;
}

export interface EngineScore {
  readonly notes: readonly EngineNote[];
}

export interface ScoreText {
  readonly lyrics: string;
  readonly melody: string;
  readonly beats?: string | readonly number[];
}

const REST_TOKENS: ReadonlySet<string> = new Set(["r", "rest", "_"]);
const TIE_TOKENS: ReadonlySet<string> = new Set(["~", "-", "ー"]);

function parseBeat(token: string, path: string): number {
  const fraction = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/u.exec(token);
  const value = fraction === null ? Number(token) : Number(fraction[1]) / Number(fraction[2]);
  return number(value, path, MIN_BEATS, MAX_BEATS);
}

function tokens(text: string): readonly string[] {
  return text
    .normalize("NFKC")
    .split(/[\s,]+/u)
    .filter((token) => token.length > 0);
}

export function parseScoreText(input: ScoreText, path: string = "$"): readonly NoteInput[] {
  const melody = tokens(string(input.melody, `${path}.melody`, 1, 100_000));
  if (melody.length === 0) invalid(`${path}.melody`, "The melody has no notes.");
  if (melody.length > MAX_NOTES) invalid(`${path}.melody`, `A score is limited to ${MAX_NOTES} notes.`);
  const rawBeats = input.beats;
  const beatTokens =
    rawBeats === undefined ? [] : typeof rawBeats === "string" ? tokens(rawBeats) : rawBeats.map((b) => String(b));
  const beats = beatTokens.map((token, index) => parseBeat(token, `${path}.beats[${index}]`));
  if (beats.length > 1 && beats.length !== melody.length) {
    invalid(`${path}.beats`, `Expected ${melody.length} beat values to match the melody, got ${beats.length}.`);
  }
  const moras = kanaToUnits(string(input.lyrics, `${path}.lyrics`, 0, 100_000), `${path}.lyrics`).filter(
    (unit) => unit.kind === "mora",
  );
  const notes: NoteInput[] = [];
  let moraIndex = 0;
  for (const [index, token] of melody.entries()) {
    const beat = beats.length === 0 ? 1 : (beats[beats.length === 1 ? 0 : index] ?? 1);
    const lower = token.toLowerCase();
    if (REST_TOKENS.has(lower)) {
      notes.push({ key: null, beats: beat, lyric: "" });
      continue;
    }
    if (TIE_TOKENS.has(token)) {
      const previous = notes.findLast((note) => note.key !== null);
      if (previous === undefined) invalid(`${path}.melody[${index}]`, "A tie needs a preceding pitched note.");
      notes.push({ key: previous.key, beats: beat, lyric: "ー" });
      continue;
    }
    const mora = moras[moraIndex];
    if (mora === undefined) {
      invalid(
        `${path}.lyrics`,
        `The melody has more pitched notes than the lyrics have moras (${moras.length} moras).`,
        "Give one kana mora per pitched note, or use R for rests and ~ for ties in the melody.",
      );
    }
    moraIndex += 1;
    notes.push({ key: noteToMidi(token, `${path}.melody[${index}]`), beats: beat, lyric: mora.text });
  }
  if (moraIndex < moras.length) {
    invalid(
      `${path}.lyrics`,
      `The lyrics have ${moras.length - moraIndex} more moras than the melody has pitched notes.`,
      "Add notes to the melody or shorten the lyrics.",
    );
  }
  return notes;
}

export function parseNoteInput(value: unknown, path: string): NoteInput {
  const note = object(value, path);
  keys(note, ["key", "beats", "lyric"], path);
  const key = note["key"];
  if (key !== null && typeof key !== "number" && typeof key !== "string") {
    invalid(`${path}.key`, "Expected a MIDI integer, a note name such as C4, or null for a rest.");
  }
  const beats = number(note["beats"], `${path}.beats`, MIN_BEATS, MAX_BEATS);
  const lyric = has(note, "lyric") ? string(note["lyric"], `${path}.lyric`, 0, 8) : "";
  return { key, beats, lyric };
}

export function resolveNotes(
  input: readonly NoteInput[],
  path: string = "$.notes",
  transpose: number = 0,
): readonly Note[] {
  const resolved: Note[] = [];
  for (const [index, note] of input.entries()) {
    const notePath = `${path}[${index}]`;
    const lyric = toKatakana(note.lyric).replaceAll(/\s+/gu, "");
    if (note.key === null) {
      if (lyric !== "") invalid(`${notePath}.lyric`, "A rest (key null) must have an empty lyric.");
      resolved.push({ key: null, beats: note.beats, lyric: "" });
      continue;
    }
    const key = noteToMidi(note.key, `${notePath}.key`) + transpose;
    if (key < 0 || key > 127) invalid(`${notePath}.key`, `Transposed key ${key} is outside the MIDI range 0–127.`);
    if (lyric.length === 0) invalid(`${notePath}.lyric`, "A pitched note needs a one-mora lyric such as ア or キャ.");
    if (TIE_TOKENS.has(lyric)) {
      const previous = resolved.findLast((n) => n.key !== null);
      if (previous === undefined) invalid(`${notePath}.lyric`, "A tie needs a preceding pitched note.");
      const phonemes = lookupMora(previous.lyric);
      if (phonemes === undefined || phonemes.vowel === "cl" || phonemes.vowel === "pau") {
        invalid(`${notePath}.lyric`, "A tie must follow a note with a voiced vowel.");
      }
      resolved.push({ key, beats: note.beats, lyric: vowelToKana(phonemes.vowel) });
      continue;
    }
    const phonemes = lookupMora(lyric);
    if (phonemes === undefined) {
      invalid(
        `${notePath}.lyric`,
        `Lyric ${JSON.stringify(note.lyric)} is not a single kana mora.`,
        "VOICEVOX sings exactly one mora per note; split multi-mora lyrics across notes.",
      );
    }
    resolved.push({ key, beats: note.beats, lyric });
  }
  return resolved;
}

export function parseNotes(value: unknown, path: string = "$.notes"): readonly NoteInput[] {
  if (isObject(value)) {
    keys(value, ["lyrics", "melody", "beats"], path);
    const beats = value["beats"];
    if (beats !== undefined && typeof beats !== "string" && !Array.isArray(beats)) {
      invalid(`${path}.beats`, "Expected a string of beat values or an array of numbers.");
    }
    return parseScoreText(
      {
        lyrics: string(value["lyrics"], `${path}.lyrics`, 0, 100_000),
        melody: string(value["melody"], `${path}.melody`, 1, 100_000),
        ...(beats === undefined
          ? {}
          : {
              beats:
                typeof beats === "string"
                  ? beats
                  : beats.map((b: unknown, i: number) => number(b, `${path}.beats[${i}]`, MIN_BEATS, MAX_BEATS)),
            }),
      },
      path,
    );
  }
  return array(value, path, 1, MAX_NOTES).map((note, index) => parseNoteInput(note, `${path}[${index}]`));
}

export function scoreSeconds(notes: readonly Note[], tempo: number): number {
  let beats = 0;
  for (const note of notes) beats += note.beats;
  return (beats * 60) / tempo;
}

export function notesToEngineScore(
  notes: readonly Note[],
  tempo: number,
  frameRate: number = DEFAULT_FRAME_RATE,
  leadIn: number = 0.16,
  leadOut: number = 0.16,
): EngineScore {
  const engineNotes: EngineNote[] = [];
  const padding = (seconds: number): number => Math.max(1, Math.round(seconds * frameRate));
  if (notes[0]?.key !== null) engineNotes.push({ id: "lead-in", key: null, frame_length: padding(leadIn), lyric: "" });
  let frames = 0;
  let seconds = 0;
  for (const [index, note] of notes.entries()) {
    seconds += (note.beats * 60) / tempo;
    const boundary = Math.round(seconds * frameRate);
    const length = boundary - frames;
    if (length < 1) {
      invalid(
        `$.notes[${index}].beats`,
        `Note ${index} is shorter than one engine frame (${(1000 / frameRate).toFixed(2)} ms at ${tempo} BPM).`,
      );
    }
    engineNotes.push({ id: `n${index}`, key: note.key, frame_length: length, lyric: note.lyric });
    frames = boundary;
  }
  if (notes.at(-1)?.key !== null)
    engineNotes.push({ id: "lead-out", key: null, frame_length: padding(leadOut), lyric: "" });
  return { notes: engineNotes };
}

export function engineScoreFrames(score: EngineScore): number {
  let total = 0;
  for (const note of score.notes) total += note.frame_length;
  return total;
}

export function transposeInput(value: unknown, path: string): number {
  return integer(value, path, -48, 48);
}

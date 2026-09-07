import { invalid } from "../errors.ts";
import type { RepairOption } from "../errors.ts";
import type { MoraPhonemes, MoraUnit } from "../text/mora.ts";
import { kanaToMoras, kanaToUnits, lookupMora, toKatakana, vowelToKana } from "../text/mora.ts";
import { array, boolean, has, integer, isObject, keys, number, object, string } from "../validate.ts";
import { parseMml } from "./mml.ts";
import { noteToMidi } from "./pitch.ts";

export const DEFAULT_FRAME_RATE: number = 93.75;
export const MAX_NOTES: number = 4096;
export const MIN_BEATS: number = 1 / 64;
export const MAX_BEATS: number = 64;
export const MAX_LYRIC_MORAS: number = 8;

export type Continuation = "none" | "tie" | "melisma";
export type NoteArticulation = "auto" | "legato" | "rearticulate";

export interface NoteVibrato {
  readonly depthCents?: number;
  readonly rateHz?: number;
  readonly delayMs?: number;
  readonly fadeMs?: number;
}

export interface NoteInput {
  readonly id?: string;
  readonly key: number | string | null;
  readonly beats: number;
  readonly lyric?: string;
  readonly continuation?: Continuation;
  readonly continueFrom?: string;
  readonly articulation?: NoteArticulation;
  readonly velocity?: number;
  readonly gainDb?: number;
  readonly portamentoMs?: number;
  readonly vibrato?: NoteVibrato | false;
}

export interface Note {
  readonly id: string;
  readonly index: number;
  readonly key: number | null;
  readonly beats: number;
  readonly lyric: string;
  readonly moras: readonly MoraPhonemes[];
  readonly moraTexts: readonly string[];
  readonly continuation: Continuation;
  readonly articulation: NoteArticulation;
  readonly velocity: number;
  readonly gainDb: number;
  readonly portamentoSeconds: number | undefined;
  readonly vibrato: NoteVibrato | false | undefined;
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

export interface MmlScore {
  readonly mml: string;
  readonly lyrics?: string;
}

export const NOTE_KEYS: readonly string[] = [
  "id",
  "key",
  "beats",
  "lyric",
  "continuation",
  "continueFrom",
  "articulation",
  "velocity",
  "gainDb",
  "portamentoMs",
  "vibrato",
];

const REST_TOKENS: ReadonlySet<string> = new Set(["r", "rest", "_"]);
const TIE_TOKENS: ReadonlySet<string> = new Set(["~", "-", "ー", "&"]);

function parseBeat(token: string, path: string): number {
  const fraction = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/u.exec(token);
  const value = fraction === null ? Number(token) : Number(fraction[1]) / Number(fraction[2]);
  return number(value, path, MIN_BEATS, MAX_BEATS);
}

function tokens(text: string): readonly string[] {
  return text
    .normalize("NFKC")
    .replaceAll("|", " ")
    .split(/[\s,]+/u)
    .filter((token) => token.length > 0);
}

export interface LyricAlignment {
  readonly moras: readonly string[];
  readonly pitchedNotes: number;
  readonly assigned: readonly { readonly note: number; readonly mora: number; readonly text: string }[];
  readonly leftoverMoras: readonly string[];
  readonly unfilledNotes: readonly number[];
}

export function alignLyrics(lyrics: string, melody: readonly string[], path: string = "$"): LyricAlignment {
  const moras = kanaToUnits(lyrics, `${path}.lyrics`)
    .filter((unit): unit is MoraUnit => unit.kind === "mora")
    .map((unit) => unit.text);
  const assigned: { note: number; mora: number; text: string }[] = [];
  const unfilled: number[] = [];
  let moraIndex = 0;
  let pitched = 0;
  for (const [index, token] of melody.entries()) {
    const lower = token.toLowerCase();
    if (REST_TOKENS.has(lower) || TIE_TOKENS.has(token) || token.startsWith("~")) continue;
    pitched += 1;
    const text = moras[moraIndex];
    if (text === undefined) {
      unfilled.push(index);
      continue;
    }
    assigned.push({ note: index, mora: moraIndex, text });
    moraIndex += 1;
  }
  return { moras, pitchedNotes: pitched, assigned, leftoverMoras: moras.slice(moraIndex), unfilledNotes: unfilled };
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
  const lyrics = string(input.lyrics, `${path}.lyrics`, 0, 100_000);
  const alignment = alignLyrics(lyrics, melody, path);
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
      const previous = notes.at(-1);
      if (previous === undefined || previous.key === null) {
        invalid(`${path}.melody[${index}]`, "A tie (~) must directly follow a pitched note.", {
          hint: "Ties cannot cross rests; after R start a new note with a lyric.",
        });
      }
      notes.push({ key: previous.key, beats: beat, continuation: "tie" });
      continue;
    }
    if (token.startsWith("~") && token.length > 1) {
      const previous = notes.at(-1);
      if (previous === undefined || previous.key === null) {
        invalid(`${path}.melody[${index}]`, "A melisma (~C5) must directly follow a pitched note.");
      }
      notes.push({ key: noteToMidi(token.slice(1), `${path}.melody[${index}]`), beats: beat, continuation: "melisma" });
      continue;
    }
    const mora = alignment.moras[moraIndex];
    if (mora === undefined) {
      invalid(
        `${path}.lyrics`,
        `The melody has ${alignment.pitchedNotes} pitched notes but the lyrics have only ${alignment.moras.length} moras.`,
        {
          hint: "Give one kana mora per pitched note, use R for rests, ~ to hold the previous note, or ~C5 to move the vowel to a new pitch.",
          detail: { alignment },
          repairOptions: [
            {
              action: "use-vowel-continuation",
              description: "Replace surplus notes with ~ (tie) or ~<key> (melisma).",
              path: `${path}.melody`,
            },
            {
              action: "shorten-input",
              description: `Remove ${alignment.unfilledNotes.length} pitched note(s) or add moras to the lyrics.`,
            },
          ],
        },
      );
    }
    moraIndex += 1;
    notes.push({ key: noteToMidi(token, `${path}.melody[${index}]`), beats: beat, lyric: mora });
  }
  if (moraIndex < alignment.moras.length) {
    invalid(
      `${path}.lyrics`,
      `The lyrics have ${alignment.moras.length - moraIndex} more moras than the melody has pitched notes.`,
      {
        hint: "Add notes to the melody or shorten the lyrics.",
        detail: { alignment },
        repairOptions: [
          {
            action: "shorten-input",
            description: `Remove the leftover moras: ${alignment.leftoverMoras.join("")}.`,
            path: `${path}.lyrics`,
          },
        ],
      },
    );
  }
  return notes;
}

export function parseMmlScore(
  input: MmlScore,
  path: string = "$",
): { readonly notes: readonly NoteInput[]; readonly tempo: number | undefined } {
  const parsed = parseMml(string(input.mml, `${path}.mml`, 1, 100_000), `${path}.mml`);
  const lyrics = input.lyrics === undefined ? "" : string(input.lyrics, `${path}.lyrics`, 0, 100_000);
  const moras = kanaToMoras(lyrics, `${path}.lyrics`).map((unit) => unit.text);
  const notes: NoteInput[] = [];
  let moraIndex = 0;
  let pitched = 0;
  for (const [index, note] of parsed.notes.entries()) {
    if (note.key === null) {
      notes.push({ key: null, beats: note.beats });
      continue;
    }
    if (note.continuation !== "none") {
      notes.push({
        key: note.key,
        beats: note.beats,
        continuation: note.continuation,
        ...(note.velocity === undefined ? {} : { velocity: note.velocity }),
      });
      continue;
    }
    pitched += 1;
    if (lyrics.length === 0) {
      notes.push({
        key: note.key,
        beats: note.beats,
        lyric: note.lyric ?? "ラ",
        ...(note.velocity === undefined ? {} : { velocity: note.velocity }),
      });
      continue;
    }
    const mora = note.lyric ?? moras[moraIndex];
    if (mora === undefined) {
      invalid(
        `${path}.lyrics`,
        `The MML has ${pitched} or more pitched notes but the lyrics have only ${moras.length} moras (note ${index + 1}).`,
        {
          hint: "Give one kana mora per pitched note, or use & to hold a vowel across notes.",
        },
      );
    }
    if (note.lyric === undefined) moraIndex += 1;
    notes.push({
      key: note.key,
      beats: note.beats,
      lyric: mora,
      ...(note.velocity === undefined ? {} : { velocity: note.velocity }),
    });
  }
  if (lyrics.length > 0 && moraIndex < moras.length) {
    invalid(
      `${path}.lyrics`,
      `The lyrics have ${moras.length - moraIndex} more moras than the MML has pitched notes.`,
      {
        hint: "Add notes to the MML or shorten the lyrics.",
      },
    );
  }
  if (notes.length === 0) invalid(`${path}.mml`, "The MML contains no notes.");
  return { notes, tempo: parsed.tempo };
}

function parseVibrato(value: unknown, path: string): NoteVibrato | false {
  if (value === false) return false;
  const o = object(value, path);
  keys(o, ["depthCents", "rateHz", "delayMs", "fadeMs"], path);
  return {
    ...(has(o, "depthCents") ? { depthCents: number(o["depthCents"], `${path}.depthCents`, 0, 200) } : {}),
    ...(has(o, "rateHz") ? { rateHz: number(o["rateHz"], `${path}.rateHz`, 0, 12) } : {}),
    ...(has(o, "delayMs") ? { delayMs: number(o["delayMs"], `${path}.delayMs`, 0, 5000) } : {}),
    ...(has(o, "fadeMs") ? { fadeMs: number(o["fadeMs"], `${path}.fadeMs`, 0, 5000) } : {}),
  };
}

export function parseNoteInput(value: unknown, path: string): NoteInput {
  const note = object(value, path);
  keys(note, NOTE_KEYS, path);
  const key = note["key"];
  if (key !== null && typeof key !== "number" && typeof key !== "string") {
    invalid(`${path}.key`, "Expected a MIDI integer, a note name such as C4, or null for a rest.");
  }
  const beats = number(note["beats"], `${path}.beats`, MIN_BEATS, MAX_BEATS);
  const continuation = note["continuation"];
  if (continuation !== undefined && continuation !== "none" && continuation !== "tie" && continuation !== "melisma") {
    invalid(`${path}.continuation`, 'Expected "tie", "melisma", or "none".');
  }
  const articulation = note["articulation"];
  if (
    articulation !== undefined &&
    articulation !== "auto" &&
    articulation !== "legato" &&
    articulation !== "rearticulate"
  ) {
    invalid(`${path}.articulation`, 'Expected "auto", "legato", or "rearticulate".');
  }
  const gainDb = has(note, "gainDb") ? number(note["gainDb"], `${path}.gainDb`, -40, 12) : undefined;
  const velocity = has(note, "velocity") ? integer(note["velocity"], `${path}.velocity`, 1, 127) : undefined;
  if (gainDb !== undefined && velocity !== undefined) invalid(path, "Give either velocity or gainDb, not both.");
  return {
    key,
    beats,
    ...(has(note, "id") ? { id: string(note["id"], `${path}.id`, 1, 64) } : {}),
    ...(has(note, "lyric") ? { lyric: string(note["lyric"], `${path}.lyric`, 0, 32) } : {}),
    ...(continuation === undefined ? {} : { continuation }),
    ...(has(note, "continueFrom") ? { continueFrom: string(note["continueFrom"], `${path}.continueFrom`, 1, 64) } : {}),
    ...(articulation === undefined ? {} : { articulation }),
    ...(velocity === undefined ? {} : { velocity }),
    ...(gainDb === undefined ? {} : { gainDb }),
    ...(has(note, "portamentoMs")
      ? { portamentoMs: number(note["portamentoMs"], `${path}.portamentoMs`, 0, 2000) }
      : {}),
    ...(has(note, "vibrato") ? { vibrato: parseVibrato(note["vibrato"], `${path}.vibrato`) } : {}),
  };
}

function tooShortRepairs(path: string): readonly RepairOption[] {
  return [
    { action: "increase-duration", description: "Give the note more beats or lower the tempo.", path },
    {
      action: "use-vowel-continuation",
      description: "Hold the previous vowel with a tie or melisma instead of a new lyric.",
    },
  ];
}

export function resolveNotes(
  input: readonly NoteInput[],
  path: string = "$.notes",
  transpose: number = 0,
): readonly Note[] {
  const resolved: Note[] = [];
  const ids = new Set<string>();
  for (const [index, note] of input.entries()) {
    const notePath = `${path}[${index}]`;
    const id = note.id ?? `n${index + 1}`;
    if (ids.has(id)) invalid(`${notePath}.id`, `Duplicate note id ${JSON.stringify(id)}.`);
    ids.add(id);
    const rawLyric = toKatakana(note.lyric ?? "").replaceAll(/\s+/gu, "");
    const previous = resolved.at(-1);
    const velocity = note.velocity ?? 100;
    const gainDb = note.gainDb ?? 20 * Math.log10(velocity / 100);
    const base = {
      id,
      index,
      beats: note.beats,
      velocity,
      gainDb,
      portamentoSeconds: note.portamentoMs === undefined ? undefined : note.portamentoMs / 1000,
      vibrato: note.vibrato,
      articulation: note.articulation ?? "auto",
    } as const;
    if (note.key === null) {
      if (rawLyric !== "") invalid(`${notePath}.lyric`, "A rest (key null) must have an empty lyric.");
      if (note.continuation !== undefined && note.continuation !== "none")
        invalid(`${notePath}.continuation`, "A rest cannot continue a note.");
      resolved.push({ ...base, key: null, lyric: "", moras: [], moraTexts: [], continuation: "none" });
      continue;
    }
    const key = noteToMidi(note.key, `${notePath}.key`) + transpose;
    if (key < 0 || key > 127) invalid(`${notePath}.key`, `Transposed key ${key} is outside the MIDI range 0–127.`);
    let continuation: Continuation = note.continuation ?? "none";
    if (continuation === "none" && TIE_TOKENS.has(rawLyric))
      continuation = previous !== undefined && previous.key === key ? "tie" : "melisma";
    if (note.continueFrom !== undefined) {
      if (previous === undefined || previous.id !== note.continueFrom) {
        invalid(
          `${notePath}.continueFrom`,
          `continueFrom must name the directly preceding note (${previous === undefined ? "none" : JSON.stringify(previous.id)}).`,
        );
      }
      if (continuation === "none") continuation = previous.key === key ? "tie" : "melisma";
    }
    if (continuation !== "none") {
      if (rawLyric !== "" && !TIE_TOKENS.has(rawLyric)) {
        invalid(`${notePath}.lyric`, "A continued note (tie or melisma) must not carry a new lyric.", {
          hint: "Remove the lyric, or drop the continuation to re-articulate the mora.",
        });
      }
      if (previous === undefined || previous.key === null) {
        invalid(
          `${notePath}.continuation`,
          "A tie or melisma must directly follow a pitched note; it cannot cross a rest.",
          {
            hint: "After a rest, start a new note with a lyric (for example the vowel of the previous mora).",
            repairOptions: [
              {
                action: "use-vowel-continuation",
                description: "Move the continuation before the rest, or give this note a lyric.",
              },
            ],
          },
        );
      }
      if (continuation === "tie" && previous.key !== key) {
        invalid(
          `${notePath}.continuation`,
          `A tie must keep the previous pitch (${previous.key}); use "melisma" to change pitch on the same vowel.`,
          {
            hint: 'Set continuation to "melisma" or make the keys equal.',
          },
        );
      }
      const lastMora = previous.moras.at(-1);
      if (lastMora === undefined || lastMora.vowel === "cl" || lastMora.vowel === "pau") {
        invalid(`${notePath}.continuation`, "A continuation must follow a note with a voiced vowel.");
      }
      const vowelKana = vowelToKana(lastMora.vowel);
      resolved.push({
        ...base,
        key,
        lyric: "ー",
        moras: [{ consonant: null, vowel: lastMora.vowel }],
        moraTexts: [vowelKana],
        continuation,
      });
      continue;
    }
    if (rawLyric.length === 0) {
      invalid(`${notePath}.lyric`, "A pitched note needs a lyric of one or more kana moras such as ア or キャ.", {
        hint: 'Give a lyric, or set continuation to "tie"/"melisma" to hold the previous vowel.',
      });
    }
    const units = kanaToMoras(rawLyric, `${notePath}.lyric`);
    if (units.length === 0) invalid(`${notePath}.lyric`, `Lyric ${JSON.stringify(note.lyric)} contains no kana mora.`);
    if (units.length > MAX_LYRIC_MORAS) {
      invalid(
        `${notePath}.lyric`,
        `Lyric ${JSON.stringify(note.lyric)} has ${units.length} moras; a note holds at most ${MAX_LYRIC_MORAS}.`,
        {
          hint: "Split the lyric across several notes.",
          repairOptions: tooShortRepairs(`${notePath}.beats`),
        },
      );
    }
    const moras: MoraPhonemes[] = [];
    const moraTexts: string[] = [];
    for (const unit of units) {
      if (unit.vowel === "cl" && units.length === 1) {
        invalid(`${notePath}.lyric`, "A note cannot consist only of ッ (a closure has no voice).", {
          hint: "Attach ッ to the preceding mora, e.g. キッ.",
        });
      }
      const phonemes =
        unit.text === "ー"
          ? { consonant: null, vowel: unit.vowel }
          : (lookupMora(unit.text) ?? { consonant: unit.consonant, vowel: unit.vowel });
      moras.push(phonemes);
      moraTexts.push(unit.text);
    }
    const last = moras.at(-1);
    if (last !== undefined && last.vowel === "cl") {
      invalid(
        `${notePath}.lyric`,
        `Lyric ${JSON.stringify(note.lyric)} ends with ッ; a note must end in a voiced vowel or ン.`,
        {
          hint: "Move ッ to the start of the next note's lyric, or drop it.",
        },
      );
    }
    resolved.push({ ...base, key, lyric: rawLyric, moras, moraTexts, continuation: "none" });
  }
  return resolved;
}

export interface ParsedNotes {
  readonly notes: readonly NoteInput[];
  readonly tempo: number | undefined;
  readonly form: "list" | "compact" | "mml";
}

export function parseNotes(value: unknown, path: string = "$.notes"): ParsedNotes {
  if (isObject(value)) {
    if (has(value, "mml")) {
      keys(value, ["mml", "lyrics"], path);
      const parsed = parseMmlScore(
        {
          mml: string(value["mml"], `${path}.mml`, 1, 100_000),
          ...(has(value, "lyrics") ? { lyrics: string(value["lyrics"], `${path}.lyrics`, 0, 100_000) } : {}),
        },
        path,
      );
      return { notes: parsed.notes, tempo: parsed.tempo, form: "mml" };
    }
    keys(value, ["lyrics", "melody", "beats"], path);
    const beats = value["beats"];
    if (beats !== undefined && typeof beats !== "string" && !Array.isArray(beats)) {
      invalid(`${path}.beats`, "Expected a string of beat values or an array of numbers.");
    }
    return {
      notes: parseScoreText(
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
      ),
      tempo: undefined,
      form: "compact",
    };
  }
  return {
    notes: array(value, path, 1, MAX_NOTES).map((note, index) => parseNoteInput(note, `${path}[${index}]`)),
    tempo: undefined,
    form: "list",
  };
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
    if (note.key !== null && note.moras.length > 1) {
      invalid(
        `$.notes[${index}].lyric`,
        "VOICEVOX sings exactly one mora per note; split multi-mora lyrics across notes.",
        {
          hint: "Use the formant engine for multi-mora lyrics, or add notes.",
        },
      );
    }
    const lyric = note.key === null ? "" : note.continuation === "none" ? note.lyric : (note.moraTexts[0] ?? "ア");
    engineNotes.push({ id: note.id, key: note.key, frame_length: length, lyric });
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

export function parseBooleanFlag(value: unknown, path: string): boolean {
  return boolean(value, path);
}

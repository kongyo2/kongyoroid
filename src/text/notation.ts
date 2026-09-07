import { invalid } from "../errors.ts";
import type { Consonant, UnvoicedVowel, Vowel } from "./mora.ts";
import { devoicedVowelOf, isLongVowelMark, isUnvoicedVowel, lookupMora, toKatakana } from "./mora.ts";

export type BoundaryKind = "phrase" | "pause" | "sentence" | "question" | "exclamation" | "paragraph" | "end";

export interface NotationMora {
  readonly text: string;
  readonly consonant: Consonant | null;
  readonly vowel: Vowel | UnvoicedVowel;
}

export interface AccentPhrase {
  readonly moras: readonly NotationMora[];
  readonly accent: number;
  readonly boundary: BoundaryKind;
  readonly pause: boolean;
  readonly interrogative: boolean;
  readonly exclamatory: boolean;
}

const ACCENT = "'";
const UNVOICE = "_";
export const LONG_VOWEL: string = "ー";
const PHRASE = "/";
const PAUSE = "、";
const SENTENCE = "。";
const QUESTION = "？";
const EXCLAMATION = "！";

const BOUNDARY_CHARS: ReadonlyMap<string, BoundaryKind> = new Map<string, BoundaryKind>([
  [PHRASE, "phrase"],
  [PAUSE, "pause"],
  [SENTENCE, "sentence"],
  [QUESTION, "question"],
  [EXCLAMATION, "exclamation"],
]);

const BOUNDARY_TEXT: Readonly<Record<BoundaryKind, string>> = {
  phrase: PHRASE,
  pause: PAUSE,
  sentence: SENTENCE,
  question: QUESTION,
  exclamation: EXCLAMATION,
  paragraph: SENTENCE,
  end: "",
};

export function boundaryIsSentenceEnd(boundary: BoundaryKind): boolean {
  return boundary === "sentence" || boundary === "question" || boundary === "exclamation" || boundary === "paragraph";
}

function unvoice(vowel: Vowel, path: string, text: string): UnvoicedVowel {
  const devoiced = devoicedVowelOf(vowel);
  if (devoiced === undefined) return invalid(path, `Only vowels can be devoiced with "_": ${text}.`);
  return devoiced;
}

export interface ParsedPhraseBody {
  readonly moras: readonly NotationMora[];
  readonly accent: number;
  readonly explicitAccent: boolean;
}

export function parsePhraseBody(phrase: string, path: string): ParsedPhraseBody {
  const chars = Array.from(phrase);
  const moras: NotationMora[] = [];
  let accent: number | undefined;
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (char === ACCENT) {
      if (moras.length === 0) invalid(path, `An accent mark cannot start a phrase: ${phrase}.`);
      if (accent !== undefined) invalid(path, `A phrase can carry only one accent mark: ${phrase}.`);
      accent = moras.length;
      index += 1;
      continue;
    }
    if (isLongVowelMark(char)) {
      const previous = moras.at(-1);
      if (previous === undefined || previous.vowel === "cl" || previous.vowel === "pau") {
        invalid(path, `A long-vowel mark must follow a voiced mora: ${phrase}.`);
      }
      moras.push({ text: LONG_VOWEL, consonant: null, vowel: previous.vowel });
      index += 1;
      continue;
    }
    const devoiced = char === UNVOICE;
    const start = devoiced ? index + 1 : index;
    const head = chars[start];
    const pair = head === undefined ? "" : head + (chars[start + 1] ?? "");
    const twoChar = chars.length > start + 1 && chars[start + 1] !== ACCENT ? lookupMora(pair) : undefined;
    const match = twoChar ?? (head === undefined ? undefined : lookupMora(head));
    const text = twoChar === undefined ? (head ?? "") : pair;
    if (match === undefined || head === undefined) {
      invalid(
        path,
        `Unrecognized reading ${JSON.stringify(chars.slice(index, index + 2).join(""))} in phrase ${JSON.stringify(phrase)}.`,
        "Write readings in kana; separate accent phrases with / and mark the accent nucleus with '.",
      );
    }
    moras.push({
      text,
      consonant: match.consonant,
      vowel: devoiced ? unvoice(match.vowel, path, text) : match.vowel,
    });
    index = start + Array.from(text).length;
  }
  return { moras, accent: accent ?? 0, explicitAccent: accent !== undefined };
}

export interface ParseNotationOptions {
  readonly requireAccent?: boolean;
}

export function parseKanaNotation(
  text: string,
  path: string = "$.kana",
  options: ParseNotationOptions = {},
): readonly AccentPhrase[] {
  const normalized = toKatakana(text)
    .replaceAll("?", QUESTION)
    .replaceAll("!", EXCLAMATION)
    .replaceAll(",", PAUSE)
    .replaceAll("．", SENTENCE)
    .replaceAll(".", SENTENCE)
    .replaceAll("‐", "-")
    .replaceAll(/\s+/gu, "");
  if (normalized.length === 0) invalid(path, "Kana notation must not be empty.");
  const phrases: AccentPhrase[] = [];
  const chars = Array.from(normalized);
  let start = 0;
  let index = 0;
  while (index <= chars.length) {
    const char = chars[index];
    const boundary = char === undefined ? "end" : BOUNDARY_CHARS.get(char);
    if (boundary === undefined) {
      index += 1;
      continue;
    }
    const phrasePath = `${path}[${phrases.length}]`;
    const raw = chars.slice(start, index).join("");
    if (raw.length === 0) {
      if (boundary === "end") break;
      const last = phrases.at(-1);
      if (last === undefined) invalid(phrasePath, `Accent phrase ${phrases.length + 1} is empty.`);
      if (last.boundary === "end" || last.boundary === "phrase") {
        invalid(phrasePath, `Accent phrase ${phrases.length + 1} is empty.`);
      }
      const merged = strongerBoundary(last.boundary, boundary);
      phrases[phrases.length - 1] = {
        ...last,
        boundary: merged,
        pause: merged !== "phrase",
        interrogative: last.interrogative || boundary === "question",
        exclamatory: last.exclamatory || boundary === "exclamation",
      };
      start = index + 1;
      index += 1;
      continue;
    }
    const parsed = parsePhraseBody(raw, phrasePath);
    if (options.requireAccent === true && !parsed.explicitAccent) {
      invalid(
        phrasePath,
        `Every accent phrase needs exactly one accent mark: ${raw}.`,
        "Example: コンニチワ' or ズ'ンダモン.",
      );
    }
    if (parsed.moras.length === 0) invalid(phrasePath, `Accent phrase ${phrases.length + 1} is empty.`);
    phrases.push({
      moras: parsed.moras,
      accent: parsed.accent,
      boundary,
      pause: boundary !== "phrase" && boundary !== "end",
      interrogative: boundary === "question",
      exclamatory: boundary === "exclamation",
    });
    start = index + 1;
    index += 1;
  }
  if (phrases.length === 0) invalid(path, "Kana notation contains no readable moras.");
  return phrases;
}

const BOUNDARY_STRENGTH: Readonly<Record<BoundaryKind, number>> = {
  phrase: 0,
  end: 1,
  pause: 2,
  sentence: 3,
  exclamation: 4,
  question: 5,
  paragraph: 6,
};

export function strongerBoundary(a: BoundaryKind, b: BoundaryKind): BoundaryKind {
  return BOUNDARY_STRENGTH[a] >= BOUNDARY_STRENGTH[b] ? a : b;
}

export function formatPhraseBody(moras: readonly NotationMora[], accent: number): string {
  let text = "";
  for (const [moraIndex, mora] of moras.entries()) {
    if (isUnvoicedVowel(mora.vowel) && mora.text !== LONG_VOWEL) text += UNVOICE;
    text += mora.text;
    if (moraIndex + 1 === accent) text += ACCENT;
  }
  return text;
}

export function formatKanaNotation(phrases: readonly AccentPhrase[]): string {
  let text = "";
  for (const [index, phrase] of phrases.entries()) {
    text += formatPhraseBody(phrase.moras, phrase.accent);
    const last = index === phrases.length - 1;
    const boundary = last && phrase.boundary === "phrase" ? "end" : phrase.boundary;
    text += BOUNDARY_TEXT[boundary];
  }
  return text;
}

export function phraseText(phrase: AccentPhrase): string {
  return phrase.moras.map((mora) => mora.text).join("");
}

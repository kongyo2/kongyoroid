import { invalid } from "./errors.ts";
import type { Consonant, UnvoicedVowel, Vowel } from "./mora.ts";
import { lookupMora, toKatakana } from "./mora.ts";

export interface NotationMora {
  readonly text: string;
  readonly consonant: Consonant | null;
  readonly vowel: Vowel | UnvoicedVowel;
}

export interface AccentPhrase {
  readonly moras: readonly NotationMora[];
  readonly accent: number;
  readonly pause: boolean;
  readonly interrogative: boolean;
}

const ACCENT = "'";
const UNVOICE = "_";
const PHRASE = "/";
const PAUSE = "、";

const DEVOICED: Readonly<Record<"a" | "i" | "u" | "e" | "o", UnvoicedVowel>> = {
  a: "A",
  i: "I",
  u: "U",
  e: "E",
  o: "O",
};

function unvoice(vowel: Vowel, path: string, text: string): UnvoicedVowel {
  if (vowel === "N" || vowel === "cl" || vowel === "pau") {
    return invalid(path, `Only vowels can be devoiced with "_": ${text}.`);
  }
  return DEVOICED[vowel];
}

function parsePhrase(phrase: string, path: string): Omit<AccentPhrase, "pause" | "interrogative"> {
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
        "Write readings in katakana; separate accent phrases with / and mark the accent nucleus with '.",
      );
    }
    moras.push({
      text,
      consonant: match.consonant,
      vowel: devoiced ? unvoice(match.vowel, path, text) : match.vowel,
    });
    index = start + Array.from(text).length;
  }
  if (accent === undefined) {
    invalid(
      path,
      `Every accent phrase needs exactly one accent mark: ${phrase}.`,
      "Example: コンニチワ' or ズ'ンダモン.",
    );
  }
  return { moras, accent };
}

export function parseKanaNotation(text: string, path: string = "$.kana"): readonly AccentPhrase[] {
  const normalized = toKatakana(text).replaceAll("?", "？").replaceAll(",", PAUSE).replaceAll(/\s+/gu, "");
  if (normalized.length === 0) invalid(path, "Kana notation must not be empty.");
  const phrases: AccentPhrase[] = [];
  let start = 0;
  const chars = Array.from(normalized);
  for (let index = 0; index <= chars.length; index++) {
    const char = chars[index];
    if (index < chars.length && char !== PHRASE && char !== PAUSE) continue;
    const phrasePath = `${path}[${phrases.length}]`;
    const raw = chars.slice(start, index).join("");
    if (raw.length === 0) invalid(phrasePath, `Accent phrase ${phrases.length + 1} is empty.`);
    start = index + 1;
    const interrogative = raw.includes("？");
    if (interrogative && raw.indexOf("？") !== raw.length - 1) {
      invalid(phrasePath, `A question mark may only end an accent phrase: ${raw}.`);
    }
    const body = interrogative ? raw.slice(0, -1) : raw;
    if (body.length === 0) invalid(phrasePath, `Accent phrase ${phrases.length + 1} is empty.`);
    const parsed = parsePhrase(body, phrasePath);
    phrases.push({ ...parsed, pause: char === PAUSE, interrogative });
  }
  return phrases;
}

export function formatKanaNotation(phrases: readonly AccentPhrase[]): string {
  let text = "";
  for (const [index, phrase] of phrases.entries()) {
    for (const [moraIndex, mora] of phrase.moras.entries()) {
      if (mora.vowel === mora.vowel.toUpperCase() && mora.vowel !== "N" && mora.vowel.length === 1) text += UNVOICE;
      text += mora.text;
      if (moraIndex + 1 === phrase.accent) text += ACCENT;
    }
    if (phrase.interrogative) text += "？";
    if (index < phrases.length - 1) text += phrase.pause ? PAUSE : PHRASE;
  }
  return text;
}

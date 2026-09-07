import type { Diagnostic, SourceSpan } from "../errors.ts";
import type { Consonant, UnvoicedVowel, Vowel } from "./mora.ts";
import type { AccentPhrase, BoundaryKind } from "./notation.ts";
import { formatKanaNotation } from "./notation.ts";

export type AccentSource = "user" | "dictionary" | "lexicon" | "frontend" | "rule";
export type FrontendKind = "notation" | "kana" | "jpreprocess" | "heuristic";

export interface ReadingMora {
  readonly text: string;
  readonly consonant: Consonant | null;
  readonly vowel: Vowel | UnvoicedVowel;
}

export interface ReadingPhrase {
  readonly moras: readonly ReadingMora[];
  readonly accent: number;
  readonly boundary: BoundaryKind;
  readonly interrogative: boolean;
  readonly exclamatory: boolean;
  readonly accentSource: AccentSource;
  readonly sentence: number;
}

export interface SentenceReading {
  readonly text: string;
  readonly normalized: string;
  readonly kana: string;
  readonly sourceSpan: SourceSpan;
  readonly phraseStart: number;
  readonly phraseEnd: number;
  readonly paragraphEnd: boolean;
}

export interface ReadingPlan {
  readonly text: string;
  readonly kana: string;
  readonly frontend: FrontendKind;
  readonly phrases: readonly ReadingPhrase[];
  readonly sentences: readonly SentenceReading[];
  readonly warnings: readonly Diagnostic[];
  readonly moraCount: number;
  readonly dictionaryHits: readonly DictionaryHit[];
}

export interface DictionaryHit {
  readonly surface: string;
  readonly reading: string;
  readonly accent: number | null;
  readonly entryId: string | undefined;
  readonly source: "dictionary" | "lexicon";
  readonly sourceSpan: SourceSpan;
  readonly applied: boolean;
}

export function toAccentPhrase(phrase: ReadingPhrase): AccentPhrase {
  return {
    moras: phrase.moras,
    accent: phrase.accent,
    boundary: phrase.boundary,
    pause: phrase.boundary !== "phrase" && phrase.boundary !== "end",
    interrogative: phrase.interrogative,
    exclamatory: phrase.exclamatory,
  };
}

export function readingPhrasesFromNotation(
  phrases: readonly AccentPhrase[],
  accentSource: AccentSource,
  sentence: number,
): ReadingPhrase[] {
  return phrases.map((phrase) => ({
    moras: phrase.moras,
    accent: phrase.accent,
    boundary: phrase.boundary,
    interrogative: phrase.interrogative,
    exclamatory: phrase.exclamatory,
    accentSource,
    sentence,
  }));
}

export function readingKana(phrases: readonly ReadingPhrase[]): string {
  return formatKanaNotation(phrases.map(toAccentPhrase));
}

export function countReadingMoras(phrases: readonly ReadingPhrase[]): number {
  let count = 0;
  for (const phrase of phrases) count += phrase.moras.length;
  return count;
}

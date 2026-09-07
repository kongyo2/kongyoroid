import type { Diagnostic, SourceSpan } from "../errors.ts";
import { KongyoroidError, checkAbort, invalid } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { FRONTEND_VERSION } from "../version.ts";
import type { LocalDictionary } from "./dictionary.ts";
import { isSpelledReading } from "./lexicon.ts";
import type { Consonant, KanaUnit, Vowel } from "./mora.ts";
import { countMoras, devoicedVowelOf, isUnvoicedVowel, kanaToMoras, kanaToUnits, voicedVowelOf } from "./mora.ts";
import type { AccentPhrase, BoundaryKind } from "./notation.ts";
import { parseKanaNotation, strongerBoundary } from "./notation.ts";
import type { SubstitutionHit } from "./normalize.ts";
import { normalizeForReading } from "./normalize.ts";
import type {
  DictionaryHit,
  FrontendKind,
  ReadingMora,
  ReadingPhrase,
  ReadingPlan,
  SentenceReading,
} from "./reading.ts";
import { countReadingMoras, readingKana, readingPhrasesFromNotation } from "./reading.ts";
import { splitSentences } from "./sentences.ts";

export interface TextFrontend {
  readonly name: string;
  readonly version: string;
  convert(sentence: string): string;
}

export type FrontendState = "unloaded" | "loading" | "ready" | "failed";

let frontendPromise: Promise<TextFrontend> | undefined;
let state: FrontendState = "unloaded";
let failure: KongyoroidError | undefined;

function frontendUnavailable(cause: unknown): KongyoroidError {
  return new KongyoroidError(
    {
      code: "FRONTEND_UNAVAILABLE",
      message: `The Japanese text frontend could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
      retryable: false,
      hint: "Reinstall the package (the kanji2koe-openjtalk dependency is missing or broken), or pass the reading as kana.",
      repairOptions: [
        {
          action: "provide-kana",
          description: "Pass the pronunciation in the kana field instead of relying on text analysis.",
        },
      ],
    },
    cause,
  );
}

export function loadFrontend(): Promise<TextFrontend> {
  if (frontendPromise !== undefined) return frontendPromise;
  state = "loading";
  frontendPromise = (async (): Promise<TextFrontend> => {
    try {
      const module = await import("kanji2koe-openjtalk");
      const converter = await module.load();
      state = "ready";
      return {
        name: "jpreprocess",
        version: FRONTEND_VERSION,
        convert: (sentence: string): string => converter.convert(sentence),
      };
    } catch (error) {
      state = "failed";
      failure = frontendUnavailable(error);
      frontendPromise = undefined;
      throw failure;
    }
  })();
  return frontendPromise;
}

export function frontendState(): { readonly state: FrontendState; readonly error: KongyoroidError | undefined } {
  return { state, error: failure };
}

export interface ReadOptions {
  readonly dictionary?: LocalDictionary;
  readonly strict?: boolean;
  readonly lexicon?: boolean;
  readonly signal?: AbortSignal;
  readonly frontend?: TextFrontend;
  readonly path?: string;
}

const UNREADABLE_SCRIPT =
  /[\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Armenian}\p{Script=Georgian}]/u;
const HAN = /\p{Script=Han}/u;

function moraKey(mora: ReadingMora): string {
  return `${mora.consonant ?? ""}${voicedVowelOf(mora.vowel)}`;
}

function unitKey(unit: Extract<KanaUnit, { kind: "mora" }>): string {
  return `${unit.consonant ?? ""}${unit.vowel}`;
}

interface FlatMora {
  readonly mora: ReadingMora;
  readonly phrase: number;
}

function notationMoraCount(output: string): number | undefined {
  try {
    return countMoras(output.replaceAll(/['/_、。？！\s]/gu, ""));
  } catch {
    return undefined;
  }
}

function frontendAccentIsPlausible(phrase: ReadingPhrase): boolean {
  if (phrase.accent <= 0) return false;
  const nucleus = phrase.moras[phrase.accent - 1];
  if (nucleus === undefined) return false;
  return nucleus.text !== "ー" && nucleus.vowel !== "N" && nucleus.vowel !== "cl";
}

function matchesAt(flat: readonly FlatMora[], start: number, keys: readonly string[]): boolean {
  for (let k = 0; k < keys.length; k++) {
    const entry = flat[start + k];
    if (entry === undefined || moraKey(entry.mora) !== keys[k]) return false;
  }
  return true;
}

function applyDictionaryAccents(
  phrases: ReadingPhrase[],
  hits: readonly SubstitutionHit[],
  dictionaryHits: DictionaryHit[],
  expectedOffsetOf: (hit: SubstitutionHit) => number | undefined,
): ReadingPhrase[] {
  let current = phrases;
  let searchFrom = 0;
  for (const hit of hits) {
    const accent = hit.accent;
    const keys = kanaToMoras(hit.reading).map(unitKey);
    const flat: FlatMora[] = [];
    for (const [phraseIndex, phrase] of current.entries()) {
      for (const mora of phrase.moras) flat.push({ mora, phrase: phraseIndex });
    }
    const candidates: number[] = [];
    for (let start = 0; start + keys.length <= flat.length; start++) {
      if (matchesAt(flat, start, keys)) candidates.push(start);
    }
    const expected = expectedOffsetOf(hit);
    let found = -1;
    if (candidates.length > 0) {
      const ordered = [...candidates].sort((a, b) => {
        if (expected !== undefined) {
          const distance = Math.abs(a - expected) - Math.abs(b - expected);
          if (distance !== 0) return distance;
        }
        const aAhead = a >= searchFrom ? 0 : 1;
        const bAhead = b >= searchFrom ? 0 : 1;
        return aAhead - bAhead || a - b;
      });
      found = ordered[0] ?? -1;
    }
    const record: DictionaryHit = {
      surface: hit.surface,
      reading: hit.reading,
      accent,
      entryId: hit.id,
      source: hit.source,
      sourceSpan: hit.sourceSpan,
      applied: found >= 0,
    };
    dictionaryHits.push(record);
    if (found < 0) continue;
    const end = found + keys.length;
    searchFrom = end;
    if (accent === null) continue;
    const firstPhraseIndex = flat[found]?.phrase ?? 0;
    const lastPhraseIndex = flat[end - 1]?.phrase ?? firstPhraseIndex;
    const firstPhrase = current[firstPhraseIndex];
    const lastPhrase = current[lastPhraseIndex];
    if (firstPhrase === undefined || lastPhrase === undefined) continue;
    if (hit.source === "lexicon" && firstPhraseIndex === lastPhraseIndex && frontendAccentIsPlausible(firstPhrase)) {
      if (!isSpelledReading(hit.reading)) continue;
    }
    let offsetInFirst = 0;
    for (let k = 0; k < found; k++) if (flat[k]?.phrase === firstPhraseIndex) offsetInFirst += 1;
    let consumedInLast = 0;
    for (let k = found; k < end; k++) if (flat[k]?.phrase === lastPhraseIndex) consumedInLast += 1;
    const before = firstPhrase.moras.slice(0, offsetInFirst);
    const after = lastPhrase.moras.slice(consumedInLast);
    const middle: ReadingMora[] = [];
    for (let k = found; k < end; k++) {
      const flatMora = flat[k];
      if (flatMora !== undefined) middle.push(flatMora.mora);
    }
    const rebuilt: ReadingPhrase[] = [];
    if (before.length > 0) {
      rebuilt.push({
        ...firstPhrase,
        moras: before,
        accent: firstPhrase.accent > 0 && firstPhrase.accent <= before.length ? firstPhrase.accent : 0,
        boundary: "phrase",
        interrogative: false,
        exclamatory: false,
      });
    }
    rebuilt.push({
      moras: [...middle, ...after],
      accent,
      boundary: lastPhrase.boundary,
      interrogative: lastPhrase.interrogative,
      exclamatory: lastPhrase.exclamatory,
      accentSource: hit.source === "lexicon" ? "lexicon" : "dictionary",
      sentence: firstPhrase.sentence,
    });
    current = [...current.slice(0, firstPhraseIndex), ...rebuilt, ...current.slice(lastPhraseIndex + 1)];
  }
  return current;
}

function unreadableRuns(
  frontend: TextFrontend,
  normalized: string,
  map: readonly number[],
  full: string,
): { readonly surface: string; readonly span: SourceSpan }[] {
  const chars = Array.from(normalized);
  const flags: boolean[] = new Array<boolean>(chars.length).fill(false);
  for (const [index, char] of chars.entries()) {
    if (
      !HAN.test(char) &&
      !UNREADABLE_SCRIPT.test(char) &&
      !(/\p{L}/u.test(char) && !/[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char))
    ) {
      continue;
    }
    const without = [...chars.slice(0, index), ...chars.slice(index + 1)].join("");
    if (frontend.convert(without) === full) flags[index] = true;
  }
  const runs: { readonly surface: string; readonly span: SourceSpan }[] = [];
  let index = 0;
  while (index < chars.length) {
    if (flags[index] !== true) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < chars.length && flags[end] === true) end += 1;
    runs.push({
      surface: chars.slice(index, end).join(""),
      span: { start: map[index] ?? 0, end: (map[end - 1] ?? map[index] ?? 0) + 1, unit: "unicode-code-point" },
    });
    index = end;
  }
  return runs;
}

function terminalBoundary(terminal: string, paragraphEnd: boolean): BoundaryKind {
  if (terminal === "？") return "question";
  if (terminal === "！") return "exclamation";
  if (paragraphEnd) return "paragraph";
  return "sentence";
}

function applyTerminal(phrases: ReadingPhrase[], boundary: BoundaryKind, paragraphEnd: boolean): ReadingPhrase[] {
  const last = phrases.at(-1);
  if (last === undefined) return phrases;
  const merged = strongerBoundary(
    last.boundary === "end" || last.boundary === "sentence" ? "sentence" : last.boundary,
    boundary,
  );
  const finalBoundary = paragraphEnd && merged === "sentence" ? "paragraph" : merged;
  phrases[phrases.length - 1] = {
    ...last,
    boundary: finalBoundary,
    interrogative: last.interrogative || finalBoundary === "question",
    exclamatory: last.exclamatory || finalBoundary === "exclamation",
  };
  return phrases;
}

export async function readJapanese(text: string, options: ReadOptions = {}): Promise<ReadingPlan> {
  const path = options.path ?? "$.text";
  const frontend = options.frontend ?? (await loadFrontend());
  checkAbort(options.signal);
  const strict = options.strict !== false;
  const pieces = splitSentences(text);
  const phrases: ReadingPhrase[] = [];
  const sentences: SentenceReading[] = [];
  const warnings: Diagnostic[] = [];
  const dictionaryHits: DictionaryHit[] = [];
  const substitutions = options.dictionary?.substitutions() ?? [];
  for (const [sentenceIndex, piece] of pieces.entries()) {
    checkAbort(options.signal);
    const normalized = normalizeForReading(piece.text, {
      substitutions,
      lexicon: options.lexicon !== false,
      sourceOffset: piece.sourceSpan.start,
    });
    warnings.push(...normalized.diagnostics);
    const trimmed = normalized.text.trim();
    if (trimmed.length === 0) continue;
    let output: string;
    try {
      output = frontend.convert(trimmed);
    } catch (error) {
      throw new KongyoroidError(
        {
          code: "FRONTEND_UNAVAILABLE",
          message: `The text frontend failed on sentence ${sentenceIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          path,
          sourceSpan: piece.sourceSpan,
        },
        error,
      );
    }
    const runs = unreadableRuns(frontend, trimmed, normalized.map, output);
    if (runs.length > 0) {
      const first = runs[0];
      if (strict && first !== undefined) {
        invalid(
          path,
          `Unreadable text ${JSON.stringify(first.surface)}: the frontend has no reading for it and would drop it silently.`,
          {
            code: "UNREADABLE_TEXT",
            hint: "Give the reading in kana, add a dictionary entry with surface and reading, or remove the characters.",
            sourceSpan: first.span,
            surface: first.surface,
            detail: { unreadable: runs.map((run) => ({ surface: run.surface, sourceSpan: run.span })) },
            repairOptions: [
              {
                action: "provide-kana",
                description: "Pass the whole pronunciation in the kana field.",
                path: "$.kana",
              },
              {
                action: "add-dictionary-entry",
                description: `Add a dictionary entry { surface: ${JSON.stringify(first.surface)}, reading: <katakana> }.`,
                path: "$.dictionary",
              },
              {
                action: "remove-characters",
                description: "Remove or rewrite the unreadable characters in text.",
                path,
              },
            ],
          },
        );
      }
      for (const run of runs) {
        warnings.push({
          severity: "warning",
          code: "UNREADABLE_TEXT_SKIPPED",
          message: `Unreadable text ${JSON.stringify(run.surface)} was skipped.`,
          help: "Give the reading in kana or add a dictionary entry.",
          sourceSpan: run.span,
          surface: run.surface,
          path,
        });
      }
    }
    const notation = output.replace(/[。]+$/u, "");
    let sentencePhrases: ReadingPhrase[];
    if (notation.length === 0 || !/[ぁ-ゖァ-ヶー]/u.test(notation)) {
      continue;
    }
    try {
      sentencePhrases = readingPhrasesFromNotation(parseKanaNotation(notation, path), "frontend", sentenceIndex);
    } catch (error) {
      throw new KongyoroidError(
        {
          code: "INTERNAL",
          message: `The frontend produced notation the parser could not read (${JSON.stringify(notation)}): ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          path,
          sourceSpan: piece.sourceSpan,
        },
        error,
      );
    }
    const normalizedChars = Array.from(normalized.text);
    let leading = 0;
    while (leading < normalizedChars.length && (normalizedChars[leading] ?? "").trim().length === 0) leading += 1;
    const prefixCounts = new Map<string, number | undefined>();
    const expectedOffsetOf = (hit: SubstitutionHit): number | undefined => {
      const prefix = normalizedChars.slice(leading, hit.normalizedStart).join("").trim();
      if (prefix.length === 0) return 0;
      if (prefixCounts.has(prefix)) return prefixCounts.get(prefix);
      let count: number | undefined;
      try {
        count = notationMoraCount(frontend.convert(prefix));
      } catch {
        count = undefined;
      }
      prefixCounts.set(prefix, count);
      return count;
    };
    sentencePhrases = applyDictionaryAccents(sentencePhrases, normalized.hits, dictionaryHits, expectedOffsetOf);
    sentencePhrases = applyTerminal(
      sentencePhrases,
      terminalBoundary(piece.terminal, piece.paragraphEnd),
      piece.paragraphEnd,
    );
    const phraseStart = phrases.length;
    phrases.push(...sentencePhrases);
    sentences.push({
      text: piece.text,
      normalized: trimmed,
      kana: readingKana(sentencePhrases),
      sourceSpan: piece.sourceSpan,
      phraseStart,
      phraseEnd: phrases.length,
      paragraphEnd: piece.paragraphEnd,
    });
  }
  if (phrases.length === 0) {
    invalid(path, "Text contains nothing readable.", {
      hint: "Give Japanese text (kanji or kana). Symbols and emoji alone produce no speech.",
      repairOptions: [{ action: "provide-kana", description: "Pass a kana reading.", path: "$.kana" }],
    });
  }
  const last = phrases.at(-1);
  if (last !== undefined && (last.boundary === "phrase" || last.boundary === "end")) {
    phrases[phrases.length - 1] = { ...last, boundary: "sentence" };
  }
  return {
    text,
    kana: readingKana(phrases),
    frontend: "jpreprocess",
    phrases,
    sentences,
    warnings,
    moraCount: countReadingMoras(phrases),
    dictionaryHits,
  };
}

const VOICELESS: ReadonlySet<Consonant> = new Set([
  "k",
  "ky",
  "kw",
  "s",
  "sh",
  "t",
  "ty",
  "ch",
  "ts",
  "h",
  "hy",
  "f",
  "p",
  "py",
]);

export function applyDevoicingRules(phrases: readonly AccentPhrase[]): AccentPhrase[] {
  const all: { phrase: number; mora: number; consonant: Consonant | null; vowel: Vowel | ReadingMora["vowel"] }[] = [];
  for (const [phraseIndex, phrase] of phrases.entries()) {
    for (const [moraIndex, mora] of phrase.moras.entries()) {
      all.push({ phrase: phraseIndex, mora: moraIndex, consonant: mora.consonant, vowel: mora.vowel });
    }
  }
  const out = phrases.map((phrase) => ({ ...phrase, moras: [...phrase.moras] }));
  const devoicedFlags: boolean[] = all.map((entry) => isUnvoicedVowel(entry.vowel));
  for (const [index, current] of all.entries()) {
    if (current.vowel !== "i" && current.vowel !== "u") continue;
    if (current.consonant === null || !VOICELESS.has(current.consonant)) continue;
    const next = all[index + 1];
    const phrase = out[current.phrase];
    if (phrase === undefined) continue;
    const isFinal = next === undefined || next.phrase !== current.phrase;
    const nextVoiceless = next !== undefined && next.consonant !== null && VOICELESS.has(next.consonant);
    const previousDevoiced = index > 0 && devoicedFlags[index - 1] === true;
    if (previousDevoiced) continue;
    const nucleus = phrase.accent === current.mora + 1;
    if (nucleus) continue;
    const sentenceFinal = isFinal && (phrase.boundary !== "phrase" || out[current.phrase + 1] === undefined);
    if (nextVoiceless || (sentenceFinal && current.vowel === "u")) {
      const devoiced = devoicedVowelOf(current.vowel);
      const mora = phrase.moras[current.mora];
      if (devoiced !== undefined && mora !== undefined) {
        phrase.moras[current.mora] = { ...mora, vowel: devoiced };
        devoicedFlags[index] = true;
      }
    }
  }
  return out;
}

export interface KanaReadOptions {
  readonly devoicing?: boolean;
  readonly path?: string;
  readonly frontend?: FrontendKind;
}

export function readKanaNotation(kana: string, options: KanaReadOptions = {}): ReadingPlan {
  const path = options.path ?? "$.kana";
  let parsed = parseKanaNotation(kana, path);
  const explicitDevoicing = kana.includes("_");
  if (options.devoicing !== false && !explicitDevoicing) parsed = applyDevoicingRules(parsed);
  const source = parsed.some((phrase) => phrase.accent > 0) ? "user" : "rule";
  let phrases = readingPhrasesFromNotation(parsed, source, 0);
  const last = phrases.at(-1);
  if (last !== undefined && (last.boundary === "phrase" || last.boundary === "end")) {
    phrases = [...phrases.slice(0, -1), { ...last, boundary: "sentence" }];
  }
  return {
    text: kana,
    kana: readingKana(phrases),
    frontend: options.frontend ?? "notation",
    phrases,
    sentences: [
      {
        text: kana,
        normalized: kana,
        kana: readingKana(phrases),
        sourceSpan: { start: 0, end: Array.from(kana).length, unit: "unicode-code-point" },
        phraseStart: 0,
        phraseEnd: phrases.length,
        paragraphEnd: false,
      },
    ],
    warnings: [],
    moraCount: countReadingMoras(phrases),
    dictionaryHits: [],
  };
}

export function readKanaHeuristically(text: string, path: string = "$.text"): ReadingPlan {
  const units = kanaToUnits(text, path);
  const phrases: ReadingPhrase[] = [];
  let moras: ReadingMora[] = [];
  const flush = (boundary: BoundaryKind): void => {
    if (moras.length === 0) {
      const last = phrases.at(-1);
      if (last !== undefined && boundary !== "phrase") {
        phrases[phrases.length - 1] = { ...last, boundary: strongerBoundary(last.boundary, boundary) };
      }
      return;
    }
    phrases.push({
      moras,
      accent: 0,
      boundary,
      interrogative: boundary === "question",
      exclamatory: boundary === "exclamation",
      accentSource: "rule",
      sentence: 0,
    });
    moras = [];
  };
  for (const unit of units) {
    if (unit.kind === "pause") {
      const boundary: BoundaryKind =
        unit.text === "?" || unit.text === "？"
          ? "question"
          : unit.text === "!" || unit.text === "！"
            ? "exclamation"
            : unit.weight >= 2
              ? "sentence"
              : "pause";
      flush(boundary);
      continue;
    }
    moras.push({ text: unit.text, consonant: unit.consonant, vowel: unit.vowel });
    if (moras.length >= 8) flush("phrase");
  }
  flush("sentence");
  if (phrases.length === 0) invalid(path, "Text contains no readable kana.");
  const devoiced = applyDevoicingRules(phrases.map((phrase) => ({ ...phrase, pause: phrase.boundary !== "phrase" })));
  const finalPhrases = phrases.map((phrase, index) => ({ ...phrase, moras: devoiced[index]?.moras ?? phrase.moras }));
  return {
    text,
    kana: readingKana(finalPhrases),
    frontend: "heuristic",
    phrases: finalPhrases,
    sentences: [
      {
        text,
        normalized: text,
        kana: readingKana(finalPhrases),
        sourceSpan: { start: 0, end: Array.from(text).length, unit: "unicode-code-point" },
        phraseStart: 0,
        phraseEnd: finalPhrases.length,
        paragraphEnd: false,
      },
    ],
    warnings: [
      {
        severity: "advice",
        code: "HEURISTIC_READING",
        message:
          "The text was read as plain kana without word analysis; accents are flat and は/へ are read literally.",
        help: "Pass ordinary Japanese text with the frontend available, or give accent notation in kana.",
        path,
      },
    ],
    moraCount: countReadingMoras(finalPhrases),
    dictionaryHits: [],
  };
}

export function readingPlanLimits(plan: ReadingPlan, path: string = "$.text"): void {
  if (plan.moraCount > LIMITS.textChars)
    invalid(path, `The reading has ${plan.moraCount} moras; the limit is ${LIMITS.textChars}.`);
}

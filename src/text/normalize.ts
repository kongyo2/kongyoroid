import type { Diagnostic, SourceSpan } from "../errors.ts";
import { LEXICON_MAX_WORDS, lookupLexicon } from "./lexicon.ts";
import { toKatakana } from "./mora.ts";

export interface Substitution {
  readonly surface: string;
  readonly reading: string;
  readonly id?: string;
  readonly accent?: number | null;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
}

export type SubstitutionSource = "dictionary" | "lexicon";

export interface SubstitutionHit {
  readonly surface: string;
  readonly reading: string;
  readonly id: string | undefined;
  readonly accent: number | null;
  readonly source: SubstitutionSource;
  readonly sourceSpan: SourceSpan;
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
  readonly order: number;
}

export interface NormalizeOptions {
  readonly substitutions?: readonly Substitution[];
  readonly lexicon?: boolean;
  readonly sourceOffset?: number;
}

export interface NormalizedText {
  readonly text: string;
  readonly map: readonly number[];
  readonly diagnostics: readonly Diagnostic[];
  readonly hits: readonly SubstitutionHit[];
}

const URL_PATTERN = /^(?:https?:\/\/|www\.)[^\s　「」『』（）()<>"'。、！？]+/u;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u;
const DATE_PATTERN = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?![\d/.-])/u;
const MONTH_DAY_PATTERN = /^(\d{1,2})\/(\d{1,2})(?![\d/])/u;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/u;
const VERSION_PATTERN = /^[vV](\d+(?:\.\d+)*)(?![\d.])/u;
const DOTTED_NUMBER_PATTERN = /^(\d+(?:\.\d+){2,})(?![\d.])/u;
const NUMBER_PATTERN = /^\d+(?:,\d{3})*(?:\.\d+)?/u;
const RANGE_PATTERN = /^\s*[~〜～]\s*(?=\d)/u;
const HASH_NUMBER_PATTERN = /^#(\d+)(?!\d)/u;
const WORD_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[+#.'’-][A-Za-z0-9]+)*(?:\+\+|#)?/u;
const UNIT_PATTERN =
  /^(ms|msec|sec|min|hrs|hr|km|cm|mm|kg|mg|kb|mb|gb|tb|khz|mhz|ghz|hz|px|pt|fps|bpm|db|ml|kl|kcal|cal|nm|ns|us|µs|s|m|g|h|l|x|b)(?![A-Za-z])/iu;

const UNIT_READINGS: Readonly<Record<string, string>> = {
  ms: "ミリ秒",
  msec: "ミリ秒",
  sec: "秒",
  s: "秒",
  min: "分",
  h: "時間",
  hr: "時間",
  hrs: "時間",
  km: "キロメートル",
  cm: "センチメートル",
  mm: "ミリメートル",
  m: "メートル",
  nm: "ナノメートル",
  kg: "キログラム",
  mg: "ミリグラム",
  g: "グラム",
  l: "リットル",
  ml: "ミリリットル",
  kl: "キロリットル",
  kcal: "キロカロリー",
  cal: "カロリー",
  kb: "キロバイト",
  mb: "メガバイト",
  gb: "ギガバイト",
  tb: "テラバイト",
  b: "バイト",
  hz: "ヘルツ",
  khz: "キロヘルツ",
  mhz: "メガヘルツ",
  ghz: "ギガヘルツ",
  px: "ピクセル",
  pt: "ポイント",
  fps: "エフピーエス",
  bpm: "ビーピーエム",
  db: "デシベル",
  ns: "ナノ秒",
  us: "マイクロ秒",
  µs: "マイクロ秒",
  x: "倍",
};

const SYMBOL_READINGS: Readonly<Record<string, string>> = {
  "&": "アンド",
  "@": "アットマーク",
  "=": "イコール",
  "×": "かける",
  "÷": "わる",
  "±": "プラスマイナス",
  "→": "から",
  "‰": "パーミル",
  "°": "度",
  "℃": "度",
  "℉": "度エフ",
  "€": "ユーロ",
  "£": "ポンド",
  "%": "パーセント",
  "％": "パーセント",
  "℡": "電話",
  "№": "ナンバー",
};

const URL_SYMBOLS: Readonly<Record<string, string>> = {
  ".": "ドット",
  "/": "スラッシュ",
  "-": "ハイフン",
  _: "アンダーバー",
  ":": "コロン",
  "?": "クエスチョン",
  "&": "アンド",
  "=": "イコール",
  "#": "シャープ",
  "@": "アットマーク",
  "%": "パーセント",
  "~": "チルダ",
  "+": "プラス",
};

const CURRENCY_PREFIX: Readonly<Record<string, string>> = {
  "¥": "円",
  "￥": "円",
  $: "ドル",
  "＄": "ドル",
  "€": "ユーロ",
  "£": "ポンド",
};

const MARKDOWN_CHARS: ReadonlySet<string> = new Set(["`", "*", "#", "_", ">", "~"]);

function isAsciiAlnum(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9]$/u.test(char);
}

function isDigitChar(char: string | undefined): boolean {
  return char !== undefined && /^[0-9]$/u.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /^[\s　]$/u.test(char);
}

function isHalfWidthKatakana(code: number): boolean {
  return code >= 0xff66 && code <= 0xff9d;
}

function nfkcWithMap(text: string): { chars: string[]; map: number[] } {
  const source = Array.from(text);
  const chars: string[] = [];
  const map: number[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const code = char.codePointAt(0) ?? 0;
    const next = source[index + 1];
    let piece = char;
    let consumed = 1;
    if (isHalfWidthKatakana(code) && (next === "ﾞ" || next === "ﾟ")) {
      piece = char + next;
      consumed = 2;
    }
    const normalized = piece.normalize("NFKC");
    for (const out of normalized) {
      chars.push(out);
      map.push(index);
    }
    index += consumed;
  }
  return { chars, map };
}

function readNumberDigits(digits: string): string {
  return digits.replaceAll(",", "");
}

function dottedReading(value: string): string {
  return value.split(".").join("テン");
}

class Builder {
  public readonly out: string[] = [];
  public readonly map: number[] = [];
  private readonly offset: number;

  public constructor(offset: number) {
    this.offset = offset;
  }

  public push(text: string, sourceIndex: number): void {
    for (const char of text) {
      this.out.push(char);
      this.map.push(this.offset + sourceIndex);
    }
  }

  public last(): string | undefined {
    return this.out.at(-1);
  }
}

function matchSubstitution(
  chars: readonly string[],
  index: number,
  substitutions: readonly Substitution[],
): Substitution | undefined {
  const previous = chars[index - 1];
  for (const entry of substitutions) {
    const surface = Array.from(entry.surface);
    if (surface.length === 0 || index + surface.length > chars.length) continue;
    let matched = true;
    for (let k = 0; k < surface.length; k++) {
      const a = chars[index + k] ?? "";
      const b = surface[k] ?? "";
      if (entry.caseSensitive === true ? a !== b : a.toLowerCase() !== b.toLowerCase()) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (entry.wholeWord !== false) {
      const first = surface[0];
      const lastChar = surface[surface.length - 1];
      const after = chars[index + surface.length];
      if (isAsciiAlnum(first) && isAsciiAlnum(previous)) continue;
      if (isAsciiAlnum(lastChar) && isAsciiAlnum(after)) continue;
    }
    return entry;
  }
  return undefined;
}

export function normalizeForReading(text: string, options: NormalizeOptions = {}): NormalizedText {
  const { chars, map } = nfkcWithMap(text);
  const offset = options.sourceOffset ?? 0;
  const useLexicon = options.lexicon !== false;
  const substitutions = [...(options.substitutions ?? [])].sort(
    (a, b) => Array.from(b.surface).length - Array.from(a.surface).length,
  );
  const builder = new Builder(offset);
  const diagnostics: Diagnostic[] = [];
  const hits: SubstitutionHit[] = [];
  const spanOf = (from: number, to: number): SourceSpan => ({
    start: offset + (map[from] ?? 0),
    end: offset + ((map[to - 1] ?? map[from] ?? 0) + 1),
    unit: "unicode-code-point",
  });
  let index = 0;
  let order = 0;
  let lineStart = true;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    const sourceIndex = map[index] ?? 0;
    const substitution = matchSubstitution(chars, index, substitutions);
    if (substitution !== undefined) {
      const length = Array.from(substitution.surface).length;
      const reading = toKatakana(substitution.reading);
      const normalizedStart = builder.out.length;
      builder.push(reading, sourceIndex);
      hits.push({
        surface: chars.slice(index, index + length).join(""),
        reading,
        id: substitution.id,
        accent: substitution.accent ?? null,
        source: "dictionary",
        sourceSpan: spanOf(index, index + length),
        normalizedStart,
        normalizedEnd: builder.out.length,
        order: order++,
      });
      index += length;
      lineStart = false;
      continue;
    }
    if (char === "\n") {
      builder.push("、", sourceIndex);
      index += 1;
      lineStart = true;
      continue;
    }
    if (isSpace(char)) {
      let run = index;
      while (run < chars.length && isSpace(chars[run])) run += 1;
      const before = builder.last();
      const after = chars[run];
      if (isAsciiAlnum(before) && isAsciiAlnum(after)) builder.push(" ", sourceIndex);
      index = run;
      continue;
    }
    if (lineStart && (MARKDOWN_CHARS.has(char) || char === "-" || char === "+" || isDigitChar(char))) {
      const marker = /^(?:[#>*_~`-]+|[-*+]|\d{1,2}[.)])[ \t　]+/u.exec(chars.slice(index, index + 12).join(""));
      if (marker !== null) {
        index += Array.from(marker[0]).length;
        continue;
      }
    }
    lineStart = false;
    const rest = chars.slice(index).join("");
    const url = URL_PATTERN.exec(rest);
    if (url !== null) {
      const raw = url[0];
      const stripped = raw.replace(/^https?:\/\//u, "").replace(/^www\./u, "");
      const length = Array.from(raw).length;
      let spoken = "";
      for (const c of stripped) spoken += URL_SYMBOLS[c] === undefined ? c : ` ${URL_SYMBOLS[c]} `;
      builder.push(spoken.replaceAll(/\s+/gu, " ").trim(), sourceIndex);
      diagnostics.push({
        severity: "advice",
        code: "URL_READ_LITERALLY",
        message: `The URL ${JSON.stringify(raw)} is read character by character.`,
        help: "Replace URLs with a short description before synthesis if that is not intended.",
        sourceSpan: spanOf(index, index + length),
        surface: raw,
      });
      index += length;
      continue;
    }
    const email = EMAIL_PATTERN.exec(rest);
    if (email !== null) {
      const raw = email[0];
      const length = Array.from(raw).length;
      let spoken = "";
      for (const c of raw) spoken += URL_SYMBOLS[c] === undefined ? c : ` ${URL_SYMBOLS[c]} `;
      builder.push(spoken.replaceAll(/\s+/gu, " ").trim(), sourceIndex);
      index += length;
      continue;
    }
    if (isDigitChar(char)) {
      const date = DATE_PATTERN.exec(rest);
      if (date !== null) {
        const month = Number(date[2]);
        const day = Number(date[3]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          builder.push(`${date[1]}年${month}月${day}日`, sourceIndex);
          index += date[0].length;
          continue;
        }
      }
      const monthDay = MONTH_DAY_PATTERN.exec(rest);
      if (monthDay !== null && !isDigitChar(chars[index - 1])) {
        const month = Number(monthDay[1]);
        const day = Number(monthDay[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          builder.push(`${month}月${day}日`, sourceIndex);
          index += monthDay[0].length;
          continue;
        }
      }
      const time = TIME_PATTERN.exec(rest);
      if (time !== null) {
        const hour = Number(time[1]);
        const minute = Number(time[2]);
        const second = time[3] === undefined ? undefined : Number(time[3]);
        if (hour <= 24 && minute < 60 && (second === undefined || second < 60)) {
          let spoken = `${hour}時`;
          spoken += minute === 0 && second === undefined ? "" : `${minute}分`;
          if (second !== undefined) spoken += `${second}秒`;
          builder.push(spoken, sourceIndex);
          index += time[0].length;
          continue;
        }
      }
      const dotted = DOTTED_NUMBER_PATTERN.exec(rest);
      if (dotted !== null) {
        builder.push(dottedReading(dotted[1] ?? ""), sourceIndex);
        index += dotted[0].length;
        continue;
      }
      const number = NUMBER_PATTERN.exec(rest);
      if (number !== null) {
        const raw = number[0];
        const afterNumber = rest.slice(raw.length);
        const range = RANGE_PATTERN.exec(afterNumber);
        if (range !== null) {
          builder.push(`${readNumberDigits(raw)}から`, sourceIndex);
          index += raw.length + range[0].length;
          continue;
        }
        const unit = UNIT_PATTERN.exec(afterNumber);
        if (unit !== null) {
          const key = (unit[1] ?? "").toLowerCase();
          const reading = UNIT_READINGS[key] ?? UNIT_READINGS[unit[1] ?? ""];
          if (reading !== undefined) {
            builder.push(`${readNumberDigits(raw)}${reading}`, sourceIndex);
            index += raw.length + unit[0].length;
            continue;
          }
        }
        builder.push(raw, sourceIndex);
        index += raw.length;
        continue;
      }
    }
    const currency = CURRENCY_PREFIX[char];
    if (currency !== undefined) {
      const after = chars.slice(index + 1).join("");
      const number = NUMBER_PATTERN.exec(after);
      if (number !== null) {
        builder.push(`${readNumberDigits(number[0])}${currency}`, sourceIndex);
        index += 1 + number[0].length;
        continue;
      }
    }
    if (
      (char === "-" || char === "−" || char === "－" || char === "+" || char === "＋") &&
      isDigitChar(chars[index + 1])
    ) {
      const previous = chars[index - 1];
      if (!isAsciiAlnum(previous)) {
        builder.push(char === "+" || char === "＋" ? "プラス" : "マイナス", sourceIndex);
        index += 1;
        continue;
      }
    }
    const hash = HASH_NUMBER_PATTERN.exec(rest);
    if (hash !== null) {
      builder.push(`ナンバー${hash[1] ?? ""}`, sourceIndex);
      index += hash[0].length;
      continue;
    }
    const version = VERSION_PATTERN.exec(rest);
    if (version !== null && !isAsciiAlnum(chars[index - 1])) {
      builder.push(`ブイ${dottedReading(version[1] ?? "")}`, sourceIndex);
      index += version[0].length;
      continue;
    }
    if (/^[A-Za-z]$/u.test(char) && !isAsciiAlnum(chars[index - 1])) {
      const word = WORD_PATTERN.exec(rest);
      if (word !== null) {
        let raw = word[0];
        let consumed = raw.length;
        if (useLexicon) {
          let found = lookupLexicon(raw);
          let words = 1;
          let probe = raw;
          let probeLength = consumed;
          while (words < LEXICON_MAX_WORDS) {
            const tail = rest.slice(probeLength);
            const more = /^\s+([A-Za-z][A-Za-z0-9+#.'-]*)/u.exec(tail);
            if (more === null) break;
            probe = `${probe} ${more[1] ?? ""}`;
            probeLength += more[0].length;
            words += 1;
            const candidate = lookupLexicon(probe);
            if (candidate !== undefined) {
              found = candidate;
              raw = probe;
              consumed = probeLength;
            }
          }
          if (found !== undefined) {
            const normalizedStart = builder.out.length;
            builder.push(found.reading, sourceIndex);
            hits.push({
              surface: raw,
              reading: found.reading,
              id: undefined,
              accent: found.accent ?? null,
              source: "lexicon",
              sourceSpan: spanOf(index, index + Array.from(raw).length),
              normalizedStart,
              normalizedEnd: builder.out.length,
              order: order++,
            });
            index += consumed;
            continue;
          }
        }
        const letters = raw.replaceAll(/[^A-Za-z]/gu, "");
        if (letters.length >= 5 && letters !== letters.toUpperCase()) {
          diagnostics.push({
            severity: "advice",
            code: "ASCII_WORD_UNKNOWN",
            message: `The word ${JSON.stringify(raw)} is not in the built-in lexicon; the frontend may spell it letter by letter.`,
            help: "Add a dictionary entry with its katakana reading, or write the reading in kana.",
            sourceSpan: spanOf(index, index + Array.from(raw).length),
            surface: raw,
          });
        }
        builder.push(raw, sourceIndex);
        index += consumed;
        continue;
      }
    }
    if (char === "*" && isDigitChar(chars[index - 1]) && isDigitChar(chars[index + 1])) {
      builder.push("かける", sourceIndex);
      index += 1;
      continue;
    }
    if (char === "/" && isAsciiAlnum(chars[index - 1]) && isAsciiAlnum(chars[index + 1])) {
      builder.push("スラッシュ", sourceIndex);
      index += 1;
      continue;
    }
    if ((char === "<" || char === ">") && isAsciiAlnum(chars[index - 1]) && isAsciiAlnum(chars[index + 1])) {
      builder.push(char === "<" ? "小なり" : "大なり", sourceIndex);
      index += 1;
      continue;
    }
    if (char === "°" && (chars[index + 1] === "C" || chars[index + 1] === "c")) {
      builder.push("度", sourceIndex);
      index += 2;
      continue;
    }
    if (char === "°" && (chars[index + 1] === "F" || chars[index + 1] === "f")) {
      builder.push("度エフ", sourceIndex);
      index += 2;
      continue;
    }
    if (char === "+" && !isDigitChar(chars[index + 1])) {
      builder.push("プラス", sourceIndex);
      index += 1;
      continue;
    }
    const symbol = SYMBOL_READINGS[char];
    if (symbol !== undefined) {
      builder.push(symbol, sourceIndex);
      index += 1;
      continue;
    }
    if (char === "…" || char === "‥") {
      builder.push("、", sourceIndex);
      index += 1;
      continue;
    }
    if (char === "`" || char === "*" || char === "|" || char === "\\" || char === "^" || char === "~" || char === "#") {
      index += 1;
      continue;
    }
    if (char === "_" && (isAsciiAlnum(chars[index - 1]) || isAsciiAlnum(chars[index + 1]))) {
      index += 1;
      continue;
    }
    builder.push(char, sourceIndex);
    index += 1;
  }
  return { text: builder.out.join(""), map: builder.map, diagnostics, hits };
}

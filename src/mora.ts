import { unsupported } from "./errors.ts";

export type Vowel = "a" | "i" | "u" | "e" | "o" | "N" | "cl" | "pau";
export type UnvoicedVowel = "A" | "I" | "U" | "E" | "O";
export type Consonant =
  | "b"
  | "by"
  | "ch"
  | "d"
  | "dy"
  | "f"
  | "g"
  | "gw"
  | "gy"
  | "h"
  | "hy"
  | "j"
  | "k"
  | "kw"
  | "ky"
  | "m"
  | "my"
  | "n"
  | "ny"
  | "p"
  | "py"
  | "r"
  | "ry"
  | "s"
  | "sh"
  | "t"
  | "ts"
  | "ty"
  | "v"
  | "w"
  | "y"
  | "z";
export type Phoneme = Vowel | UnvoicedVowel | Consonant;

export interface MoraPhonemes {
  readonly consonant: Consonant | null;
  readonly vowel: Vowel;
}

const rows: readonly (readonly [string, Consonant | null, Vowel])[] = [
  ["ヴォ", "v", "o"],
  ["ヴェ", "v", "e"],
  ["ヴィ", "v", "i"],
  ["ヴァ", "v", "a"],
  ["ヴ", "v", "u"],
  ["ン", null, "N"],
  ["ワ", "w", "a"],
  ["ロ", "r", "o"],
  ["レ", "r", "e"],
  ["ル", "r", "u"],
  ["リョ", "ry", "o"],
  ["リュ", "ry", "u"],
  ["リャ", "ry", "a"],
  ["リェ", "ry", "e"],
  ["リィ", "ry", "i"],
  ["リ", "r", "i"],
  ["ラ", "r", "a"],
  ["ヨ", "y", "o"],
  ["ユ", "y", "u"],
  ["ヤ", "y", "a"],
  ["モ", "m", "o"],
  ["メ", "m", "e"],
  ["ム", "m", "u"],
  ["ミョ", "my", "o"],
  ["ミュ", "my", "u"],
  ["ミャ", "my", "a"],
  ["ミェ", "my", "e"],
  ["ミィ", "my", "i"],
  ["ミ", "m", "i"],
  ["マ", "m", "a"],
  ["ポ", "p", "o"],
  ["ボ", "b", "o"],
  ["ホ", "h", "o"],
  ["ペ", "p", "e"],
  ["ベ", "b", "e"],
  ["ヘ", "h", "e"],
  ["プ", "p", "u"],
  ["ブ", "b", "u"],
  ["フォ", "f", "o"],
  ["フェ", "f", "e"],
  ["フィ", "f", "i"],
  ["ファ", "f", "a"],
  ["フ", "f", "u"],
  ["ピョ", "py", "o"],
  ["ピュ", "py", "u"],
  ["ピャ", "py", "a"],
  ["ピェ", "py", "e"],
  ["ピィ", "py", "i"],
  ["ピ", "p", "i"],
  ["ビョ", "by", "o"],
  ["ビュ", "by", "u"],
  ["ビャ", "by", "a"],
  ["ビェ", "by", "e"],
  ["ビィ", "by", "i"],
  ["ビ", "b", "i"],
  ["ヒョ", "hy", "o"],
  ["ヒュ", "hy", "u"],
  ["ヒャ", "hy", "a"],
  ["ヒェ", "hy", "e"],
  ["ヒィ", "hy", "i"],
  ["ヒ", "h", "i"],
  ["パ", "p", "a"],
  ["バ", "b", "a"],
  ["ハ", "h", "a"],
  ["ノ", "n", "o"],
  ["ネ", "n", "e"],
  ["ヌ", "n", "u"],
  ["ニョ", "ny", "o"],
  ["ニュ", "ny", "u"],
  ["ニャ", "ny", "a"],
  ["ニェ", "ny", "e"],
  ["ニィ", "ny", "i"],
  ["ニ", "n", "i"],
  ["ナ", "n", "a"],
  ["ドゥ", "d", "u"],
  ["ド", "d", "o"],
  ["トゥ", "t", "u"],
  ["ト", "t", "o"],
  ["デョ", "dy", "o"],
  ["デュ", "dy", "u"],
  ["デャ", "dy", "a"],
  ["デェ", "dy", "e"],
  ["ディ", "d", "i"],
  ["デ", "d", "e"],
  ["テョ", "ty", "o"],
  ["テュ", "ty", "u"],
  ["テャ", "ty", "a"],
  ["テェ", "ty", "e"],
  ["ティ", "t", "i"],
  ["テ", "t", "e"],
  ["ツォ", "ts", "o"],
  ["ツェ", "ts", "e"],
  ["ツィ", "ts", "i"],
  ["ツァ", "ts", "a"],
  ["ツ", "ts", "u"],
  ["ッ", null, "cl"],
  ["チョ", "ch", "o"],
  ["チュ", "ch", "u"],
  ["チャ", "ch", "a"],
  ["チェ", "ch", "e"],
  ["チ", "ch", "i"],
  ["ダ", "d", "a"],
  ["タ", "t", "a"],
  ["ゾ", "z", "o"],
  ["ソ", "s", "o"],
  ["ゼ", "z", "e"],
  ["セ", "s", "e"],
  ["ズィ", "z", "i"],
  ["ズ", "z", "u"],
  ["スィ", "s", "i"],
  ["ス", "s", "u"],
  ["ジョ", "j", "o"],
  ["ジュ", "j", "u"],
  ["ジャ", "j", "a"],
  ["ジェ", "j", "e"],
  ["ジ", "j", "i"],
  ["ショ", "sh", "o"],
  ["シュ", "sh", "u"],
  ["シャ", "sh", "a"],
  ["シェ", "sh", "e"],
  ["シ", "sh", "i"],
  ["ザ", "z", "a"],
  ["サ", "s", "a"],
  ["ゴ", "g", "o"],
  ["コ", "k", "o"],
  ["ゲ", "g", "e"],
  ["ケ", "k", "e"],
  ["グヮ", "gw", "a"],
  ["グォ", "gw", "o"],
  ["グェ", "gw", "e"],
  ["グゥ", "gw", "u"],
  ["グィ", "gw", "i"],
  ["グ", "g", "u"],
  ["クヮ", "kw", "a"],
  ["クォ", "kw", "o"],
  ["クェ", "kw", "e"],
  ["クゥ", "kw", "u"],
  ["クィ", "kw", "i"],
  ["ク", "k", "u"],
  ["ギョ", "gy", "o"],
  ["ギュ", "gy", "u"],
  ["ギャ", "gy", "a"],
  ["ギェ", "gy", "e"],
  ["ギィ", "gy", "i"],
  ["ギ", "g", "i"],
  ["キョ", "ky", "o"],
  ["キュ", "ky", "u"],
  ["キャ", "ky", "a"],
  ["キェ", "ky", "e"],
  ["キィ", "ky", "i"],
  ["キ", "k", "i"],
  ["ガ", "g", "a"],
  ["カ", "k", "a"],
  ["オ", null, "o"],
  ["エ", null, "e"],
  ["ウォ", "w", "o"],
  ["ウェ", "w", "e"],
  ["ウゥ", "w", "u"],
  ["ウィ", "w", "i"],
  ["ウ", null, "u"],
  ["イェ", "y", "e"],
  ["イ", null, "i"],
  ["ア", null, "a"],
  ["ヴョ", "by", "o"],
  ["ヴュ", "by", "u"],
  ["ヴャ", "by", "a"],
  ["ヲ", null, "o"],
  ["ヱ", null, "e"],
  ["ヰ", null, "i"],
  ["ヮ", "w", "a"],
  ["ョ", "y", "o"],
  ["ュ", "y", "u"],
  ["ヅ", "z", "u"],
  ["ヂョ", "j", "o"],
  ["ヂュ", "j", "u"],
  ["ヂャ", "j", "a"],
  ["ヂェ", "j", "e"],
  ["ヂ", "j", "i"],
  ["グァ", "gw", "a"],
  ["クァ", "kw", "a"],
  ["ヶ", "k", "e"],
  ["ャ", "y", "a"],
  ["ォ", null, "o"],
  ["ェ", null, "e"],
  ["ゥ", null, "u"],
  ["ィ", null, "i"],
  ["ァ", null, "a"],
];

const table: Map<string, MoraPhonemes> = new Map<string, MoraPhonemes>();
for (const [kana, consonant, vowel] of rows) table.set(kana, { consonant, vowel });

export const MORA_TABLE: ReadonlyMap<string, MoraPhonemes> = table;

const VOWEL_KANA: Readonly<Record<Vowel, string>> = {
  a: "ア",
  i: "イ",
  u: "ウ",
  e: "エ",
  o: "オ",
  N: "ン",
  cl: "ッ",
  pau: "",
};

const UNVOICED_KANA: Readonly<Record<UnvoicedVowel, string>> = { A: "ア", I: "イ", U: "ウ", E: "エ", O: "オ" };

export function vowelToKana(vowel: Vowel | UnvoicedVowel): string {
  switch (vowel) {
    case "A":
    case "I":
    case "U":
    case "E":
    case "O":
      return UNVOICED_KANA[vowel];
    default:
      return VOWEL_KANA[vowel];
  }
}

export function toKatakana(text: string): string {
  let out = "";
  for (const char of text.normalize("NFKC")) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : char;
  }
  return out;
}

export function lookupMora(kana: string): MoraPhonemes | undefined {
  return table.get(kana);
}

export type KanaUnit =
  | {
      readonly kind: "mora";
      readonly text: string;
      readonly consonant: Consonant | null;
      readonly vowel: Vowel;
    }
  | { readonly kind: "pause"; readonly text: string; readonly weight: number };

const PAUSE_WEIGHTS: ReadonlyMap<string, number> = new Map<string, number>([
  ["、", 1],
  [",", 1],
  ["。", 2],
  [".", 2],
  ["!", 2],
  ["?", 2],
  [":", 1],
  [";", 1],
  ["…", 1.5],
  ["‥", 1],
  ["・", 0.5],
  ["\n", 2],
]);

const LONG_VOWEL_MARKS: ReadonlySet<string> = new Set(["ー", "−", "-", "~", "〜"]);

export function kanaToUnits(text: string, path: string = "$.text"): readonly KanaUnit[] {
  const chars = Array.from(toKatakana(text));
  const units: KanaUnit[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    const pauseWeight = PAUSE_WEIGHTS.get(char);
    if (pauseWeight !== undefined) {
      units.push({ kind: "pause", text: char, weight: pauseWeight });
      index += 1;
      continue;
    }
    if (/^\s$/u.test(char)) {
      index += 1;
      continue;
    }
    if (LONG_VOWEL_MARKS.has(char)) {
      const previous = units.at(-1);
      if (previous === undefined || previous.kind !== "mora" || previous.vowel === "cl" || previous.vowel === "pau") {
        unsupported(`${path}[${index}]`, "A long-vowel mark must follow a voiced mora.");
      }
      units.push({ kind: "mora", text: vowelToKana(previous.vowel), consonant: null, vowel: previous.vowel });
      index += 1;
      continue;
    }
    const pair = char + (chars[index + 1] ?? "");
    const twoChar = chars.length > index + 1 ? table.get(pair) : undefined;
    if (twoChar !== undefined) {
      units.push({ kind: "mora", text: pair, consonant: twoChar.consonant, vowel: twoChar.vowel });
      index += 2;
      continue;
    }
    const single = table.get(char);
    if (single === undefined) {
      unsupported(
        `${path}[${index}]`,
        `Unsupported character ${JSON.stringify(char)}; only kana, long-vowel marks, and punctuation are accepted here.`,
        "Use the voicevox engine for kanji text, or write the reading in hiragana or katakana.",
      );
    }
    units.push({ kind: "mora", text: char, consonant: single.consonant, vowel: single.vowel });
    index += 1;
  }
  return units;
}

export function kanaToMoras(text: string, path: string = "$.text"): readonly Extract<KanaUnit, { kind: "mora" }>[] {
  const moras: Extract<KanaUnit, { kind: "mora" }>[] = [];
  for (const unit of kanaToUnits(text, path)) if (unit.kind === "mora") moras.push(unit);
  return moras;
}

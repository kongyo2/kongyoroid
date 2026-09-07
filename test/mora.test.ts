import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import {
  MORA_TABLE,
  countMoras,
  isKanaOnly,
  kanaToMoras,
  kanaToUnits,
  lookupMora,
  toHiragana,
  toKatakana,
  vowelToKana,
} from "../src/text/mora.ts";

test("the mora table covers the VOICEVOX inventory plus loan-word moras", () => {
  assert.ok(MORA_TABLE.size >= 187);
  assert.deepEqual(lookupMora("キャ"), { consonant: "ky", vowel: "a" });
  assert.deepEqual(lookupMora("ン"), { consonant: null, vowel: "N" });
  assert.deepEqual(lookupMora("ッ"), { consonant: null, vowel: "cl" });
  assert.deepEqual(lookupMora("ヴォ"), { consonant: "v", vowel: "o" });
  assert.deepEqual(lookupMora("フュ"), { consonant: "f", vowel: "u" });
  assert.equal(lookupMora("あ"), undefined);
  for (const [kana, phonemes] of MORA_TABLE) {
    assert.match(kana, /^[ァ-ヶ]{1,2}$/u, kana);
    assert.ok(phonemes.vowel.length > 0);
  }
});

test("toKatakana and toHiragana normalize scripts and width", () => {
  assert.equal(toKatakana("こんにちは"), "コンニチハ");
  assert.equal(toKatakana("ｶﾞ"), "ガ");
  assert.equal(toKatakana("ＡＢＣ"), "ABC");
  assert.equal(toHiragana("コンニチハ"), "こんにちは");
  assert.equal(toHiragana(toKatakana("ぱぴぷ")), "ぱぴぷ");
});

test("kanaToUnits splits longest-match moras, long vowels, and pauses with indices", () => {
  const units = kanaToUnits("きゃーく、ん。");
  assert.deepEqual(
    units.map((u) =>
      u.kind === "mora" ? `${u.text}:${u.consonant ?? ""}${u.vowel}@${u.index}` : `pause:${u.weight}@${u.index}`,
    ),
    ["キャ:kya@0", "ー:a@2", "ク:ku@3", "pause:1@4", "ン:N@5", "pause:2@6"],
  );
  assert.equal(kanaToMoras("ふぁいと").length, 3);
  assert.equal(kanaToMoras("ドゥ").length, 1);
  assert.equal(kanaToMoras("アイ  ウ\tエ").length, 4);
  assert.equal(kanaToUnits("あ\nい").filter((u) => u.kind === "pause").length, 1);
  assert.deepEqual(
    kanaToMoras("んー").map((m) => m.vowel),
    ["N", "N"],
  );
  assert.equal(countMoras("きょうはいいてんき"), 8);
  assert.equal(isKanaOnly("ひらがな、カタカナ。"), true);
  assert.equal(isKanaOnly("漢字"), false);
});

test("kanaToUnits reports unsupported characters with index and span", () => {
  assert.throws(
    () => kanaToUnits("あ漢"),
    (error: unknown) =>
      error instanceof KongyoroidError &&
      error.code === "UNSUPPORTED_TEXT" &&
      error.path === "$.text[1]" &&
      error.surface === "漢" &&
      error.sourceSpan?.start === 1,
  );
  assert.throws(
    () => kanaToUnits("ー"),
    (error: unknown) => error instanceof KongyoroidError && error.code === "UNSUPPORTED_TEXT",
  );
  assert.throws(
    () => kanaToUnits("っー"),
    (error: unknown) => error instanceof KongyoroidError && error.code === "UNSUPPORTED_TEXT",
  );
});

test("vowelToKana maps every vowel to a lyric", () => {
  assert.equal(vowelToKana("a"), "ア");
  assert.equal(vowelToKana("N"), "ン");
  assert.equal(vowelToKana("I"), "イ");
  assert.equal(vowelToKana("pau"), "");
});

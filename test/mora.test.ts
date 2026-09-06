import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { MORA_TABLE, kanaToMoras, kanaToUnits, lookupMora, toKatakana, vowelToKana } from "../src/mora.ts";

test("the mora table matches the VOICEVOX inventory", () => {
  assert.equal(MORA_TABLE.size, 187);
  assert.deepEqual(lookupMora("キャ"), { consonant: "ky", vowel: "a" });
  assert.deepEqual(lookupMora("ン"), { consonant: null, vowel: "N" });
  assert.deepEqual(lookupMora("ッ"), { consonant: null, vowel: "cl" });
  assert.deepEqual(lookupMora("ヴォ"), { consonant: "v", vowel: "o" });
  assert.equal(lookupMora("あ"), undefined);
  for (const [kana, phonemes] of MORA_TABLE) {
    assert.match(kana, /^[ァ-ヶ]{1,2}$/u, kana);
    assert.ok(phonemes.vowel.length > 0);
  }
});

test("toKatakana normalizes hiragana, half-width katakana, and NFKC forms", () => {
  assert.equal(toKatakana("こんにちは"), "コンニチハ");
  assert.equal(toKatakana("ｶﾞ"), "ガ");
  assert.equal(toKatakana("ゖ"), "ヶ");
  assert.equal(toKatakana("ＡＢＣ"), "ABC");
});

test("kanaToUnits splits longest-match moras and long vowels", () => {
  const units = kanaToUnits("きゃーく、ん。");
  assert.deepEqual(
    units.map((u) => (u.kind === "mora" ? `${u.text}:${u.consonant ?? ""}${u.vowel}` : `pause:${u.weight}`)),
    ["キャ:kya", "ア:a", "ク:ku", "pause:1", "ン:N", "pause:2"],
  );
  assert.equal(kanaToMoras("ふぁいと").length, 3);
  assert.equal(kanaToMoras("ドゥ").length, 1);
  assert.equal(kanaToMoras("アイ  ウ\tエ").length, 4);
  assert.equal(kanaToUnits("あ\nい").filter((u) => u.kind === "pause").length, 1);
  assert.deepEqual(
    kanaToMoras("んー").map((m) => m.text),
    ["ン", "ン"],
  );
});

test("kanaToUnits reports unsupported characters with their index", () => {
  assert.throws(
    () => kanaToUnits("あ漢"),
    (error: unknown) =>
      error instanceof KongyoroidError && error.code === "UNSUPPORTED_TEXT" && error.path === "$.text[1]",
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

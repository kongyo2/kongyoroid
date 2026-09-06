import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { formatKanaNotation, parseKanaNotation } from "../src/notation.ts";

function code(fn: () => unknown): { code: string; path: string | undefined; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return { code: error.code, path: error.path, message: error.message };
    throw error;
  }
  throw new Error("expected an error");
}

test("parses AquesTalk-style notation into accent phrases", () => {
  const phrases = parseKanaNotation("コンニチワ'、セカ'イ？/_シツ'モン");
  assert.equal(phrases.length, 3);
  const [first, second, third] = phrases;
  assert.equal(first?.moras.map((m) => m.text).join(""), "コンニチワ");
  assert.equal(first?.accent, 5);
  assert.equal(first?.pause, true);
  assert.equal(second?.accent, 2);
  assert.equal(second?.interrogative, true);
  assert.equal(second?.pause, false);
  assert.equal(third?.moras[0]?.vowel, "I");
  assert.equal(third?.moras[0]?.consonant, "sh");
  assert.equal(third?.accent, 2);
});

test("round-trips through formatKanaNotation", () => {
  for (const text of ["コンニチワ'", "ズ'ンダモン/ナノダ'", "キャ'ク、_キ'テ？", "ア'/イ'/ウ'"]) {
    assert.equal(formatKanaNotation(parseKanaNotation(text)), text);
  }
});

test("accepts hiragana and ASCII punctuation variants", () => {
  const phrases = parseKanaNotation("こんにちわ', せかい'?");
  assert.equal(phrases.length, 2);
  assert.equal(phrases[0]?.pause, true);
  assert.equal(phrases[1]?.interrogative, true);
  assert.equal(formatKanaNotation(phrases), "コンニチワ'、セカイ'？");
});

test("rejects malformed notation with precise paths", () => {
  assert.equal(code(() => parseKanaNotation("'コン")).message.includes("cannot start"), true);
  assert.equal(code(() => parseKanaNotation("コ'ン'")).message.includes("only one accent"), true);
  assert.equal(code(() => parseKanaNotation("コン")).message.includes("exactly one accent"), true);
  assert.equal(code(() => parseKanaNotation("コ'ン//ア'")).path, "$.kana[1]");
  assert.equal(code(() => parseKanaNotation("コ？'ン")).message.includes("only end"), true);
  assert.equal(code(() => parseKanaNotation("漢'字")).code, "INVALID_INPUT");
  assert.equal(code(() => parseKanaNotation("_ン'")).message.includes("devoiced"), true);
  assert.equal(code(() => parseKanaNotation("")).code, "INVALID_INPUT");
});

test("long-vowel marks and trailing delimiters are accepted", () => {
  const phrases = parseKanaNotation("スーパー'");
  assert.deepEqual(
    phrases[0]?.moras.map((m) => m.text),
    ["ス", "ウ", "パ", "ア"],
  );
  assert.equal(formatKanaNotation(phrases), "スウパア'");
  const trailingPause = parseKanaNotation("ア'、");
  assert.equal(trailingPause.length, 1);
  assert.equal(trailingPause[0]?.pause, true);
  assert.equal(parseKanaNotation("ア'/").length, 1);
  assert.throws(() => parseKanaNotation("ア'、、"), KongyoroidError);
  assert.throws(() => parseKanaNotation("ー'"), KongyoroidError);
  assert.throws(() => parseKanaNotation("ッー'"), KongyoroidError);
});

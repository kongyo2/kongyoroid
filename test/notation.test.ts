import assert from "node:assert/strict";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { formatKanaNotation, parseKanaNotation } from "../src/text/notation.ts";

function code(fn: () => unknown): { code: string; path: string | undefined; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return { code: error.code, path: error.path, message: error.message };
    throw error;
  }
  throw new Error("expected an error");
}

test("parses AquesTalk-style notation into accent phrases with boundaries", () => {
  const phrases = parseKanaNotation("コンニチワ'、セカ'イ？/_シツ'モン");
  assert.equal(phrases.length, 3);
  const [first, second, third] = phrases;
  assert.equal(first?.moras.map((m) => m.text).join(""), "コンニチワ");
  assert.equal(first?.accent, 5);
  assert.equal(first?.boundary, "pause");
  assert.equal(first?.pause, true);
  assert.equal(second?.accent, 2);
  assert.equal(second?.boundary, "question");
  assert.equal(second?.interrogative, true);
  assert.equal(third?.moras[0]?.vowel, "I");
  assert.equal(third?.moras[0]?.consonant, "sh");
  assert.equal(third?.accent, 2);
  assert.equal(third?.boundary, "end");
});

test("accent marks are optional: no mark means a flat (平板) phrase", () => {
  const phrases = parseKanaNotation("コンニチワ/セカイ");
  assert.deepEqual(
    phrases.map((p) => p.accent),
    [0, 0],
  );
  assert.throws(() => parseKanaNotation("コンニチワ", "$.kana", { requireAccent: true }), KongyoroidError);
});

test("round-trips through formatKanaNotation, including trailing pauses and sentence marks", () => {
  for (const text of [
    "コンニチワ'",
    "ズ'ンダモン/ナノダ'",
    "キャ'ク、_キ'テ？",
    "ア'/イ'/ウ'",
    "ア'、",
    "ア。イ'！",
    "スーパー'/コーヒー",
  ]) {
    assert.equal(formatKanaNotation(parseKanaNotation(text)), text);
    assert.deepEqual(parseKanaNotation(formatKanaNotation(parseKanaNotation(text))), parseKanaNotation(text));
  }
  const trailing = parseKanaNotation("ア'、");
  assert.equal(trailing.length, 1);
  assert.equal(trailing[0]?.boundary, "pause");
  assert.equal(trailing[0]?.pause, true);
});

test("accepts hiragana, ASCII punctuation variants, and long-vowel marks", () => {
  const phrases = parseKanaNotation("こんにちわ', せかい'? すごい!");
  assert.equal(phrases.length, 3);
  assert.equal(phrases[0]?.boundary, "pause");
  assert.equal(phrases[1]?.boundary, "question");
  assert.equal(phrases[2]?.boundary, "exclamation");
  assert.equal(formatKanaNotation(phrases), "コンニチワ'、セカイ'？スゴイ！");
  const long = parseKanaNotation("スーパー'");
  assert.deepEqual(
    long[0]?.moras.map((m) => `${m.text}:${m.vowel}`),
    ["ス:u", "ー:u", "パ:a", "ー:a"],
  );
});

test("rejects malformed notation with precise paths", () => {
  assert.equal(code(() => parseKanaNotation("'コン")).message.includes("cannot start"), true);
  assert.equal(code(() => parseKanaNotation("コ'ン'")).message.includes("only one accent"), true);
  assert.equal(code(() => parseKanaNotation("コ'ン//ア'")).path, "$.kana[1]");
  assert.equal(code(() => parseKanaNotation("漢'字")).code, "INVALID_INPUT");
  assert.equal(code(() => parseKanaNotation("_ン'")).message.includes("devoiced"), true);
  assert.equal(code(() => parseKanaNotation("")).code, "INVALID_INPUT");
  assert.throws(() => parseKanaNotation("ー'"), KongyoroidError);
  assert.throws(() => parseKanaNotation("ッー'"), KongyoroidError);
  assert.equal(parseKanaNotation("ア'、、").length, 1);
  assert.equal(parseKanaNotation("ア'。？")[0]?.boundary, "question");
});

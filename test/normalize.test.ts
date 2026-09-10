import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeForReading } from "../src/text/normalize.ts";
import { splitSentences } from "../src/text/sentences.ts";

function norm(text: string): string {
  return normalizeForReading(text).text;
}

test("dates, times, versions, and dotted numbers are spelled out", () => {
  assert.equal(norm("2026/09/07 9:05に会議"), "2026年9月7日9時5分に会議");
  assert.equal(norm("2026-12-31"), "2026年12月31日");
  assert.equal(norm("12/25は休み"), "12月25日は休み");
  assert.equal(norm("10:30:45"), "10時30分45秒");
  assert.equal(norm("10:00"), "10時");
  assert.equal(norm("v1.2.3"), "ブイ1テン2テン3");
  assert.equal(norm("192.168.0.1"), "192テン168テン0テン1");
  assert.equal(norm("1.5倍"), "1.5倍");
  assert.equal(norm("1,234,567円"), "1,234,567円");
});

test("units, currency, signs, ranges, and hashes are read naturally", () => {
  assert.equal(norm("3ms と 2x と 5h"), "3ミリ秒と2倍と5時間");
  assert.equal(norm("100kg 3km 25℃"), "100キログラム3キロメートル25度");
  assert.equal(norm("¥1,200と$5"), "1200円と5ドル");
  assert.equal(norm("-5度と+3"), "マイナス5度とプラス3");
  assert.equal(norm("10〜20個"), "10から20個");
  assert.equal(norm("PR #42"), "ピーアールナンバー42");
  assert.equal(norm("3*4=12"), "3かける4イコール12");
  assert.equal(norm("50%"), "50パーセント");
});

test("ASCII words use the lexicon and unknown long words get an advice diagnostic", () => {
  const result = normalizeForReading("Claude Code で npm install を実行。GitHub と Node.js");
  assert.equal(result.text, "クロードコードでエヌピーエムインストールを実行。ギットハブとノードジェイエス");
  assert.equal(result.diagnostics.length, 0);
  const unknown = normalizeForReading("kongyoroidsynth を使う");
  assert.equal(unknown.diagnostics[0]?.code, "ASCII_WORD_UNKNOWN");
  assert.deepEqual(unknown.diagnostics[0]?.sourceSpan, { start: 0, end: 15, unit: "unicode-code-point" });
});

test("URLs and emails are read symbol by symbol with an advice diagnostic", () => {
  const result = normalizeForReading("https://example.com/path を開く");
  assert.equal(result.text, "example ドット com スラッシュ pathを開く");
  assert.equal(result.diagnostics[0]?.code, "URL_READ_LITERALLY");
  assert.equal(norm("test@example.com"), "test アットマーク example ドット com");
  const email = normalizeForReading("連絡はtest@example.comへ");
  assert.equal(email.diagnostics[0]?.code, "EMAIL_READ_LITERALLY");
  assert.equal(email.diagnostics[0]?.surface, "test@example.com");
  assert.deepEqual(email.diagnostics[0]?.sourceSpan, { start: 3, end: 19, unit: "unicode-code-point" });
});

test("markdown markers, spaces between Japanese, and newlines are normalized", () => {
  assert.equal(norm("# 見出し"), "見出し");
  assert.equal(norm("- 項目 **強調** `code`"), "項目強調コード");
  assert.equal(norm("私は 学生です"), "私は学生です");
  assert.equal(norm("1. 一番目"), "一番目");
  assert.equal(norm("ﾃｽﾄﾀﾞﾖ①㈱㍻㌔"), "テストダヨ1(株)平成キロ");
});

test("substitutions win over the lexicon and report source spans", () => {
  const result = normalizeForReading("kongyoroidはtestです", {
    substitutions: [{ surface: "kongyoroid", reading: "コンギョロイド", id: "k" }],
  });
  assert.equal(result.text, "コンギョロイドはテストです");
  assert.deepEqual(result.hits, [
    {
      surface: "kongyoroid",
      reading: "コンギョロイド",
      id: "k",
      accent: null,
      source: "dictionary",
      sourceSpan: { start: 0, end: 10, unit: "unicode-code-point" },
      normalizedStart: 0,
      normalizedEnd: 7,
      order: 0,
    },
    {
      surface: "test",
      reading: "テスト",
      id: undefined,
      accent: 1,
      source: "lexicon",
      sourceSpan: { start: 11, end: 15, unit: "unicode-code-point" },
      normalizedStart: 8,
      normalizedEnd: 11,
      order: 1,
    },
  ]);
  const wholeWord = normalizeForReading("kongyoroids", {
    substitutions: [{ surface: "kongyoroid", reading: "コンギョロイド" }],
  });
  assert.equal(wholeWord.hits.length, 0);
  const anywhere = normalizeForReading("kongyoroids", {
    substitutions: [{ surface: "kongyoroid", reading: "コンギョロイド", wholeWord: false }],
  });
  assert.equal(anywhere.hits.length, 1);
  const mapped = normalizeForReading("ｱ漢");
  assert.deepEqual([...mapped.map], [0, 1]);
});

test("splitSentences keeps terminals, handles decimals and paragraphs", () => {
  const pieces = splitSentences("こんにちは。今日は1.5倍？\n明日も晴れ！\n\n次の段落 example.com です");
  assert.deepEqual(
    pieces.map((p) => [p.text, p.terminal, p.paragraphEnd]),
    [
      ["こんにちは。", "。", false],
      ["今日は1.5倍？", "？", false],
      ["明日も晴れ！", "！", true],
      ["次の段落 example.com です", "", false],
    ],
  );
  assert.deepEqual(pieces[1]?.sourceSpan, { start: 6, end: 14, unit: "unicode-code-point" });
  const quoted = splitSentences("「やった！」と言った。彼は（本当？）と聞いた。終わり。」");
  assert.deepEqual(
    quoted.map((p) => [p.text, p.terminal]),
    [
      ["「やった！」", "！"],
      ["と言った。", "。"],
      ["彼は（本当？）", "？"],
      ["と聞いた。", "。"],
      ["終わり。」", "。"],
    ],
  );
});

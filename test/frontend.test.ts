import assert from "node:assert/strict";
import { before, test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { LocalDictionary } from "../src/text/dictionary.ts";
import {
  applyDevoicingRules,
  loadFrontend,
  readJapanese,
  readKanaHeuristically,
  readKanaNotation,
} from "../src/text/frontend.ts";
import { parseKanaNotation } from "../src/text/notation.ts";

before(async () => {
  await loadFrontend();
});

const CORPUS: readonly (readonly [string, string])[] = [
  [
    "こんにちは。今日はいい天気ですね？\n明日も晴れるといいな。",
    "コンニチワ。キョ'ーワ/イ'イ/テ'ンキデ_スネ？ア_シタ'モ/ハレ'ルト/イ'イナ。",
  ],
  ["橋の端で箸を使う。", "ハシ'ノ/ハシデ/ハ'シヲ/_ツカウ。"],
  [
    "テストが3件失敗しました！ログを確認してください。",
    "テ'_ストガ/サン'ゲン/シッパイ/シマ'_シタ！ロ'グヲ/カクニン/_シテ/クダサ'イ。",
  ],
  ["2026/09/07 9:05に会議。", "ニセ'ン/ニ'ジュー/ロク'ネン/ク'ガツ/ナノカ/ク'ジ/ゴ'フンニ/カ'イギ。"],
  ["きょうは、あめです。", "キョ'ーワ、アメデ'_ス。"],
  ["私は東京へ行きます。", "ワタシワ/トーキョーエ/イキマ'_ス。"],
  ["一人で一本の映画を見た。", "_ヒト'リデ/イッ'ポンノ/エーガヲ/ミ'タ。"],
  ["APIのレスポンスは123ミリ秒でした。", "エーピーア'イノ/レ'_スポンスワ/ヒャク'/ニ'ジュー/サン'ミリ/ビョ'ーデ_シタ。"],
];

test("the jpreprocess frontend reads ordinary Japanese with dictionary accents", async () => {
  for (const [text, expected] of CORPUS) {
    const plan = await readJapanese(text);
    assert.equal(plan.kana, expected, text);
    assert.equal(plan.frontend, "jpreprocess");
    assert.ok(plan.phrases.every((phrase) => phrase.accentSource === "frontend" || phrase.accentSource === "lexicon"));
  }
  const api = await readJapanese("APIのレスポンス");
  assert.equal(api.phrases[0]?.accentSource, "lexicon");
  assert.deepEqual(
    api.dictionaryHits.map((hit) => [hit.surface, hit.source, hit.accent, hit.applied]),
    [["API", "lexicon", 5, true]],
  );
});

test("sentence boundaries carry question, exclamation, and paragraph information", async () => {
  const plan = await readJapanese("できた！本当？\n\n次の段落。");
  assert.deepEqual(
    plan.phrases.map((phrase) => phrase.boundary),
    ["exclamation", "question", "phrase", "sentence"],
  );
  assert.equal(plan.sentences.length, 3);
  assert.equal(plan.sentences[1]?.paragraphEnd, true);
  assert.deepEqual(plan.sentences[1]?.sourceSpan, { start: 4, end: 7, unit: "unicode-code-point" });
  assert.equal(plan.phrases[1]?.interrogative, true);
  assert.equal(plan.phrases[0]?.exclamatory, true);
});

test("dictionaries fix readings and accents and report hits with spans", async () => {
  const dictionary = new LocalDictionary();
  dictionary.upsert({ surface: "ずんだもん", reading: "ズンダモン", accent: 1 });
  dictionary.upsert({ surface: "kongyoroid", reading: "コンギョロイド", accent: 0 });
  dictionary.upsert({ surface: "端", reading: "ハシ", accent: 0 });
  const plan = await readJapanese("ずんだもんなのだ。kongyoroidは便利です。橋の端。", { dictionary });
  assert.equal(plan.kana, "ズ'ンダモンナ/ノダ。コンギョロイドワ/ベ'ンリデ_ス。ハシ'ノ/ハシ。");
  assert.deepEqual(
    plan.dictionaryHits.map((hit) => [hit.surface, hit.applied]),
    [
      ["ずんだもん", true],
      ["kongyoroid", true],
      ["端", true],
    ],
  );
  assert.deepEqual(plan.dictionaryHits[1]?.sourceSpan, { start: 9, end: 19, unit: "unicode-code-point" });
  assert.equal(plan.phrases[0]?.accentSource, "dictionary");
  assert.equal(plan.phrases[0]?.accent, 1);
  const adjacent = new LocalDictionary();
  adjacent.upsert({ surface: "3件", reading: "サンケン", accent: 1 });
  adjacent.upsert({ surface: "失敗", reading: "シッパイ", accent: 0 });
  const twice = await readJapanese("テストは3件失敗しました。", { dictionary: adjacent });
  assert.equal(twice.kana, "テ'_ストワ/サ'ンケン/シッパイ/シマ'_シタ。");
  const inside = new LocalDictionary();
  inside.upsert({ surface: "件", reading: "ケン", accent: 1 });
  inside.upsert({ surface: "失敗", reading: "シッパイ", accent: 0 });
  assert.equal(
    (await readJapanese("テストは3件失敗しました。", { dictionary: inside })).kana,
    "テ'_ストワ/サン/ケ'ン/シッパイ/シマ'_シタ。",
  );
});

test("unreadable characters fail loudly in strict mode and are skipped with a warning otherwise", async () => {
  await assert.rejects(readJapanese("彁彁は幽霊文字です。"), (error: unknown) => {
    assert.ok(error instanceof KongyoroidError);
    assert.equal(error.code, "UNREADABLE_TEXT");
    assert.equal(error.surface, "彁彁");
    assert.deepEqual(error.sourceSpan, { start: 0, end: 2, unit: "unicode-code-point" });
    assert.ok(error.repairOptions?.some((option) => option.action === "add-dictionary-entry"));
    return true;
  });
  const lenient = await readJapanese("彁彁は幽霊文字です。", { strict: false });
  assert.equal(lenient.warnings[0]?.code, "UNREADABLE_TEXT_SKIPPED");
  assert.equal(lenient.kana, "ワ/ユーレー'モジデ_ス。");
  await assert.rejects(
    readJapanese("😀♪"),
    (error: unknown) => error instanceof KongyoroidError && error.code === "INVALID_INPUT",
  );
});

test("kana notation is read literally, with rule-based devoicing unless marked explicitly", () => {
  const auto = readKanaNotation("デス、マス、キシツ、シテクダサイ");
  assert.equal(auto.kana, "デ_ス、マ_ス、キ_シツ、_シテクダサイ。");
  assert.equal(auto.frontend, "notation");
  assert.equal(auto.phrases[0]?.accentSource, "rule");
  const explicit = readKanaNotation("デス'/_シテ");
  assert.equal(explicit.kana, "デス'/_シテ。");
  assert.equal(explicit.phrases[0]?.accentSource, "user");
  const rules = applyDevoicingRules(parseKanaNotation("キ'シツ"));
  assert.equal(rules[0]?.moras[0]?.vowel, "i");
  assert.equal(rules[0]?.moras[1]?.vowel, "I");
});

test("the heuristic reader handles kana text without word analysis", () => {
  const plan = readKanaHeuristically("こんにちは、せかい。げんきですか？");
  assert.equal(plan.frontend, "heuristic");
  assert.equal(plan.kana, "コンニ_チハ、セカイ。ゲンキデ_スカ？");
  assert.equal(plan.warnings[0]?.code, "HEURISTIC_READING");
  assert.throws(() => readKanaHeuristically("漢字"), KongyoroidError);
});

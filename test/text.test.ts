import assert from "node:assert/strict";
import { test } from "node:test";
import { splitText } from "../src/text.ts";

test("splitText keeps sentence punctuation with its sentence", () => {
  assert.deepEqual(splitText("こんにちは。元気ですか？はい！\n\n次の段落", "sentence"), [
    "こんにちは。",
    "元気ですか？",
    "はい！",
    "次の段落",
  ]);
  assert.deepEqual(splitText("一行目\r\n二行目。三行目", "paragraph"), ["一行目", "二行目。三行目"]);
  assert.deepEqual(splitText("そのまま。全部", "none"), ["そのまま。全部"]);
  assert.deepEqual(splitText("   ", "sentence"), ["   "]);
});

test("splitText bounds overlong sentences at clause boundaries or hard limits", () => {
  const clause = "あ".repeat(30);
  const sentence = `${clause}、${clause}、${clause}。`;
  const chunks = splitText(sentence, "sentence", 64);
  assert.equal(chunks.join(""), sentence);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 64));
  assert.equal(chunks.length, 2);
  const hard = splitText("い".repeat(150), "sentence", 64);
  assert.deepEqual(
    hard.map((c) => Array.from(c).length),
    [64, 64, 22],
  );
});

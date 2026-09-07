import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseJson, parseRequest } from "../src/request.ts";
import { BATCH_JOB_SCHEMA, DICTIONARY_SCHEMA, REQUEST_SCHEMA } from "../src/schema.ts";
import { parseDictionaryEntries } from "../src/text/dictionary.ts";
import { isObject } from "../src/validate.ts";

const examples = new URL("../examples/", import.meta.url);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(REQUEST_SCHEMA);

async function requestFiles(subdirectory: string): Promise<readonly string[]> {
  const names = await readdir(new URL(`${subdirectory}/`, examples));
  return names
    .filter((name) => name.endsWith(".json") && name !== "dictionary.json")
    .map((name) => `${subdirectory}/${name}`);
}

test("every built-in example validates, needs no external engine, and parses", async () => {
  const files = await requestFiles("builtin");
  assert.ok(files.length >= 5);
  for (const file of files) {
    const request = parseJson(await readFile(new URL(file, examples), "utf8"));
    assert.equal(validate(request), true, `${file}: ${JSON.stringify(validate.errors)}`);
    const resolved = parseRequest(request);
    assert.equal(resolved.engine, "formant", file);
  }
});

test("every VOICEVOX example validates and selects the voicevox engine", async () => {
  const files = await requestFiles("voicevox");
  assert.ok(files.length >= 3);
  for (const file of files) {
    const request = parseJson(await readFile(new URL(file, examples), "utf8"));
    assert.equal(validate(request), true, `${file}: ${JSON.stringify(validate.errors)}`);
    assert.equal(parseRequest(request).engine, "voicevox", file);
  }
});

test("the example dictionary validates against the dictionary schema and the parser", async () => {
  const text = await readFile(new URL("builtin/dictionary.json", examples), "utf8");
  const json = parseJson(text);
  assert.equal(new Ajv2020({ allErrors: true, strict: false }).compile(DICTIONARY_SCHEMA)(json), true);
  assert.equal(parseDictionaryEntries(json).length, 3);
});

test("every batch example line is a valid job", async () => {
  const lines = (await readFile(new URL("batch.jsonl", examples), "utf8")).trim().split("\n");
  assert.equal(lines.length, 5);
  const validateJob = new Ajv2020({ allErrors: true, strict: false }).compile(BATCH_JOB_SCHEMA);
  for (const line of lines) {
    const job = parseJson(line);
    assert.ok(isObject(job));
    assert.match(String(job["id"]), /^[A-Za-z0-9_-]{1,64}$/u);
    assert.equal(validate(job["request"]), true, JSON.stringify(validate.errors));
    assert.equal(validateJob(job), true, JSON.stringify(validateJob.errors));
    parseRequest(job["request"]);
  }
  assert.equal(validateJob({ id: "x", request: { kind: "speech" } }), false);
  assert.equal(validateJob({ id: "bad id", request: { kind: "speech", text: "x" } }), false);
});

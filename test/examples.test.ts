import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Ajv } from "ajv";
import { parseJson, parseRequest } from "../src/request.ts";
import { BATCH_JOB_SCHEMA, REQUEST_SCHEMA } from "../src/schema.ts";
import { isObject } from "../src/validate.ts";

const examples = new URL("../examples/", import.meta.url);
const validate = new Ajv({ allErrors: true, strict: false }).compile(REQUEST_SCHEMA);

test("every example request validates against the schema and the parser", async () => {
  const files = (await readdir(examples)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 4);
  const contents = await Promise.all(files.map((name) => readFile(new URL(name, examples), "utf8")));
  for (const [index, text] of contents.entries()) {
    const request = parseJson(text);
    assert.equal(validate(request), true, `${files[index]}: ${JSON.stringify(validate.errors)}`);
    parseRequest(request);
  }
});

test("every batch example line is a valid job", async () => {
  const lines = (await readFile(new URL("batch.jsonl", examples), "utf8")).trim().split("\n");
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const job = parseJson(line);
    assert.ok(isObject(job));
    assert.match(String(job["id"]), /^[A-Za-z0-9_-]{1,64}$/u);
    assert.equal(validate(job["request"]), true, JSON.stringify(validate.errors));
    parseRequest(job["request"]);
  }
});

test("the batch schema validates whole jobs on its own", async () => {
  const validateJob = new Ajv({ allErrors: true, strict: false }).compile(BATCH_JOB_SCHEMA);
  const lines = (await readFile(new URL("batch.jsonl", examples), "utf8")).trim().split("\n");
  for (const line of lines) assert.equal(validateJob(parseJson(line)), true, JSON.stringify(validateJob.errors));
  assert.equal(validateJob({ id: "x", request: { kind: "speech" } }), false);
  assert.equal(validateJob({ id: "bad id", request: { kind: "speech", text: "x" } }), false);
});

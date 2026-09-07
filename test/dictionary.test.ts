import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { LocalDictionary, dictionaryFromJson, parseDictionaryEntries } from "../src/text/dictionary.ts";

function failure(fn: () => unknown): KongyoroidError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KongyoroidError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

test("dictionary entries are validated and normalized", () => {
  const entries = parseDictionaryEntries([
    { surface: "kongyoroid", reading: "こんぎょろいど", accent: 0 },
    { id: "hashi", surface: "端", reading: "ハシ", priority: 8, match: "anywhere" },
  ]);
  assert.equal(entries[0]?.id, "entry-1");
  assert.equal(entries[0]?.reading, "コンギョロイド");
  assert.equal(entries[0]?.accent, 0);
  assert.equal(entries[0]?.match, "word");
  assert.equal(entries[1]?.id, "hashi");
  assert.equal(entries[1]?.accent, null);
  assert.equal(entries[1]?.priority, 8);
  assert.equal(
    failure(() => parseDictionaryEntries([{ surface: "x", reading: "abc" }])).path,
    "$.dictionary[0].reading",
  );
  assert.equal(
    failure(() => parseDictionaryEntries([{ surface: "x", reading: "アイ", accent: 3 }])).path,
    "$.dictionary[0].accent",
  );
  assert.equal(
    failure(() => parseDictionaryEntries([{ surface: "x", reading: "ア", extra: 1 }])).path,
    "$.dictionary[0].extra",
  );
  assert.equal(
    failure(() =>
      parseDictionaryEntries([
        { id: "a", surface: "x", reading: "ア" },
        { id: "a", surface: "y", reading: "イ" },
      ]),
    ).path,
    "$.dictionary[1].id",
  );
  assert.equal(failure(() => parseDictionaryEntries("nope")).code, "INVALID_INPUT");
  assert.equal(dictionaryFromJson({ entries: [{ surface: "x", reading: "ア" }] }).size, 1);
});

test("LocalDictionary upserts, removes, merges, digests, and yields substitutions", () => {
  const dictionary = new LocalDictionary();
  const first = dictionary.upsert({ surface: "kongyoroid", reading: "コンギョロイド", accent: 0 });
  assert.equal(first.created, true);
  assert.equal(first.entry.id, "entry-1");
  const second = dictionary.upsert({ surface: "端", reading: "ハシ" });
  assert.equal(second.entry.id, "entry-2");
  const digest = dictionary.digest();
  const updated = dictionary.upsert({ id: "entry-2", surface: "端", reading: "ハシ", accent: 0 });
  assert.equal(updated.created, false);
  assert.notEqual(dictionary.digest(), digest);
  assert.equal(dictionary.find("KONGYOROID").length, 1);
  assert.equal(dictionary.remove("entry-2"), true);
  assert.equal(dictionary.remove("entry-2"), false);
  const other = new LocalDictionary();
  other.upsert({ id: "z", surface: "ずんだもん", reading: "ズンダモン", accent: 1, priority: 9 });
  const merged = dictionary.merge(other);
  assert.equal(merged.size, 2);
  assert.equal(dictionary.size, 1);
  const substitutions = merged.substitutions();
  assert.equal(substitutions[0]?.surface, "ずんだもん");
  assert.equal(substitutions[0]?.wholeWord, true);
  assert.deepEqual(
    merged
      .toJSON()
      .entries.map((e) => e.id)
      .sort(),
    ["entry-1", "z"],
  );
});

test("LocalDictionary loads files and reports missing or invalid ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kongyoroid-dict-"));
  try {
    const path = join(directory, "dict.json");
    await writeFile(path, JSON.stringify({ entries: [{ surface: "a", reading: "エー" }] }));
    const loaded = await LocalDictionary.load(path);
    assert.equal(loaded.size, 1);
    await assert.rejects(
      LocalDictionary.load(join(directory, "missing.json")),
      (error: unknown) => error instanceof KongyoroidError && error.code === "IO_ERROR",
    );
    await writeFile(path, "{");
    await assert.rejects(
      LocalDictionary.load(path),
      (error: unknown) => error instanceof KongyoroidError && error.code === "INVALID_INPUT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

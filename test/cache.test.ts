import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiskCache, LayeredCache, MemoryCache, cacheKey } from "../src/cache.ts";

test("MemoryCache evicts least recently used entries within its byte budget", async () => {
  const cache = new MemoryCache(10);
  await cache.set("a", new Uint8Array(4));
  await cache.set("b", new Uint8Array(4));
  assert.ok(await cache.get("a"));
  await cache.set("c", new Uint8Array(4));
  assert.equal(await cache.get("b"), undefined);
  assert.ok(await cache.get("a"));
  assert.ok(await cache.get("c"));
  await cache.set("big", new Uint8Array(11));
  assert.equal(await cache.get("big"), undefined);
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 8, budget: 10 });
  const stored = new Uint8Array([1, 2, 3]);
  await cache.set("copy", stored);
  stored[0] = 9;
  assert.deepEqual([...((await cache.get("copy")) ?? [])], [1, 2, 3]);
  await cache.clear();
  assert.equal(cache.stats().entries, 0);
});

test("DiskCache persists entries and LayeredCache backfills faster layers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kongyoroid-cache-"));
  try {
    const disk = new DiskCache(directory);
    const key = cacheKey("x", { a: 1 });
    assert.equal(key.length, 64);
    assert.equal(await disk.get(key), undefined);
    await disk.set(key, new Uint8Array([7, 8, 9]));
    assert.deepEqual([...((await disk.get(key)) ?? [])], [7, 8, 9]);
    const memory = new MemoryCache(1024);
    const layered = new LayeredCache([memory, disk]);
    assert.deepEqual([...((await layered.get(key)) ?? [])], [7, 8, 9]);
    assert.equal(memory.stats().entries, 1);
    await layered.set("other", new Uint8Array([1]));
    assert.deepEqual([...((await disk.get("other")) ?? [])], [1]);
    await layered.clear();
    assert.equal(await disk.get(key), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_NAMESPACE, DiskCache, LayeredCache, MemoryCache, cacheKey } from "../src/cache.ts";

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
  assert.deepEqual(cache.statsSync(), { entries: 2, bytes: 8, budget: 10 });
  const stored = new Uint8Array([1, 2, 3]);
  await cache.set("copy", stored);
  stored[0] = 9;
  assert.deepEqual([...((await cache.get("copy")) ?? [])], [1, 2, 3]);
  assert.equal(await cache.clear(), 2);
  assert.equal(cache.statsSync().entries, 0);
});

test("DiskCache owns a namespace, never deletes unrelated files, and prunes by size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kongyoroid-cache-"));
  try {
    await writeFile(join(directory, "unrelated.txt"), "keep me");
    const disk = new DiskCache(directory, { maxEntries: 2 });
    const keyA = cacheKey("x", { a: 1 });
    assert.equal(keyA.length, 64);
    assert.equal(await disk.get(keyA), undefined);
    await disk.set(keyA, new Uint8Array([7, 8, 9]));
    assert.deepEqual([...((await disk.get(keyA)) ?? [])], [7, 8, 9]);
    await writeFile(join(disk.directory, "stray.txt"), "also keep");
    await stat(join(directory, CACHE_NAMESPACE, "CACHEDIR.TAG"));
    const keyB = cacheKey("y");
    const keyC = cacheKey("z");
    await disk.set(keyB, new Uint8Array(10));
    await disk.set(keyC, new Uint8Array(10));
    const stats = await disk.stats();
    assert.equal(stats.entries, 2);
    assert.equal(stats.directory, disk.directory);
    const memory = new MemoryCache(1024);
    const layered = new LayeredCache([memory, disk]);
    assert.deepEqual([...((await layered.get(keyC)) ?? [])], [...new Uint8Array(10)]);
    assert.equal(memory.statsSync().entries, 1);
    await layered.set("not-a-key", new Uint8Array([1]));
    assert.equal(await disk.get("not-a-key"), undefined);
    assert.equal(memory.statsSync().entries, 2);
    const removed = await layered.clear();
    assert.ok(removed >= 2);
    assert.equal((await disk.stats()).entries, 0);
    assert.equal(await readFile(join(directory, "unrelated.txt"), "utf8"), "keep me");
    assert.equal(await readFile(join(disk.directory, "stray.txt"), "utf8"), "also keep");
    await disk.set(keyA, new Uint8Array(2000));
    await disk.set(keyB, new Uint8Array(2000));
    assert.equal(await disk.prune(3000, undefined, true), 1);
    assert.equal((await disk.stats()).entries, 2);
    assert.equal(await disk.prune(3000), 1);
    assert.equal((await disk.stats()).entries, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

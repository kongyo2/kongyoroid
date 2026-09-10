import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { integer } from "./validate.ts";

export function cacheKey(...parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export interface CacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly budget: number | null;
  readonly directory?: string;
}

export interface RenderCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  clear(): Promise<number>;
  stats(): Promise<CacheStats>;
}

export class MemoryCache implements RenderCache {
  private readonly entries: Map<string, Uint8Array> = new Map<string, Uint8Array>();
  private readonly budget: number;
  private used: number = 0;

  public constructor(budgetBytes: number) {
    this.budget = integer(budgetBytes, "$.cacheBytes", 0, 4 * 1024 * 1024 * 1024);
  }

  public get(key: string): Promise<Uint8Array | undefined> {
    const value = this.entries.get(key);
    if (value === undefined) return Promise.resolve(undefined);
    this.entries.delete(key);
    this.entries.set(key, value);
    return Promise.resolve(value.slice());
  }

  public set(key: string, value: Uint8Array): Promise<void> {
    if (value.length > this.budget) return Promise.resolve();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.used -= existing.length;
      this.entries.delete(key);
    }
    while (this.used + value.length > this.budget) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.used -= oldest[1].length;
    }
    this.entries.set(key, value.slice());
    this.used += value.length;
    return Promise.resolve();
  }

  public clear(): Promise<number> {
    const count = this.entries.size;
    this.entries.clear();
    this.used = 0;
    return Promise.resolve(count);
  }

  public stats(): Promise<CacheStats> {
    return Promise.resolve({ entries: this.entries.size, bytes: this.used, budget: this.budget });
  }

  public statsSync(): { readonly entries: number; readonly bytes: number; readonly budget: number } {
    return { entries: this.entries.size, bytes: this.used, budget: this.budget };
  }
}

export const CACHE_NAMESPACE: string = "kongyoroid-cache";
export const CACHE_FORMAT: string = "v2";
export const CACHE_EXTENSION: string = ".kcache";
const MARKER_NAME = "CACHEDIR.TAG";
const MARKER_TEXT =
  "Signature: 8a477f597d28d172789f06886806bc55\n# This directory is a kongyoroid render cache. Files here may be deleted at any time.\n";
const KEY_PATTERN = /^[0-9a-f]{64}$/u;

export interface DiskCacheOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

export class DiskCache implements RenderCache {
  public readonly root: string;
  public readonly directory: string;
  private readonly maxBytes: number | undefined;
  private readonly maxEntries: number | undefined;
  private prepared: Promise<void> | undefined;

  public constructor(directory: string, options: DiskCacheOptions = {}) {
    this.root = resolve(directory);
    this.directory = join(this.root, CACHE_NAMESPACE, CACHE_FORMAT);
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries;
  }

  private pathFor(key: string): string {
    return join(this.directory, key.slice(0, 2), `${key}${CACHE_EXTENSION}`);
  }

  private prepare(): Promise<void> {
    this.prepared ??= (async (): Promise<void> => {
      await mkdir(this.directory, { recursive: true });
      const marker = join(this.root, CACHE_NAMESPACE, MARKER_NAME);
      try {
        await stat(marker);
      } catch {
        await writeFile(marker, MARKER_TEXT);
      }
    })().catch((error: unknown) => {
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    if (!KEY_PATTERN.test(key)) return undefined;
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return undefined;
    }
  }

  public async set(key: string, value: Uint8Array): Promise<void> {
    if (!KEY_PATTERN.test(key)) return;
    await this.prepare();
    const target = this.pathFor(key);
    const temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(join(this.directory, key.slice(0, 2)), { recursive: true });
    try {
      await writeFile(temp, value);
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    if (this.maxBytes !== undefined || this.maxEntries !== undefined) await this.prune();
  }

  private async entries(): Promise<{ readonly path: string; readonly bytes: number; readonly mtime: number }[]> {
    const out: { path: string; bytes: number; mtime: number }[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.directory);
    } catch {
      return out;
    }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/u.test(shard)) continue;
      let names: string[];
      try {
        names = await readdir(join(this.directory, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        const stem = name.endsWith(CACHE_EXTENSION) ? name.slice(0, -CACHE_EXTENSION.length) : undefined;
        const isTemp = /\.tmp$/u.test(name);
        if (stem === undefined || !KEY_PATTERN.test(stem)) {
          if (isTemp) out.push({ path: join(this.directory, shard, name), bytes: 0, mtime: 0 });
          continue;
        }
        try {
          const info = await stat(join(this.directory, shard, name));
          out.push({ path: join(this.directory, shard, name), bytes: info.size, mtime: info.mtimeMs });
        } catch {
          continue;
        }
      }
    }
    return out;
  }

  public async stats(): Promise<CacheStats> {
    const entries = (await this.entries()).filter((entry) => entry.mtime > 0);
    let bytes = 0;
    for (const entry of entries) bytes += entry.bytes;
    return { entries: entries.length, bytes, budget: this.maxBytes ?? null, directory: this.directory };
  }

  public async clear(): Promise<number> {
    const entries = await this.entries();
    let removed = 0;
    for (const entry of entries) {
      try {
        await unlink(entry.path);
        removed += 1;
      } catch {
        continue;
      }
    }
    return removed;
  }

  public async prune(
    maxBytes: number | undefined = this.maxBytes,
    maxEntries: number | undefined = this.maxEntries,
    dryRun: boolean = false,
  ): Promise<number> {
    const entries = (await this.entries()).filter((entry) => entry.mtime > 0).sort((a, b) => a.mtime - b.mtime);
    let bytes = 0;
    for (const entry of entries) bytes += entry.bytes;
    let count = entries.length;
    let removed = 0;
    for (const entry of entries) {
      const overBytes = maxBytes !== undefined && bytes > maxBytes;
      const overCount = maxEntries !== undefined && count > maxEntries;
      if (!overBytes && !overCount) break;
      try {
        if (!dryRun) await unlink(entry.path);
        removed += 1;
        bytes -= entry.bytes;
        count -= 1;
      } catch {
        continue;
      }
    }
    return removed;
  }

  public async remove(): Promise<void> {
    await rm(join(this.root, CACHE_NAMESPACE), { recursive: true, force: true });
  }
}

export class LayeredCache implements RenderCache {
  private readonly layers: readonly RenderCache[];

  public constructor(layers: readonly RenderCache[]) {
    this.layers = layers;
  }

  public get(key: string): Promise<Uint8Array | undefined> {
    const lookup = async (index: number): Promise<Uint8Array | undefined> => {
      const layer = this.layers[index];
      if (layer === undefined) return undefined;
      const value = await layer.get(key);
      if (value === undefined) return lookup(index + 1);
      await Promise.all(this.layers.slice(0, index).map((earlier) => earlier.set(key, value)));
      return value;
    };
    return lookup(0);
  }

  public async set(key: string, value: Uint8Array): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.set(key, value)));
  }

  public async clear(): Promise<number> {
    const counts = await Promise.all(this.layers.map((layer) => layer.clear()));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  public async stats(): Promise<CacheStats> {
    const all = await Promise.all(this.layers.map((layer) => layer.stats()));
    const last = all.at(-1);
    return last ?? { entries: 0, bytes: 0, budget: null };
  }
}

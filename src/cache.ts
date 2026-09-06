import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { integer } from "./validate.ts";

export function cacheKey(...parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export interface RenderCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  clear(): Promise<void>;
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

  public clear(): Promise<void> {
    this.entries.clear();
    this.used = 0;
    return Promise.resolve();
  }

  public stats(): { readonly entries: number; readonly bytes: number; readonly budget: number } {
    return { entries: this.entries.size, bytes: this.used, budget: this.budget };
  }
}

export class DiskCache implements RenderCache {
  private readonly directory: string;

  public constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private pathFor(key: string): string {
    return join(this.directory, key.slice(0, 2), `${key}.wav`);
  }

  public async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return undefined;
    }
  }

  public async set(key: string, value: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    const temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(join(this.directory, key.slice(0, 2)), { recursive: true });
    try {
      await writeFile(temp, value);
      await rename(temp, target);
    } catch {
      await unlink(temp).catch(() => undefined);
    }
  }

  public async clear(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.directory, { recursive: true, force: true });
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

  public async clear(): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.clear()));
  }
}

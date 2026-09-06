import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin } from "node:process";
import type { Readable, Writable } from "node:stream";
import { KongyoroidError, aborted, checkAbort, invalid } from "./errors.ts";
import { LIMITS } from "./limits.ts";

export function writeStream(stream: Writable, content: string | Uint8Array): Promise<void> {
  return new Promise<void>((done, reject) => {
    stream.write(content, (error?: Error | null): void => {
      if (error) reject(error);
      else done();
    });
  });
}

function source(path: string): Readable {
  return path === "-" ? stdin : createReadStream(path);
}

function ioError(message: string, cause: unknown): KongyoroidError {
  if (cause instanceof KongyoroidError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new KongyoroidError({ code: "IO_ERROR", message: `${message}: ${detail}`, retryable: false }, cause);
}

export async function readText(path: string, signal?: AbortSignal, limit: number = LIMITS.inputBytes): Promise<string> {
  const stream = source(path);
  const abort = (): void => {
    stream.destroy(aborted("Input cancelled."));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const parts: Buffer[] = [];
  let length = 0;
  try {
    checkAbort(signal);
    for await (const raw of stream) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) invalid("$.input", "Expected byte input.");
      length += chunk.length;
      if (length > limit) invalid("$.input", `Input exceeds ${limit} bytes.`);
      parts.push(chunk);
    }
    checkAbort(signal);
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch (error) {
    throw ioError(`Could not read ${path === "-" ? "standard input" : path}`, error);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (path !== "-") stream.destroy();
  }
}

export async function* readLines(
  path: string,
  signal?: AbortSignal,
  limit: number = LIMITS.inputBytes,
): AsyncGenerator<string, void, void> {
  const stream = source(path);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const abort = (): void => {
    stream.destroy(aborted("Input cancelled."));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    checkAbort(signal);
    for await (const raw of stream) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) invalid("$.input", "Expected byte input.");
      pending += decoder.decode(chunk, { stream: true });
      let end = pending.indexOf("\n");
      while (end >= 0) {
        const line = pending.slice(0, end).replace(/\r$/u, "");
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > limit) invalid("$.input", `A line exceeds ${limit} bytes.`);
        if (line.trim().length > 0) yield line;
        end = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > limit) invalid("$.input", `A line exceeds ${limit} bytes.`);
      checkAbort(signal);
    }
    pending += decoder.decode();
    if (pending.trim().length > 0) yield pending.replace(/\r$/u, "");
  } catch (error) {
    throw ioError(`Could not read ${path === "-" ? "standard input" : path}`, error);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (path !== "-") stream.destroy();
  }
}

export async function writeAudio(
  path: string,
  bytes: Uint8Array,
  force: boolean = false,
  signal?: AbortSignal,
): Promise<string> {
  const target = resolve(path);
  const temp = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    checkAbort(signal);
    await mkdir(dirname(target), { recursive: true });
    const file = await open(temp, "wx", 0o644);
    created = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    checkAbort(signal);
    if (force) {
      await rename(temp, target);
      created = false;
    } else {
      await link(temp, target);
    }
    return target;
  } catch (error) {
    if (error instanceof KongyoroidError) throw error;
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw new KongyoroidError(
      {
        code: "IO_ERROR",
        message:
          code === "EEXIST"
            ? `Refusing to overwrite ${target}.`
            : `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        ...(code === "EEXIST" ? { hint: "Pass --force (CLI) or force: true (library) to replace it." } : {}),
      },
      error,
    );
  } finally {
    if (created) await unlink(temp).catch(() => undefined);
  }
}

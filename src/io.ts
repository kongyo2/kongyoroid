import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin } from "node:process";
import type { Readable, Writable } from "node:stream";
import { KongyoroidError, aborted, checkAbort, invalid } from "./errors.ts";
import { LIMITS } from "./limits.ts";

export function writeStream(stream: Writable, content: string | Uint8Array): Promise<void> {
  return new Promise<void>((done, reject) => {
    const ok = stream.write(content, (error?: Error | null): void => {
      if (error) reject(error);
      else done();
    });
    void ok;
  });
}

export function writeWithBackpressure(
  stream: Writable,
  content: string | Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((done, reject) => {
    if (signal?.aborted) {
      reject(aborted("Output cancelled."));
      return;
    }
    const proceed = stream.write(content, (error?: Error | null): void => {
      if (error) reject(error);
    });
    if (proceed) {
      done();
      return;
    }
    const onDrain = (): void => {
      cleanup();
      done();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(aborted("Output cancelled."));
    };
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
      stream.removeListener("close", onDrain);
      signal?.removeEventListener("abort", onAbort);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onDrain);
    signal?.addEventListener("abort", onAbort, { once: true });
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

export async function ensureReadableFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a regular file");
    await access(path, constants.R_OK);
  } catch (error) {
    throw ioError(`Could not read ${path}`, error);
  }
}

export async function readBytes(path: string, limit: number = LIMITS.responseBytes): Promise<Uint8Array> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > limit) invalid("$.input", `File exceeds ${limit} bytes.`);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (error) {
    throw ioError(`Could not read ${path}`, error);
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

export async function* readChunks(
  path: string,
  signal?: AbortSignal,
  limit: number = LIMITS.inputBytes,
): AsyncGenerator<string, void, void> {
  const stream = source(path);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  const abort = (): void => {
    stream.destroy(aborted("Input cancelled."));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    checkAbort(signal);
    for await (const raw of stream) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) invalid("$.input", "Expected byte input.");
      total += chunk.length;
      if (total > limit) invalid("$.input", `Input exceeds ${limit} bytes.`);
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) yield text;
      checkAbort(signal);
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } catch (error) {
    throw ioError(`Could not read ${path === "-" ? "standard input" : path}`, error);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (path !== "-") stream.destroy();
  }
}

export interface WriteAudioResult {
  readonly path: string;
  readonly written: boolean;
  readonly unchanged: boolean;
}

export async function existingFileSha256(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}

export async function writeAudio(
  path: string,
  bytes: Uint8Array,
  force: boolean = false,
  signal?: AbortSignal,
): Promise<string> {
  return (await writeAudioIdempotent(path, bytes, force, signal)).path;
}

export async function writeAudioIdempotent(
  path: string,
  bytes: Uint8Array,
  force: boolean = false,
  signal?: AbortSignal,
): Promise<WriteAudioResult> {
  const target = resolve(path);
  const temp = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    checkAbort(signal);
    if (!force) {
      const existing = await existingFileSha256(target);
      if (existing !== undefined) {
        const incoming = createHash("sha256").update(bytes).digest("hex");
        if (existing === incoming) return { path: target, written: false, unchanged: true };
        throw new KongyoroidError({
          code: "IO_ERROR",
          message: `Refusing to overwrite ${target}: it exists with different content.`,
          retryable: false,
          hint: "Pass --force (CLI) or force: true (library) to replace it, or choose another --output path.",
          repairOptions: [{ action: "use-force", description: "Overwrite the existing file with --force." }],
        });
      }
    }
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
    return { path: target, written: true, unchanged: false };
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
        ...(code === "EEXIST"
          ? {
              hint: "Pass --force (CLI) or force: true (library) to replace it.",
              repairOptions: [
                { action: "use-force" as const, description: "Overwrite the existing file with --force." },
              ],
            }
          : {}),
      },
      error,
    );
  } finally {
    if (created) await unlink(temp).catch(() => undefined);
  }
}

export async function writeTextFile(path: string, text: string, force: boolean = false): Promise<string> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  try {
    const file = await open(target, force ? "w" : "wx", 0o644);
    try {
      await file.writeFile(text);
    } finally {
      await file.close();
    }
    return target;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw new KongyoroidError(
      {
        code: "IO_ERROR",
        message:
          code === "EEXIST"
            ? `Refusing to overwrite ${target}.`
            : `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        ...(code === "EEXIST" ? { hint: "Pass --force to replace it." } : {}),
      },
      error,
    );
  }
}

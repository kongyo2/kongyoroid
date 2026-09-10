import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isObject } from "../../src/validate.ts";

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: Buffer;
}

export const CLI_PATH: string = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface TimedChunk {
  readonly text: string;
  readonly afterMs: number;
}

export function runCli(
  args: readonly string[],
  options: {
    readonly input?: string | Buffer;
    readonly inputChunks?: readonly TimedChunk[];
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
  } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
      env: { ...process.env, KONGYOROID_ENDPOINT: "http://127.0.0.1:1", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const stdoutBytes = Buffer.concat(out);
      resolve({ code, stdout: stdoutBytes.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), stdoutBytes });
    });
    if (options.inputChunks !== undefined) {
      const chunks = [...options.inputChunks];
      const feed = (): void => {
        const next = chunks.shift();
        if (next === undefined) {
          child.stdin.end();
          return;
        }
        setTimeout(() => {
          child.stdin.write(next.text);
          feed();
        }, next.afterMs);
      };
      feed();
    } else if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function record(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`);
  return value;
}

export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${JSON.stringify(value)}`);
  return value;
}

export function pick(value: unknown, ...keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (Array.isArray(current)) {
      current = current[Number(key)];
      continue;
    }
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function lastJson(text: string): Record<string, unknown> {
  const lines = text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`no JSON output in ${JSON.stringify(text)}`);
  return record(JSON.parse(last));
}

export function allJson(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => record(JSON.parse(line)));
}

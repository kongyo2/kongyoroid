import process from "node:process";
import { parseArgs } from "node:util";
import { invalid } from "../errors.ts";
import type { JsonObject } from "../validate.ts";

export const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  text: { type: "string", short: "t" },
  input: { type: "string", short: "i" },
  output: { type: "string", short: "o" },
  "output-dir": { type: "string" },
  "plan-out": { type: "string" },
  force: { type: "boolean" },
  play: { type: "boolean" },
  "dry-run": { type: "boolean" },
  stream: { type: "boolean" },
  format: { type: "string" },
  progress: { type: "boolean" },
  "flush-ms": { type: "string" },
  diagnostics: { type: "string" },
  detail: { type: "string" },
  engine: { type: "string" },
  voice: { type: "string" },
  endpoint: { type: "string" },
  "timeout-ms": { type: "string" },
  retries: { type: "string" },
  concurrency: { type: "string" },
  "cache-dir": { type: "string" },
  cache: { type: "boolean" },
  dictionary: { type: "string" },
  "dict-entry": { type: "string", multiple: true },
  "strict-reading": { type: "boolean" },
  kana: { type: "string" },
  speaker: { type: "string" },
  speed: { type: "string" },
  pitch: { type: "string" },
  "pitch-semitones": { type: "string" },
  intonation: { type: "string" },
  volume: { type: "string" },
  "gain-db": { type: "string" },
  breathiness: { type: "string" },
  "pre-pause": { type: "string" },
  "post-pause": { type: "string" },
  "pause-length": { type: "string" },
  "pause-scale": { type: "string" },
  upspeak: { type: "boolean" },
  split: { type: "string" },
  "sample-rate": { type: "string" },
  seed: { type: "string" },
  lyrics: { type: "string" },
  melody: { type: "string" },
  beats: { type: "string" },
  mml: { type: "string" },
  tempo: { type: "string" },
  singer: { type: "string" },
  teacher: { type: "string" },
  transpose: { type: "string" },
  "vibrato-depth": { type: "string" },
  "vibrato-rate": { type: "string" },
  "vibrato-delay-ms": { type: "string" },
  "vibrato-fade-ms": { type: "string" },
  "portamento-ms": { type: "string" },
  "scoop-cents": { type: "string" },
  "scoop-ms": { type: "string" },
  "consonant-compression": { type: "boolean" },
  "lead-in": { type: "string" },
  "lead-out": { type: "string" },
  kind: { type: "string" },
  query: { type: "string" },
  initialize: { type: "boolean" },
  scope: { type: "string" },
  surface: { type: "string" },
  reading: { type: "string" },
  pronunciation: { type: "string" },
  accent: { type: "string" },
  match: { type: "string" },
  priority: { type: "string" },
  id: { type: "string" },
  "word-type": { type: "string" },
  "max-bytes": { type: "string" },
  "max-entries": { type: "string" },
  "pitch-track": { type: "boolean" },
  "window-ms": { type: "string" },
  "stop-on-error": { type: "boolean" },
} as const;

export type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export function parseCommandLine(argv: readonly string[]): { readonly values: Values; readonly positionals: string[] } {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
}

const COMMON = [
  "json",
  "engine",
  "voice",
  "endpoint",
  "timeout-ms",
  "retries",
  "concurrency",
  "cache-dir",
  "cache",
  "dictionary",
];
const OUTPUT = ["output", "force", "play", "plan-out", "dry-run", "diagnostics"];
const SPEECH = [
  "text",
  "input",
  "kana",
  "dict-entry",
  "strict-reading",
  "speaker",
  "speed",
  "pitch",
  "pitch-semitones",
  "intonation",
  "volume",
  "gain-db",
  "breathiness",
  "pre-pause",
  "post-pause",
  "pause-length",
  "pause-scale",
  "upspeak",
  "split",
  "sample-rate",
  "seed",
];
const STREAM = ["stream", "format", "progress", "flush-ms"];
const SONG = [
  "input",
  "lyrics",
  "melody",
  "beats",
  "mml",
  "tempo",
  "singer",
  "teacher",
  "transpose",
  "volume",
  "gain-db",
  "breathiness",
  "vibrato-depth",
  "vibrato-rate",
  "vibrato-delay-ms",
  "vibrato-fade-ms",
  "portamento-ms",
  "scoop-cents",
  "scoop-ms",
  "consonant-compression",
  "lead-in",
  "lead-out",
  "sample-rate",
  "seed",
];

export const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  speak: [...COMMON, ...OUTPUT, ...SPEECH, ...STREAM],
  sing: [...COMMON, ...OUTPUT, ...SONG],
  render: [...COMMON, ...OUTPUT, "input"],
  validate: [...COMMON, "input", "diagnostics", ...SPEECH, ...SONG],
  plan: [...COMMON, "input", "detail", ...SPEECH, ...SONG],
  batch: [...COMMON, "input", "output-dir", "force", "stop-on-error"],
  reading: [...COMMON, "text", "input", "kana", "dict-entry", "strict-reading", "speaker"],
  inspect: ["json", "input", "pitch-track", "window-ms"],
  voices: [...COMMON, "kind", "query"],
  doctor: [...COMMON, "speaker", "initialize"],
  dict: [
    ...COMMON,
    "scope",
    "surface",
    "reading",
    "pronunciation",
    "accent",
    "match",
    "priority",
    "id",
    "word-type",
    "dry-run",
    "text",
    "input",
  ],
  cache: ["json", "cache-dir", "max-bytes", "max-entries", "dry-run"],
  play: ["json"],
  schema: ["json", "kind"],
  capabilities: ["json"],
  help: [],
};

export function numberFlag(values: Values, name: keyof Values): number | undefined {
  const raw = values[name];
  if (raw === undefined || typeof raw !== "string") return undefined;
  const value = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isFinite(value)) {
    invalid(`$flags.${name}`, `Expected a number for --${name}, got ${JSON.stringify(raw)}.`, {
      hint: `Example: --${name} ${name === "tempo" ? "120" : name === "sample-rate" ? "24000" : "1"}`,
    });
  }
  return value;
}

export function styleFlag(values: Values, name: "speaker" | "singer" | "teacher"): string | number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  return /^\d+$/u.test(raw.trim()) ? Number(raw) : raw;
}

export function assign(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

export function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

export function checkAllowed(command: string, values: Values): void {
  const allowed = ALLOWED[command] ?? [];
  for (const key of Object.keys(values)) {
    if (key === "help" || key === "version") continue;
    if (!allowed.includes(key)) {
      invalid(`$flags.${key}`, `--${key} is not accepted by ${command}.`, {
        hint: `Run: kongyoroid ${command} --help`,
      });
    }
  }
}

export function parseDictEntries(values: Values): readonly { surface: string; reading: string; accent?: number }[] {
  const raw = values["dict-entry"];
  if (raw === undefined) return [];
  return raw.map((item, index) => {
    const match = /^([^=]+)=([^:]+)(?::(\d+))?$/u.exec(item.trim());
    if (match === null) {
      invalid(`$flags.dict-entry[${index}]`, `Expected SURFACE=READING[:ACCENT], got ${JSON.stringify(item)}.`, {
        hint: "Example: --dict-entry kongyoroid=コンギョロイド:0",
      });
    }
    return {
      surface: (match[1] ?? "").trim(),
      reading: (match[2] ?? "").trim(),
      ...(match[3] === undefined ? {} : { accent: Number(match[3]) }),
    };
  });
}

import { VERSION } from "../version.ts";

export interface CommandHelp {
  readonly summary: string;
  readonly usage: string;
  readonly description: string;
  readonly options: readonly (readonly [string, string])[];
  readonly examples: readonly string[];
}

const COMMON_OPTIONS: readonly (readonly [string, string])[] = [
  ["--engine formant|voicevox|auto", "Engine (default formant; a VOICEVOX style selects voicevox)"],
  ["--voice ID", "Built-in voice: neutral, female, male, child, soft, bright, deep"],
  ["--dictionary FILE", "Local reading dictionary JSON (or KONGYOROID_DICTIONARY)"],
  ["--cache-dir DIR", "On-disk render cache (a kongyoroid-cache subdirectory is created)"],
  ["--no-cache", "Disable the render cache for this run"],
  ["--endpoint URL", "VOICEVOX ENGINE base URL (default http://127.0.0.1:50021)"],
  ["--timeout-ms N", "VOICEVOX HTTP timeout per request"],
  ["--retries N", "VOICEVOX HTTP retries for retryable failures"],
  ["--concurrency N", "Parallel renders (batch) and HTTP requests"],
];

const OUTPUT_OPTIONS: readonly (readonly [string, string])[] = [
  ["-o, --output FILE|-", "WAV path (default kongyoroid-<kind>-<hash>.wav); - streams bytes to stdout, JSON to stderr"],
  ["--force", "Replace an existing output file (identical content is a no-op without --force)"],
  ["--play", "Play the result with the system player after writing"],
  ["--plan-out FILE|-", "Also write the synthesis plan (reading, phonemes, timing) as JSON; formant engine only"],
  ["--dry-run", "Validate and plan only; write nothing (same output as validate)"],
  ["--diagnostics json|compact", "How warnings are reported: inside the JSON (default) or one line each on stderr"],
];

const SPEECH_OPTIONS: readonly (readonly [string, string])[] = [
  ["-t, --text TEXT", "Text to read (kanji, kana, numbers, ASCII words)"],
  ["-i, --input FILE|-", "Read the text from a file or stdin"],
  [
    "--kana NOTATION",
    "Pronunciation override with optional accent marks: コンニチワ、キョ'ーワ/イ'イ/テ'ンキデ_スネ？",
  ],
  [
    "--dict-entry SURFACE=READING[:ACCENT]",
    "One-off reading override (repeatable), e.g. --dict-entry kongyoroid=コンギョロイド:0",
  ],
  ["--no-strict-reading", "Skip unreadable characters with a warning instead of failing"],
  ["--speed N", "Rate multiplier 0.25–4 (default 1)"],
  ["--pitch-semitones N", "Shift the base pitch in semitones (-24..24)"],
  ["--pitch N", "VOICEVOX pitchScale semantics (-1..1, practical ±0.15); not with --pitch-semitones"],
  ["--intonation N", "Pitch-range multiplier 0–3 (default 1)"],
  ["--volume N | --gain-db N", "Output level (linear 0–3, or dB)"],
  ["--breathiness N", "Glottal tension offset -1..1.5 (positive = breathier)"],
  ["--pre-pause S, --post-pause S", "Leading/trailing silence in seconds (default 0.1)"],
  ["--pause-length S, --pause-scale N", "Absolute 、 pause length, and pause multiplier"],
  ["--no-upspeak", "Do not raise the end of questions"],
  ["--sample-rate HZ", "8000–48000 (default 24000)"],
  ["--seed N", "Noise seed (default 1)"],
  ["--speaker ID|NAME", "VOICEVOX speech style (selects the voicevox engine)"],
  ["--split sentence|paragraph|none", "VOICEVOX chunking"],
];

const STREAM_OPTIONS: readonly (readonly [string, string])[] = [
  ["--stream", "Synthesize sentence by sentence as text arrives (stdin, file, or --text) and emit audio immediately"],
  [
    "--format wav|pcm|ndjson",
    "Stream format for --output -: wav (unknown-length header), pcm (raw s16le mono), ndjson (JSON lines with base64 audio)",
  ],
  ["--progress", "With --stream, print a JSON line per sentence on stderr"],
  [
    "--flush-ms N",
    "With --stream, speak a pending partial sentence after N ms without new input (default: wait for 。！？ or newline)",
  ],
];

const SONG_OPTIONS: readonly (readonly [string, string])[] = [
  ["--lyrics KANA", "Kana lyrics, one mora per pitched note"],
  ["--melody NOTES", 'Notes: "C4 D4 E4 R ~ ~G4" (R rest, ~ tie, ~G4 melisma to G4)'],
  ["--beats LIST", 'Beats per note: "1 1 2 0.5"; one value applies to all (default 1)'],
  ["--mml MML", 'MML score instead of --melody: "t120 o4 l8 c d e f g4 r4 e&e"'],
  ["-i, --input FILE|-", "Song request JSON (flags override its fields)"],
  ["--tempo BPM", "20–400 (default 120 or the MML tempo)"],
  ["--transpose N", "Semitones -48..48"],
  ["--vibrato-depth CENTS, --vibrato-rate HZ", "Vibrato (default 30 cents, 5.5 Hz; 0 disables)"],
  ["--vibrato-delay-ms MS, --vibrato-fade-ms MS", "Vibrato onset per sustained vowel"],
  ["--portamento-ms MS", "Pitch transition between connected notes (default 60; 0 = step)"],
  ["--scoop-cents N", "Start phrase-initial notes below pitch and slide up"],
  ["--no-consonant-compression", "Fail with NOTE_TOO_SHORT instead of shortening consonants"],
  ["--lead-in S, --lead-out S", "Rests around the score (default 0.16)"],
  ["--volume N | --gain-db N", "Output level"],
  ["--breathiness N", "Glottal tension offset"],
  ["--sample-rate HZ, --seed N", "Output rate and noise seed"],
  ["--singer ID|NAME, --teacher ID|NAME", "VOICEVOX singing styles (select the voicevox engine)"],
];

export const COMMANDS: Readonly<Record<string, CommandHelp>> = {
  speak: {
    summary: "Read Japanese text aloud",
    usage: "kongyoroid speak (--text TEXT | --input FILE|-) [options]",
    description:
      "Reads ordinary Japanese (kanji, kana, numbers, dates, ASCII words) with the built-in engine. Readings and accents come from the jpreprocess frontend and can be overridden with --kana or dictionaries. Prints one JSON line with the output path and metadata.",
    options: [...SPEECH_OPTIONS, ...STREAM_OPTIONS, ...OUTPUT_OPTIONS, ...COMMON_OPTIONS],
    examples: [
      'kongyoroid speak --text "こんにちは。今日はいい天気ですね？" -o hello.wav',
      'kongyoroid speak --text "橋の端で箸を使う" --kana "ハシノ/ハシデ/ハ\'シヲ/ツカウ" -o hashi.wav',
      'kongyoroid speak --text "kongyoroidは便利です" --dict-entry kongyoroid=コンギョロイド:0 -o dict.wav',
      "kongyoroid speak --input notes.txt --voice female --speed 1.1 -o notes.wav --play",
      'kongyoroid speak --text "テストが3件失敗しました" --dry-run',
      "llm-agent run | kongyoroid speak --input - --stream --output - --format pcm | aplay -f S16_LE -r 24000 -c 1",
      'kongyoroid speak --text "ずんだもんなのだ" --speaker ずんだもん -o zunda.wav',
    ],
  },
  sing: {
    summary: "Sing a score (lyrics + melody, MML, or a note list)",
    usage: "kongyoroid sing (--lyrics KANA --melody NOTES | --mml MML [--lyrics KANA] | --input FILE|-) [options]",
    description:
      "Sings kana lyrics on a melody with the built-in engine: ties, melismas, re-articulation, per-note velocity and vibrato are supported in the JSON note list. Prints one JSON line with the output path and metadata.",
    options: [...SONG_OPTIONS, ...OUTPUT_OPTIONS, ...COMMON_OPTIONS],
    examples: [
      'kongyoroid sing --lyrics "ドレミファソラシド" --melody "C4 D4 E4 F4 G4 A4 B4 C5" --beats "1 1 1 1 1 1 1 2" --tempo 100 -o scale.wav',
      'kongyoroid sing --lyrics "きらきらぼしー" --melody "C4 C4 G4 G4 A4 A4 G4 ~ R" --beats "1 1 1 1 1 1 1 1 2" -o twinkle.wav',
      'kongyoroid sing --mml "t140 o4 l8 c d e f g4 r4 e&e d4 c2" --lyrics "どれみふぁそみれど" -o mml.wav',
      'kongyoroid sing --lyrics "あ" --melody "C4 ~E4 ~G4" --beats "1 1 2" --vibrato-depth 0 --portamento-ms 0 -o melisma.wav',
      "kongyoroid sing --input song.json --transpose -2 --voice male -o song.wav",
      'kongyoroid sing --lyrics "ドレミ" --melody "C4 D4 E4" --singer ずんだもん -o voicevox.wav',
    ],
  },
  render: {
    summary: "Render a full JSON request (speech or song)",
    usage: "kongyoroid render --input FILE|- [options]",
    description:
      "Renders a request that follows the JSON Schema printed by the schema command. Flags such as --engine, --voice, and --dictionary override or supplement the request.",
    options: [["-i, --input FILE|-", "Request JSON (required)"], ...OUTPUT_OPTIONS, ...COMMON_OPTIONS],
    examples: [
      "kongyoroid render --input request.json -o out.wav",
      'echo \'{"kind":"speech","text":"読み上げのテスト"}\' | kongyoroid render --input - -o test.wav',
      "kongyoroid render --input song.json --plan-out song.plan.json -o song.wav",
      "kongyoroid render --input request.json --dry-run",
    ],
  },
  validate: {
    summary: "Validate a request and estimate its output without rendering",
    usage: "kongyoroid validate (--input FILE|- | --text TEXT | --lyrics KANA --melody NOTES | --mml MML) [options]",
    description:
      "Checks structure and semantics (readings, note timing, pitch range), and returns the estimated duration and size, warnings, adjustments, and hashes. Exit code 2 means the request cannot be rendered as written.",
    options: [
      ["-i, --input FILE|-", "Request JSON"],
      ...SPEECH_OPTIONS.slice(0, 5),
      ...SONG_OPTIONS.slice(0, 4),
      ["--diagnostics json|compact", "Warnings inside the JSON (default) or one compact line per warning on stdout"],
      ...COMMON_OPTIONS,
    ],
    examples: [
      "kongyoroid validate --input request.json",
      'kongyoroid validate --text "2026年9月7日 9:05に会議"',
      'kongyoroid validate --lyrics "きらきら" --melody "C4 C4 G4" --diagnostics compact',
    ],
  },
  plan: {
    summary: "Show reading, phonemes, notes, and timing of a request",
    usage:
      "kongyoroid plan (--input FILE|- | --text TEXT | --lyrics KANA --melody NOTES | --mml MML) [--detail summary|phonemes|acoustics] [options]",
    description:
      "Compiles the request with the built-in engine and prints the plan: accent phrases with sources, mora and note boundaries in seconds, pitch range, warnings, and adjustments. Use it to check readings before rendering, or --detail phonemes for phoneme-level timing.",
    options: [
      ["-i, --input FILE|-", "Request JSON"],
      ["--detail summary|phonemes|acoustics", "Level of detail (default summary)"],
      ...SPEECH_OPTIONS.slice(0, 5),
      ...SONG_OPTIONS.slice(0, 4),
      ...COMMON_OPTIONS,
    ],
    examples: [
      'kongyoroid plan --text "こんにちは、世界"',
      "kongyoroid plan --input song.json --detail phonemes",
      'kongyoroid plan --lyrics "あ" --melody "C4 ~E4" --detail acoustics | jq .plan.notes',
    ],
  },
  batch: {
    summary: "Render many JSONL jobs; also a persistent session for agents",
    usage: "kongyoroid batch --input FILE|- --output-dir DIR [options]",
    description:
      'Each input line is {"id":"name","request":{...}}. Jobs are rendered as lines arrive (stdin works as a long-lived session), results are printed as JSON lines in completion order, failures do not stop the batch, and the exit code is the worst job result.',
    options: [
      ["-i, --input FILE|-", "JSONL jobs (required)"],
      ["--output-dir DIR", "Directory for <id>.wav files (required)"],
      ["--force", "Replace existing files"],
      ["--concurrency N", "Parallel jobs (default 2)"],
      ["--stop-on-error", "Stop after the first failed job"],
      ...COMMON_OPTIONS,
    ],
    examples: [
      "kongyoroid batch --input jobs.jsonl --output-dir out",
      "cat jobs.jsonl | kongyoroid batch --input - --output-dir out --concurrency 4",
      'printf \'%s\\n\' \'{"id":"a","request":{"kind":"speech","text":"一件目"}}\' | kongyoroid batch -i - --output-dir out',
    ],
  },
  reading: {
    summary: "Show how text will be read (kana with accents, phrases, sources)",
    usage: "kongyoroid reading (--text TEXT | --input FILE|-) [--kana NOTATION] [options]",
    description:
      "Prints the reading the engine will use: kana notation with accent marks, accent phrases with their sources (frontend, dictionary, user), dictionary hits, and warnings. Works offline with the built-in frontend; --engine voicevox asks the VOICEVOX ENGINE instead.",
    options: [
      ["-t, --text TEXT", "Text to analyse"],
      ["-i, --input FILE|-", "Read the text from a file or stdin"],
      ["--kana NOTATION", "Pronunciation to normalize instead of analysing text"],
      ["--dict-entry SURFACE=READING[:ACCENT]", "One-off reading override (repeatable)"],
      ["--no-strict-reading", "Skip unreadable characters with a warning"],
      ["--speaker ID|NAME", "VOICEVOX style for --engine voicevox"],
      ...COMMON_OPTIONS,
    ],
    examples: [
      'kongyoroid reading --text "橋の端で箸を使う"',
      'kongyoroid reading --text "kongyoroidはLLM向けです" --dict-entry kongyoroid=コンギョロイド:0',
      'kongyoroid reading --text "今日は" --engine voicevox --speaker 3',
    ],
  },
  inspect: {
    summary: "Inspect a WAV file (format, level, pitch)",
    usage: "kongyoroid inspect FILE.wav [--pitch-track] [--window-ms N]",
    description:
      "Prints sample rate, duration, peak, RMS, clipped samples, and an F0 estimate (median, range, voiced ratio) for a WAV file. --pitch-track adds a per-window pitch track.",
    options: [
      ["--pitch-track", "Include the per-window F0 track"],
      ["--window-ms N", "Analysis window in milliseconds (default 40)"],
    ],
    examples: [
      "kongyoroid inspect out.wav",
      "kongyoroid inspect song.wav --pitch-track --window-ms 30 | jq .pitch.track",
    ],
  },
  voices: {
    summary: "List voices (built-in, and VOICEVOX styles when reachable)",
    usage: "kongyoroid voices [--engine formant|voicevox|all] [--kind speech|song|all] [--query TEXT]",
    description:
      "Lists built-in voices with their pitch ranges, and VOICEVOX styles when --engine is voicevox or all and the engine answers. An unreachable VOICEVOX is reported, not fatal, unless --engine voicevox is given.",
    options: [
      ["--engine formant|voicevox|all", "Which engines to list (default: all, VOICEVOX best-effort)"],
      ["--kind speech|song|all", "Filter VOICEVOX styles by purpose"],
      ["--query TEXT", "Substring filter on id, name, or character"],
      ...COMMON_OPTIONS.slice(5, 8),
    ],
    examples: [
      "kongyoroid voices",
      "kongyoroid voices --engine formant",
      "kongyoroid voices --engine voicevox --kind song --query めたん",
    ],
  },
  doctor: {
    summary: "Check the runtime: frontend, synthesis, cache, and optional VOICEVOX",
    usage: "kongyoroid doctor [--engine formant|voicevox|all|auto] [--speaker ID] [--initialize]",
    description:
      "Runs a self-test of the built-in engine (frontend load, short synthesis) and reports cache and dictionary status. VOICEVOX is checked only for --engine voicevox, auto, or all. Exit code 3 when the checked engine is unusable.",
    options: [
      ["--engine formant|voicevox|all|auto", "What to check (default: the configured default engine)"],
      ["--speaker ID|NAME", "VOICEVOX style to inspect"],
      ["--initialize", "Initialize the VOICEVOX style"],
      ...COMMON_OPTIONS,
    ],
    examples: [
      "kongyoroid doctor",
      "kongyoroid doctor --engine all",
      "kongyoroid doctor --engine voicevox --speaker 3 --initialize",
    ],
  },
  dict: {
    summary: "Manage reading dictionaries (local file or VOICEVOX user dictionary)",
    usage: "kongyoroid dict <list|add|update|delete|check> [--scope local|voicevox] [options]",
    description:
      "Local scope edits a JSON dictionary file (default KONGYOROID_DICTIONARY or ./kongyoroid-dictionary.json) that the built-in engine applies to text. VOICEVOX scope edits the engine's user dictionary. Adding an existing surface with the same reading is a no-op.",
    options: [
      ["--scope local|voicevox", "Which dictionary (default local)"],
      ["--dictionary FILE", "Local dictionary path"],
      ["--surface TEXT", "Text to match"],
      ["--reading KANA", "Pronunciation in kana (alias: --pronunciation)"],
      ["--accent N", "Accent nucleus mora (0 = flat); omit to let the frontend decide"],
      ["--match word|anywhere", "Local: matching mode (default word)"],
      ["--priority N", "0–10 (default 5)"],
      ["--id ID", "Local: entry id for update/delete"],
      ["--word-type TYPE", "VOICEVOX: PROPER_NOUN|COMMON_NOUN|VERB|ADJECTIVE|SUFFIX"],
      ["--dry-run", "Show the change without writing"],
    ],
    examples: [
      "kongyoroid dict add --surface kongyoroid --reading コンギョロイド --accent 0",
      "kongyoroid dict add --surface 端 --reading ハシ --accent 0 --dictionary ./readings.json",
      "kongyoroid dict list",
      'kongyoroid dict check --text "kongyoroidの端"',
      "kongyoroid dict delete --id entry-1",
      "kongyoroid dict add --scope voicevox --surface 金曜日 --reading キンヨウビ --accent 3",
    ],
  },
  cache: {
    summary: "Show, prune, or clear the on-disk render cache",
    usage: "kongyoroid cache <stats|prune|clear> [--cache-dir DIR] [--max-bytes N] [--max-entries N] [--dry-run]",
    description:
      "Operates only on files inside <cache-dir>/kongyoroid-cache; unrelated files in the directory are never touched.",
    options: [
      ["--cache-dir DIR", "Cache directory (or KONGYOROID_CACHE_DIR)"],
      ["--max-bytes N", "prune: keep at most this many bytes"],
      ["--max-entries N", "prune: keep at most this many entries"],
      ["--dry-run", "Report what would be removed"],
    ],
    examples: [
      "kongyoroid cache stats --cache-dir ~/.cache/kongyoroid",
      "kongyoroid cache prune --cache-dir ./cache --max-bytes 200000000",
      "kongyoroid cache clear --cache-dir ./cache",
    ],
  },
  play: {
    summary: "Play a WAV file with the system player",
    usage: "kongyoroid play FILE.wav",
    description: "Tries afplay (macOS), paplay/aplay/ffplay/play (Linux), or PowerShell (Windows).",
    options: [],
    examples: ["kongyoroid play out.wav"],
  },
  schema: {
    summary: "Print a JSON Schema",
    usage: "kongyoroid schema [--kind request|batch|dictionary]",
    description: "Prints the JSON Schema (draft 2020-12) for render requests, batch jobs, or dictionary files.",
    options: [["--kind request|batch|dictionary", "Which schema (default request)"]],
    examples: ["kongyoroid schema", "kongyoroid schema --kind batch > batch.schema.json"],
  },
  capabilities: {
    summary: "Machine-readable feature descriptor",
    usage: "kongyoroid capabilities",
    description:
      "Prints engines, voices, limits, commands, environment variables, exit codes, and error codes as JSON.",
    options: [],
    examples: ["kongyoroid capabilities | jq .engines.formant"],
  },
};

export function rootHelp(): string {
  const lines = [
    `kongyoroid ${VERSION} — Japanese speech and singing for LLM agents (built-in formant engine; VOICEVOX optional)`,
    "",
    "Usage: kongyoroid <command> [options]",
    "       kongyoroid <command> --help",
    "",
    "Commands",
  ];
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((name) => name.length)) + 2;
  for (const name of names) lines.push(`  ${name.padEnd(width)}${COMMANDS[name]?.summary ?? ""}`);
  lines.push(
    "",
    'Output: one JSON object per line on stdout ({ "ok": true, ... }); errors on stderr ({ "ok": false, "error": {...} }).',
    "Exit codes: 0 ok, 1 internal, 2 input, 3 engine, 4 io, 130 cancelled.",
    "Environment: KONGYOROID_ENGINE, KONGYOROID_VOICE, KONGYOROID_DICTIONARY, KONGYOROID_CACHE_DIR,",
    "  KONGYOROID_ENDPOINT (or VOICEVOX_URL), KONGYOROID_SPEAKER, KONGYOROID_SINGER, KONGYOROID_TEACHER",
    "",
    "Examples",
    '  kongyoroid speak --text "こんにちは" -o hello.wav',
    '  kongyoroid sing --lyrics "ドレミ" --melody "C4 D4 E4" -o scale.wav',
    '  kongyoroid plan --text "橋の端で箸を使う"',
    "",
  );
  return lines.join("\n");
}

export function commandHelp(name: string): string {
  const help = COMMANDS[name];
  if (help === undefined) return rootHelp();
  const lines = [`kongyoroid ${name} — ${help.summary}`, "", `Usage: ${help.usage}`, "", help.description, ""];
  if (help.options.length > 0) {
    lines.push("Options");
    const width = Math.min(44, Math.max(...help.options.map(([flag]) => flag.length)) + 2);
    for (const [flag, description] of help.options) {
      if (flag.length + 2 > width) {
        lines.push(`  ${flag}`);
        lines.push(`  ${"".padEnd(width)}${description}`);
      } else {
        lines.push(`  ${flag.padEnd(width)}${description}`);
      }
    }
    lines.push("");
  }
  lines.push("Examples");
  for (const example of help.examples) lines.push(`  ${example}`);
  lines.push("");
  return lines.join("\n");
}

import type { SourceSpan } from "../errors.ts";

export type SentenceTerminal = "。" | "！" | "？" | "";

export interface SentencePiece {
  readonly text: string;
  readonly sourceSpan: SourceSpan;
  readonly terminal: SentenceTerminal;
  readonly paragraphEnd: boolean;
}

const HARD_TERMINALS: ReadonlySet<string> = new Set(["。", "！", "？", "!", "?", "．"]);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && /^[0-9０-９]$/u.test(char);
}

function isAsciiWord(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9]$/u.test(char);
}

function terminalOf(char: string): SentenceTerminal {
  switch (char) {
    case "！":
    case "!":
      return "！";
    case "？":
    case "?":
      return "？";
    default:
      return "。";
  }
}

export function splitSentences(text: string): readonly SentencePiece[] {
  const chars = Array.from(text);
  const pieces: SentencePiece[] = [];
  let start = 0;
  let index = 0;
  const flush = (end: number, terminal: SentenceTerminal, next: number, paragraphEnd: boolean): void => {
    const body = chars.slice(start, end).join("");
    if (body.trim().length > 0) {
      pieces.push({ text: body, sourceSpan: { start, end, unit: "unicode-code-point" }, terminal, paragraphEnd });
    } else if (paragraphEnd && pieces.length > 0) {
      const last = pieces[pieces.length - 1];
      if (last !== undefined) pieces[pieces.length - 1] = { ...last, paragraphEnd: true };
    }
    start = next;
  };
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (char === "\n") {
      let run = index;
      while (chars[run] === "\n" || chars[run] === "\r" || chars[run] === " " || chars[run] === "\t") run += 1;
      const newlines = chars.slice(index, run).filter((c) => c === "\n").length;
      flush(index, "", run, newlines >= 2);
      index = run;
      continue;
    }
    if (char === ".") {
      const previous = chars[index - 1];
      const next = chars[index + 1];
      const decimal = isDigit(previous) && isDigit(next);
      const dotted = isAsciiWord(previous) && isAsciiWord(next);
      if (decimal || dotted) {
        index += 1;
        continue;
      }
      let run = index + 1;
      while (run < chars.length && HARD_TERMINALS.has(chars[run] ?? "")) run += 1;
      flush(run, "。", run, false);
      index = run;
      continue;
    }
    if (HARD_TERMINALS.has(char)) {
      let run = index + 1;
      let terminal = terminalOf(char);
      while (run < chars.length && HARD_TERMINALS.has(chars[run] ?? "")) {
        const extra = terminalOf(chars[run] ?? "");
        if (extra === "？") terminal = "？";
        else if (extra === "！" && terminal !== "？") terminal = "！";
        run += 1;
      }
      flush(run, terminal, run, false);
      index = run;
      continue;
    }
    index += 1;
  }
  flush(chars.length, "", chars.length, false);
  return pieces;
}

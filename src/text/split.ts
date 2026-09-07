import { LIMITS } from "../limits.ts";
import type { SplitMode } from "../types.ts";

const SENTENCE_END: RegExp = /(?<=[。！？!?])/u;
const CLAUSE_END: RegExp = /(?<=[、,])/u;

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += max) out.push(chars.slice(index, index + max).join(""));
  return out;
}

function bounded(sentence: string, max: number): string[] {
  if (Array.from(sentence).length <= max) return [sentence];
  const out: string[] = [];
  let current = "";
  for (const clause of sentence.split(CLAUSE_END)) {
    if (Array.from(current).length + Array.from(clause).length > max && current.length > 0) {
      out.push(current);
      current = "";
    }
    if (Array.from(clause).length > max) {
      if (current.length > 0) out.push(current);
      current = "";
      out.push(...hardSplit(clause, max));
      continue;
    }
    current += clause;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function splitText(text: string, mode: SplitMode, maxChars: number = LIMITS.chunkChars): readonly string[] {
  if (mode === "none") return [text];
  const paragraphs = text
    .split(/\r?\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (mode === "paragraph") return paragraphs.length === 0 ? [text] : paragraphs;
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.split(SENTENCE_END)) {
      const trimmed = sentence.trim();
      if (trimmed.length === 0) continue;
      chunks.push(...bounded(trimmed, maxChars));
    }
  }
  return chunks.length === 0 ? [text] : chunks;
}

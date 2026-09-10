import type { Diagnostic } from "../errors.ts";
import { aborted, checkAbort } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import type { BoundaryKind } from "../text/notation.ts";
import { isSentenceCloser } from "../text/sentences.ts";
import type { ResolvedSpeech } from "../types.ts";
import type { CompileOptions } from "./engine.ts";
import { compileRequest } from "./engine.ts";
import type { SynthesisPlan } from "./plan.ts";
import type { PauseTiming } from "./speech.ts";
import { boundaryPauseSeconds, utteranceFinalPauseSeconds } from "./speech.ts";
import type { PcmBlock } from "./stream.ts";
import { renderPcmStream } from "./stream.ts";

export interface TextStreamOptions extends CompileOptions {
  readonly blockFrames?: number;
  readonly flushMs?: number;
  readonly maxSentenceChars?: number;
}

export type TextStreamEvent =
  | {
      readonly type: "sentence";
      readonly index: number;
      readonly text: string;
      readonly kana: string;
      readonly durationSeconds: number;
      readonly frames: number;
      readonly warnings: readonly Diagnostic[];
      readonly startFrame: number;
    }
  | { readonly type: "audio"; readonly index: number; readonly block: PcmBlock; readonly sequence: number }
  | { readonly type: "end"; readonly sentences: number; readonly frames: number; readonly durationSeconds: number };

const TERMINALS = /[。！？!?\n]/u;

export function takeSentences(
  buffer: string,
  maxChars: number,
): { readonly sentences: string[]; readonly rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const match = TERMINALS.exec(rest);
    if (match === null) {
      if (Array.from(rest).length >= maxChars) {
        const chars = Array.from(rest);
        const cut = lastPauseIndex(chars, maxChars);
        sentences.push(chars.slice(0, cut).join(""));
        rest = chars.slice(cut).join("");
        continue;
      }
      break;
    }
    let end = match.index + match[0].length;
    while (end < rest.length && (TERMINALS.test(rest[end] ?? "") || isSentenceCloser(rest[end] ?? ""))) end += 1;
    const sentence = rest.slice(0, end);
    rest = rest.slice(end);
    if (sentence.trim().length > 0) sentences.push(sentence);
  }
  return { sentences, rest };
}

const SPEAKABLE = /[\p{L}\p{N}]/u;

export function isSpeakable(text: string): boolean {
  return SPEAKABLE.test(text);
}

function chunkOrTimeout<T>(pending: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<undefined>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(aborted("Streaming cancelled."));
      return;
    }
    timer = setTimeout(() => resolve(undefined), ms);
    onAbort = (): void => reject(aborted("Streaming cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([pending, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  });
}

function lastPauseIndex(chars: readonly string[], maxChars: number): number {
  for (let index = Math.min(chars.length, maxChars) - 1; index > maxChars / 2; index--) {
    const char = chars[index];
    if (char === "、" || char === "," || char === " " || char === "　") return index + 1;
  }
  return Math.min(chars.length, maxChars);
}

export async function* synthesizeTextStream(
  chunks: AsyncIterable<string>,
  request: ResolvedSpeech,
  options: TextStreamOptions = {},
): AsyncGenerator<TextStreamEvent, void, void> {
  const maxChars = options.maxSentenceChars ?? LIMITS.streamSentenceChars;
  const sampleRate = options.sampleRate ?? 24_000;
  const timing: PauseTiming = {
    speed: request.speed,
    pauseLength: request.pauseLength,
    pauseScale: request.pauseScale,
  };
  let buffer = "";
  let index = 0;
  let sequence = 0;
  let frames = 0;
  let lastBoundary: BoundaryKind | undefined;
  let lastParagraphEnd = false;
  let pendingPlan: Promise<SynthesisPlan> | undefined;
  const leadPause = (): number => {
    if (lastBoundary === undefined) return request.prePause;
    return Math.max(
      0,
      boundaryPauseSeconds(lastBoundary, timing, lastParagraphEnd) - utteranceFinalPauseSeconds(lastBoundary, timing),
    );
  };
  const compile = (text: string): Promise<SynthesisPlan> =>
    compileRequest({ ...request, text, prePause: leadPause(), postPause: 0 }, sampleRate, options).then(
      (compiled) => compiled.plan,
    );
  const emit = async function* (text: string): AsyncGenerator<TextStreamEvent, void, void> {
    const plan = await (pendingPlan ?? compile(text));
    pendingPlan = undefined;
    lastBoundary = plan.reading?.phrases.at(-1)?.boundary ?? "sentence";
    lastParagraphEnd = plan.reading?.sentences.at(-1)?.paragraphEnd ?? false;
    const startFrame = frames;
    yield {
      type: "sentence",
      index,
      text,
      kana: plan.reading?.kana ?? "",
      durationSeconds: plan.frames / plan.sampleRate,
      frames: plan.frames,
      warnings: plan.warnings,
      startFrame,
    };
    const iterator = renderPcmStream(plan, {
      ...(options.blockFrames === undefined ? {} : { blockFrames: options.blockFrames }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      yield { type: "audio", index, block: { ...next.value, start: next.value.start + startFrame }, sequence };
      sequence += 1;
    }
    frames += plan.frames;
    index += 1;
  };
  const queue: string[] = [];
  const flushMs = options.flushMs !== undefined && options.flushMs > 0 ? options.flushMs : undefined;
  const iterator = chunks[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<string, void>> | undefined;
  let exhausted = false;
  try {
    while (!exhausted) {
      checkAbort(options.signal);
      pending ??= iterator.next();
      let result: IteratorResult<string, void>;
      if (flushMs !== undefined && buffer.trim().length > 0) {
        const raced = await chunkOrTimeout(pending, flushMs, options.signal);
        if (raced === undefined) {
          const text = buffer;
          buffer = "";
          pendingPlan = undefined;
          if (isSpeakable(text)) yield* emit(text);
          continue;
        }
        result = raced;
      } else {
        result = await pending;
      }
      pending = undefined;
      if (result.done === true) {
        exhausted = true;
        break;
      }
      buffer += result.value;
      const taken = takeSentences(buffer, maxChars);
      buffer = taken.rest;
      queue.push(...taken.sentences.filter(isSpeakable));
      while (queue.length > 0) {
        const text = queue.shift();
        if (text === undefined) break;
        const following = queue[0];
        yield* emit(text);
        if (following !== undefined) pendingPlan = compile(following);
      }
    }
  } finally {
    if (pending !== undefined) pending.catch(() => undefined);
    if (!exhausted) {
      const closing = iterator.return?.();
      if (options.signal?.aborted === true) closing?.catch(() => undefined);
      else await closing;
    }
  }
  const tail = buffer.trim();
  if (isSpeakable(tail)) {
    pendingPlan = undefined;
    yield* emit(tail);
  }
  const trailingFrames = index === 0 ? 0 : Math.round(request.postPause * sampleRate);
  if (trailingFrames > 0) {
    checkAbort(options.signal);
    yield {
      type: "audio",
      index: index - 1,
      block: { samples: new Float32Array(trailingFrames), start: frames, sampleRate },
      sequence,
    };
    sequence += 1;
    frames += trailingFrames;
  }
  yield { type: "end", sentences: index, frames, durationSeconds: frames / sampleRate };
}

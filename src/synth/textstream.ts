import type { Diagnostic } from "../errors.ts";
import { KongyoroidError, aborted, checkAbort } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { isNothingReadable } from "../text/frontend.ts";
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

function nextChunk<T>(pending: Promise<T>, waitMs: number | undefined, signal?: AbortSignal): Promise<T | undefined> {
  if (waitMs === undefined && signal === undefined) return pending;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<undefined>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(aborted("Streaming cancelled."));
      return;
    }
    if (waitMs !== undefined) timer = setTimeout(() => resolve(undefined), waitMs);
    if (signal !== undefined) {
      onAbort = (): void => reject(aborted("Streaming cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([pending, interrupt]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  });
}

function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
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
  let pendingPlan: Promise<SynthesisPlan | undefined> | undefined;
  let unreadable: KongyoroidError | undefined;
  const leadPause = (): number => {
    if (lastBoundary === undefined) return request.prePause;
    return Math.max(
      0,
      boundaryPauseSeconds(lastBoundary, timing, lastParagraphEnd) - utteranceFinalPauseSeconds(lastBoundary, timing),
    );
  };
  const compile = (text: string): Promise<SynthesisPlan | undefined> =>
    observed(
      compileRequest({ ...request, text, prePause: leadPause(), postPause: 0 }, sampleRate, options).then(
        (compiled) => compiled.plan,
        (error: unknown) => {
          if (!isNothingReadable(error)) throw error;
          unreadable = error;
          return undefined;
        },
      ),
    );
  const emit = async function* (text: string): AsyncGenerator<TextStreamEvent, void, void> {
    const plan = await (pendingPlan ?? compile(text));
    pendingPlan = undefined;
    if (plan === undefined) return;
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
  const read = (): Promise<IteratorResult<string, void>> => observed(iterator.next());
  let pending: Promise<IteratorResult<string, void>> | undefined;
  let exhausted = false;
  let lastInputAt = performance.now();
  try {
    while (!exhausted) {
      checkAbort(options.signal);
      pending ??= read();
      const waitMs =
        flushMs !== undefined && buffer.trim().length > 0
          ? Math.max(0, flushMs - (performance.now() - lastInputAt))
          : undefined;
      const result = await nextChunk(pending, waitMs, options.signal);
      if (result === undefined) {
        const text = buffer;
        buffer = "";
        pendingPlan = undefined;
        yield* emit(text);
        continue;
      }
      pending = undefined;
      if (result.done === true) {
        exhausted = true;
        break;
      }
      lastInputAt = performance.now();
      buffer += result.value;
      pending = read();
      const taken = takeSentences(buffer, maxChars);
      buffer = taken.rest;
      queue.push(...taken.sentences);
      while (queue.length > 0) {
        const text = queue.shift();
        if (text === undefined) break;
        const following = queue[0];
        yield* emit(text);
        if (following !== undefined) pendingPlan = compile(following);
      }
    }
  } finally {
    if (!exhausted) {
      const closing = iterator.return?.();
      if (options.signal?.aborted === true || pending !== undefined) closing?.catch(() => undefined);
      else await closing;
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    pendingPlan = undefined;
    yield* emit(tail);
  }
  if (index === 0 && unreadable !== undefined) throw unreadable;
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

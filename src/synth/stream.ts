import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { checkAbort } from "../errors.ts";
import { encodePcm16, wavHeader } from "../wav.ts";
import type { RenderStats } from "./renderer.ts";
import { PlanRenderer } from "./renderer.ts";
import type { SynthesisPlan } from "./plan.ts";

export interface StreamOptions {
  readonly blockFrames?: number;
  readonly signal?: AbortSignal;
  readonly yieldEvery?: number;
}

export interface PcmBlock {
  readonly samples: Float32Array;
  readonly start: number;
  readonly sampleRate: number;
}

export type AudioSink = (block: Float32Array) => void | Promise<void>;

export async function* renderPcmStream(
  plan: SynthesisPlan,
  options: StreamOptions = {},
): AsyncGenerator<PcmBlock, RenderStats, void> {
  const renderer = new PlanRenderer(plan);
  const blockFrames = Math.max(
    64,
    Math.min(1 << 20, Math.round(options.blockFrames ?? Math.max(1024, Math.round(plan.sampleRate / 20)))),
  );
  const yieldEvery = Math.max(1, options.yieldEvery ?? 4);
  let produced = 0;
  while (!renderer.finished) {
    checkAbort(options.signal);
    const start = renderer.position;
    const block = new Float32Array(Math.min(blockFrames, renderer.frames - start));
    renderer.fill(block);
    yield { samples: block, start, sampleRate: plan.sampleRate };
    produced += 1;
    if (produced % yieldEvery === 0) await yieldToEventLoop();
  }
  return renderer.stats();
}

export async function renderInto(
  plan: SynthesisPlan,
  sink: AudioSink,
  options: StreamOptions = {},
): Promise<RenderStats> {
  const iterator = renderPcmStream(plan, options);
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    await sink(next.value.samples);
    checkAbort(options.signal);
  }
}

export async function encodePlanAsync(
  plan: SynthesisPlan,
  options: StreamOptions = {},
): Promise<{ readonly audio: Uint8Array; readonly stats: RenderStats }> {
  const out = new Uint8Array(44 + plan.frames * 2);
  out.set(wavHeader(plan.frames, plan.sampleRate));
  let offset = 44;
  const stats = await renderInto(
    plan,
    (block) => {
      encodePcm16(block, out, offset);
      offset += block.length * 2;
    },
    options,
  );
  return { audio: out, stats };
}

export function encodePlanSync(
  plan: SynthesisPlan,
  options: StreamOptions = {},
): { readonly audio: Uint8Array; readonly stats: RenderStats } {
  const renderer = new PlanRenderer(plan);
  const out = new Uint8Array(44 + plan.frames * 2);
  out.set(wavHeader(plan.frames, plan.sampleRate));
  const step = Math.max(1024, Math.round(plan.sampleRate / 4));
  const buffer = new Float32Array(step);
  let offset = 44;
  while (!renderer.finished) {
    checkAbort(options.signal);
    const count = renderer.fill(buffer, 0, Math.min(step, renderer.frames - renderer.position));
    encodePcm16(buffer.subarray(0, count), out, offset);
    offset += count * 2;
  }
  return { audio: out, stats: renderer.stats() };
}

export function pcm16Bytes(block: Float32Array): Uint8Array {
  return encodePcm16(block);
}

export function streamingWavHeader(sampleRate: number, channels: number = 1): Uint8Array {
  const header = wavHeader(0, sampleRate, channels);
  const view = new DataView(header.buffer);
  view.setUint32(4, 0xffffffff, true);
  view.setUint32(40, 0xffffffff, true);
  return header;
}

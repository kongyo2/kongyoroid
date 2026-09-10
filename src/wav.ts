import { KongyoroidError, invalid } from "./errors.ts";
import type { AudioInfo } from "./types.ts";

const RIFF = 0x52494646;
const WAVE = 0x57415645;
const FMT = 0x666d7420;
const DATA = 0x64617461;
export const STREAMING_LENGTH: number = 0xffffffff;

export interface WavLayout extends AudioInfo {
  readonly dataOffset: number;
  readonly dataLength: number;
}

export function wavHeader(frames: number, sampleRate: number, channels: number = 1): Uint8Array {
  if (!Number.isSafeInteger(frames) || frames < 0 || frames * channels * 2 > 0xfffffff0) {
    invalid("$.frames", "Frame count is not representable in a WAV file.");
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > 384_000) {
    invalid("$.sampleRate", "Sample rate is not representable in a WAV file.");
  }
  const dataBytes = frames * channels * 2;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  view.setUint32(0, RIFF);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, WAVE);
  view.setUint32(12, FMT);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, DATA);
  view.setUint32(40, dataBytes, true);
  return header;
}

export function encodePcm16(pcm: Float32Array, target?: Uint8Array, offset: number = 0): Uint8Array {
  const bytes = target ?? new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < pcm.length; index++) {
    const value = pcm[index] ?? 0;
    if (!Number.isFinite(value)) invalid(`$.pcm[${index}]`, "PCM contains a non-finite sample.");
    const clipped = value < -1 ? -1 : value > 1 ? 1 : value;
    view.setInt16(offset + index * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  bytes.set(wavHeader(pcm.length, sampleRate));
  encodePcm16(pcm, bytes, 44);
  return bytes;
}

function malformed(reason: string): never {
  throw new KongyoroidError({
    code: "ENGINE_PROTOCOL",
    message: `Invalid or unsupported WAV data: ${reason}.`,
    retryable: false,
  });
}

export function inspectWav(bytes: Uint8Array): WavLayout {
  if (bytes.byteLength < 44) malformed("shorter than a RIFF header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== RIFF || view.getUint32(8) !== WAVE) malformed("missing RIFF/WAVE signature");
  const end = Math.min(view.getUint32(4, true) + 8, bytes.byteLength);
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let align = 0;
  let dataOffset = -1;
  let dataLength = -1;
  let position = 12;
  while (position + 8 <= end) {
    const tag = view.getUint32(position);
    const start = position + 8;
    const declared = view.getUint32(position + 4, true);
    const length = tag === DATA && declared === STREAMING_LENGTH ? end - start : declared;
    if (tag === FMT) {
      if (format !== 0 || length < 16 || start + 16 > end) malformed("bad fmt chunk");
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true);
      align = view.getUint16(start + 12, true);
      bits = view.getUint16(start + 14, true);
      if (format === 0xfffe && length >= 26) format = view.getUint16(start + 24, true);
    } else if (tag === DATA) {
      if (dataOffset >= 0) malformed("duplicate data chunk");
      if (start + length > end) malformed(`data chunk declares ${length} bytes past the end of the file`);
      dataOffset = start;
      dataLength = length;
    }
    position = start + length + (length % 2);
  }
  if (dataOffset < 0 || format === 0) malformed("missing fmt or data chunk");
  if (channels < 1 || channels > 2 || rate < 1000 || rate > 384_000) malformed("unsupported channel count or rate");
  if (!((format === 1 && bits === 16) || (format === 3 && bits === 32))) malformed("only PCM16 or float32 supported");
  if (align !== (channels * bits) / 8) malformed("inconsistent block alignment");
  const usable = dataLength - (dataLength % align);
  const frames = usable / align;
  return {
    sampleRate: rate,
    channels,
    frames,
    bitsPerSample: bits,
    format: format === 1 ? "pcm" : "float",
    durationSeconds: frames / rate,
    dataOffset,
    dataLength: usable,
  };
}

export function audioInfo(layout: WavLayout): AudioInfo {
  return {
    sampleRate: layout.sampleRate,
    channels: layout.channels,
    frames: layout.frames,
    bitsPerSample: layout.bitsPerSample,
    format: layout.format,
    durationSeconds: layout.durationSeconds,
  };
}

export function decodeWav(bytes: Uint8Array): { readonly info: AudioInfo; readonly samples: Float32Array } {
  const layout = inspectWav(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset + layout.dataOffset, layout.dataLength);
  const samples = new Float32Array(layout.frames);
  const channels = layout.channels;
  for (let frame = 0; frame < layout.frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const index = frame * channels + channel;
      sum += layout.format === "pcm" ? view.getInt16(index * 2, true) / 32768 : view.getFloat32(index * 4, true);
    }
    samples[frame] = sum / channels;
  }
  return { info: audioInfo(layout), samples };
}

export function silenceWav(seconds: number, sampleRate: number): Uint8Array {
  return encodeWav(new Float32Array(Math.round(seconds * sampleRate)), sampleRate);
}

export function concatWav(parts: readonly Uint8Array[], gapSeconds: number = 0): Uint8Array {
  if (parts.length === 0) invalid("$.parts", "Nothing to concatenate.");
  const layouts = parts.map((part) => inspectWav(part));
  const rate = layouts[0]?.sampleRate ?? 0;
  for (const layout of layouts) {
    if (layout.sampleRate !== rate) malformed("sample rates differ between parts");
  }
  const gapFrames = Math.round(gapSeconds * rate);
  let frames = 0;
  for (const layout of layouts) frames += layout.frames;
  frames += gapFrames * (parts.length - 1);
  const out = new Uint8Array(44 + frames * 2);
  out.set(wavHeader(frames, rate));
  let offset = 44;
  for (const [index, part] of parts.entries()) {
    const layout = layouts[index];
    if (layout === undefined) continue;
    if (layout.format === "pcm" && layout.channels === 1) {
      out.set(part.subarray(layout.dataOffset, layout.dataOffset + layout.dataLength), offset);
    } else {
      encodePcm16(decodeWav(part).samples, out, offset);
    }
    offset += layout.frames * 2;
    if (index < parts.length - 1) offset += gapFrames * 2;
  }
  return out;
}

export function pcm16Samples(bytes: Uint8Array): Int16Array {
  const layout = inspectWav(bytes);
  if (layout.format !== "pcm" || layout.channels !== 1) {
    const decoded = decodeWav(bytes).samples;
    const out = new Int16Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) {
      const value = Math.max(-1, Math.min(1, decoded[index] ?? 0));
      out[index] = Math.round(value * (value < 0 ? 32768 : 32767));
    }
    return out;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + layout.dataOffset, layout.dataLength);
  const out = new Int16Array(layout.frames);
  for (let index = 0; index < layout.frames; index++) out[index] = view.getInt16(index * 2, true);
  return out;
}

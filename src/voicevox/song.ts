import { engineScoreFrames, notesToEngineScore } from "../song/score.ts";
import type { OperationOptions, ResolvedSong, StyleSelection } from "../types.ts";
import { inspectWav } from "../wav.ts";
import type { FrameAudioQuery } from "./api.ts";
import { protocolError } from "./api.ts";
import type { VoicevoxClient } from "./client.ts";

export interface SongSynthesis {
  readonly audio: Uint8Array;
  readonly frames: number;
  readonly frameRate: number;
  readonly sampleRate: number;
}

export function applyVibrato(
  query: FrameAudioQuery,
  depthCents: number,
  rateHz: number,
  frameRate: number,
): FrameAudioQuery {
  if (depthCents <= 0 || rateHz <= 0) return query;
  let run = 0;
  const f0 = query.f0.map((hz) => {
    if (hz <= 0) {
      run = 0;
      return hz;
    }
    const seconds = run / frameRate;
    run += 1;
    const fade = Math.min(1, Math.max(0, (seconds - 0.12) / 0.18));
    const cents = depthCents * fade * Math.sin(2 * Math.PI * rateHz * seconds);
    return hz * 2 ** (cents / 1200);
  });
  return { ...query, f0 };
}

export async function synthesizeSong(
  client: VoicevoxClient,
  request: ResolvedSong,
  singer: StyleSelection,
  teacher: StyleSelection,
  options: OperationOptions = {},
): Promise<SongSynthesis> {
  const manifest = await client.manifest(options);
  const frameRate = manifest.frameRate;
  const sampleRate = request.sampleRate ?? manifest.defaultSamplingRate;
  const score = notesToEngineScore(request.notes, request.tempo, frameRate, request.leadIn, request.leadOut);
  const expectedFrames = engineScoreFrames(score);
  const predicted = await client.singFrameAudioQuery(score, teacher.id, options);
  if (predicted.f0.length !== expectedFrames) {
    throw protocolError(
      `sing_frame_audio_query returned ${predicted.f0.length} frames for a ${expectedFrames}-frame score`,
    );
  }
  const tuned = applyVibrato(predicted, request.vibratoDepth ?? 0, request.vibratoRate, frameRate);
  const query: FrameAudioQuery = {
    ...tuned,
    volumeScale: request.volume,
    outputSamplingRate: sampleRate,
    outputStereo: false,
  };
  const audio = await client.frameSynthesis(query, singer.id, options);
  const info = inspectWav(audio);
  if (info.channels !== 1 || info.sampleRate !== sampleRate) {
    throw protocolError(
      `frame_synthesis returned ${info.channels} channel(s) at ${info.sampleRate} Hz, expected mono ${sampleRate} Hz`,
    );
  }
  return { audio, frames: expectedFrames, frameRate, sampleRate };
}

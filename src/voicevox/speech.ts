import { mapConcurrent } from "../concurrency.ts";
import { invalid } from "../errors.ts";
import { LIMITS } from "../limits.ts";
import { splitText } from "../text.ts";
import type { OperationOptions, ResolvedSpeech, StyleSelection } from "../types.ts";
import { concatWav, inspectWav } from "../wav.ts";
import type { AudioQuery, EngineAccentPhrase } from "./api.ts";
import { protocolError } from "./api.ts";
import type { VoicevoxClient } from "./client.ts";

export interface SpeechSynthesis {
  readonly audio: Uint8Array;
  readonly kana: string;
  readonly chunks: number;
  readonly sampleRate: number;
}

export interface SpeechOptions extends OperationOptions {
  readonly concurrency?: number;
}

export function querySeconds(query: AudioQuery): number {
  let seconds = query.prePhonemeLength + query.postPhonemeLength;
  for (const phrase of query.accent_phrases) {
    const moras = phrase.pause_mora === null ? phrase.moras : [...phrase.moras, phrase.pause_mora];
    for (const mora of moras) {
      const pause = mora.vowel === "pau";
      const base = pause && query.pauseLength !== null ? query.pauseLength : mora.vowel_length;
      const vowel = pause ? base * query.pauseLengthScale : base;
      seconds += (vowel + (mora.consonant_length ?? 0)) / query.speedScale;
    }
  }
  return seconds;
}

export function applySpeechSettings(
  phrases: readonly EngineAccentPhrase[],
  request: ResolvedSpeech,
  sampleRate: number,
  kana: string,
): AudioQuery {
  return {
    accent_phrases: phrases,
    speedScale: request.speed,
    pitchScale: request.pitch,
    intonationScale: request.intonation,
    volumeScale: request.volume,
    prePhonemeLength: request.prePause,
    postPhonemeLength: request.postPause,
    pauseLength: request.pauseLength ?? null,
    pauseLengthScale: request.pauseScale,
    outputSamplingRate: sampleRate,
    outputStereo: false,
    kana,
  };
}

export async function synthesizeSpeech(
  client: VoicevoxClient,
  request: ResolvedSpeech,
  speaker: StyleSelection,
  options: SpeechOptions = {},
): Promise<SpeechSynthesis> {
  const manifest = await client.manifest(options);
  const sampleRate = request.sampleRate ?? manifest.defaultSamplingRate;
  const chunks = request.kana === undefined ? splitText(request.text, request.split) : [request.text];
  let budget = LIMITS.audioSeconds;
  const parts = await mapConcurrent(
    chunks,
    options.concurrency ?? 2,
    async (chunk) => {
      const query =
        request.kana === undefined
          ? applySpeechSettings(
              (await client.audioQuery(chunk, speaker.id, options)).accent_phrases,
              request,
              sampleRate,
              "",
            )
          : applySpeechSettings(
              await client.accentPhrases(request.kana, speaker.id, true, options),
              request,
              sampleRate,
              request.kana,
            );
      const kana = request.kana ?? chunkKana(query);
      const seconds = querySeconds(query);
      budget -= seconds;
      if (budget < 0) {
        invalid(
          "$.text",
          `The text would produce more than ${LIMITS.audioSeconds} s of audio.`,
          "Split the text into separate requests.",
        );
      }
      const audio = await client.synthesis(query, speaker.id, request.upspeak, options);
      const info = inspectWav(audio);
      if (info.channels !== 1 || info.sampleRate !== sampleRate) {
        throw protocolError(
          `synthesis returned ${info.channels} channel(s) at ${info.sampleRate} Hz, expected mono ${sampleRate} Hz`,
        );
      }
      return { audio, kana };
    },
    options.signal,
  );
  return {
    audio: parts.length === 1 ? (parts[0]?.audio ?? new Uint8Array(0)) : concatWav(parts.map((part) => part.audio)),
    kana: parts.map((part) => part.kana).join("/"),
    chunks: parts.length,
    sampleRate,
  };
}

function chunkKana(query: AudioQuery): string {
  if (query.kana.length > 0) return query.kana;
  let text = "";
  for (const [phraseIndex, phrase] of query.accent_phrases.entries()) {
    for (const [index, mora] of phrase.moras.entries()) {
      if (/^[AIUEO]$/u.test(mora.vowel)) text += "_";
      text += mora.text;
      if (index + 1 === phrase.accent) text += "'";
    }
    if (phrase.is_interrogative) text += "？";
    if (phraseIndex < query.accent_phrases.length - 1) text += phrase.pause_mora === null ? "/" : "、";
  }
  return text;
}

export function accentPhrasesToKana(phrases: readonly EngineAccentPhrase[]): string {
  return chunkKana({
    accent_phrases: phrases,
    speedScale: 1,
    pitchScale: 0,
    intonationScale: 1,
    volumeScale: 1,
    prePhonemeLength: 0,
    postPhonemeLength: 0,
    pauseLength: null,
    pauseLengthScale: 1,
    outputSamplingRate: 24000,
    outputStereo: false,
    kana: "",
  });
}

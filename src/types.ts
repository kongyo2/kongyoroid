import type { Diagnostic } from "./errors.ts";
import type { MmlScore, Note, NoteInput, ScoreText } from "./song/score.ts";
import type { DictionaryEntryInput } from "./text/dictionary.ts";

export type EngineId = "voicevox" | "formant";
export type EngineSelector = EngineId | "auto";
export type SplitMode = "sentence" | "paragraph" | "none";
export type StyleRef = number | string;
export type StyleType = "talk" | "singing_teacher" | "frame_decode" | "sing" | "streaming_talk";

export interface SpeechRequest {
  readonly kind: "speech";
  readonly engine?: EngineSelector;
  readonly voice?: string;
  readonly text: string;
  readonly kana?: string;
  readonly dictionary?: readonly DictionaryEntryInput[];
  readonly strictReading?: boolean;
  readonly speaker?: StyleRef;
  readonly speed?: number;
  readonly pitch?: number;
  readonly pitchSemitones?: number;
  readonly intonation?: number;
  readonly volume?: number;
  readonly gainDb?: number;
  readonly breathiness?: number;
  readonly prePause?: number;
  readonly postPause?: number;
  readonly pauseLength?: number;
  readonly pauseScale?: number;
  readonly upspeak?: boolean;
  readonly split?: SplitMode;
  readonly sampleRate?: number;
  readonly seed?: number;
}

export interface SongVibratoRequest {
  readonly depthCents?: number;
  readonly rateHz?: number;
  readonly delayMs?: number;
  readonly fadeMs?: number;
}

export interface SongRequest {
  readonly kind: "song";
  readonly engine?: EngineSelector;
  readonly voice?: string;
  readonly notes: readonly NoteInput[] | ScoreText | MmlScore;
  readonly tempo?: number;
  readonly singer?: StyleRef;
  readonly teacher?: StyleRef;
  readonly transpose?: number;
  readonly volume?: number;
  readonly gainDb?: number;
  readonly breathiness?: number;
  readonly vibratoDepth?: number;
  readonly vibratoRate?: number;
  readonly vibrato?: SongVibratoRequest;
  readonly portamentoMs?: number;
  readonly scoopCents?: number;
  readonly scoopMs?: number;
  readonly consonantCompression?: boolean;
  readonly leadIn?: number;
  readonly leadOut?: number;
  readonly sampleRate?: number;
  readonly seed?: number;
}

export type RenderRequest = SpeechRequest | SongRequest;

export interface ResolvedSpeech {
  readonly kind: "speech";
  readonly engine: EngineSelector;
  readonly voice: string;
  readonly text: string;
  readonly kana: string | undefined;
  readonly dictionary: readonly DictionaryEntryInput[];
  readonly strictReading: boolean;
  readonly speaker: StyleRef | undefined;
  readonly speed: number;
  readonly pitch: number | undefined;
  readonly pitchSemitones: number;
  readonly intonation: number;
  readonly volume: number;
  readonly breathiness: number;
  readonly prePause: number;
  readonly postPause: number;
  readonly pauseLength: number | undefined;
  readonly pauseScale: number;
  readonly upspeak: boolean;
  readonly split: SplitMode;
  readonly sampleRate: number | undefined;
  readonly seed: number;
}

export interface ResolvedSong {
  readonly kind: "song";
  readonly engine: EngineSelector;
  readonly voice: string;
  readonly notes: readonly Note[];
  readonly tempo: number;
  readonly singer: StyleRef | undefined;
  readonly teacher: StyleRef | undefined;
  readonly transpose: number;
  readonly volume: number;
  readonly breathiness: number;
  readonly vibratoDepth: number | undefined;
  readonly vibratoRate: number;
  readonly vibratoDelayMs: number;
  readonly vibratoFadeMs: number;
  readonly portamentoMs: number | undefined;
  readonly scoopCents: number;
  readonly scoopMs: number;
  readonly consonantCompression: boolean;
  readonly leadIn: number;
  readonly leadOut: number;
  readonly sampleRate: number | undefined;
  readonly seed: number;
  readonly form: "list" | "compact" | "mml";
}

export type ResolvedRequest = ResolvedSpeech | ResolvedSong;

export interface VoiceStyle {
  readonly id: number;
  readonly name: string;
  readonly character: string;
  readonly characterUuid: string;
  readonly type: StyleType;
  readonly version: string;
}

export interface StyleSelection {
  readonly id: number;
  readonly name: string;
  readonly character: string;
  readonly type: StyleType;
}

export interface AudioInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly bitsPerSample: number;
  readonly format: "pcm" | "float";
}

export interface RenderStyles {
  readonly speaker?: StyleSelection;
  readonly singer?: StyleSelection;
  readonly teacher?: StyleSelection;
}

export interface RenderTimings {
  readonly readMs: number;
  readonly planMs: number;
  readonly renderMs: number;
  readonly encodeMs: number;
  readonly totalMs: number;
}

export interface RenderResult {
  readonly audio: Uint8Array;
  readonly info: AudioInfo;
  readonly engine: EngineId;
  readonly kind: "speech" | "song";
  readonly voice: string | undefined;
  readonly styles: RenderStyles;
  readonly kana: string | undefined;
  readonly chunks: number;
  readonly cached: boolean;
  readonly sha256: string;
  readonly requestHash: string;
  readonly elapsedMs: number;
  readonly timings: RenderTimings;
  readonly warnings: readonly Diagnostic[];
  readonly adjustments: readonly { readonly code: string; readonly message: string }[];
  readonly peak: number | undefined;
  readonly rms: number | undefined;
  readonly limitedSamples: number | undefined;
  readonly engineVersion: string;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

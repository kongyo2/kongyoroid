import type { Note, NoteInput, ScoreText } from "./score.ts";

export type EngineId = "voicevox" | "formant";
export type EngineSelector = EngineId | "auto";
export type SplitMode = "sentence" | "paragraph" | "none";
export type StyleRef = number | string;
export type StyleType = "talk" | "singing_teacher" | "frame_decode" | "sing" | "streaming_talk";

export interface SpeechRequest {
  readonly kind: "speech";
  readonly engine?: EngineSelector;
  readonly text: string;
  readonly kana?: string;
  readonly speaker?: StyleRef;
  readonly speed?: number;
  readonly pitch?: number;
  readonly intonation?: number;
  readonly volume?: number;
  readonly prePause?: number;
  readonly postPause?: number;
  readonly pauseLength?: number;
  readonly pauseScale?: number;
  readonly upspeak?: boolean;
  readonly split?: SplitMode;
  readonly sampleRate?: number;
  readonly seed?: number;
}

export interface SongRequest {
  readonly kind: "song";
  readonly engine?: EngineSelector;
  readonly notes: readonly NoteInput[] | ScoreText;
  readonly tempo?: number;
  readonly singer?: StyleRef;
  readonly teacher?: StyleRef;
  readonly transpose?: number;
  readonly volume?: number;
  readonly vibratoDepth?: number;
  readonly vibratoRate?: number;
  readonly leadIn?: number;
  readonly leadOut?: number;
  readonly sampleRate?: number;
  readonly seed?: number;
}

export type RenderRequest = SpeechRequest | SongRequest;

export interface ResolvedSpeech {
  readonly kind: "speech";
  readonly engine: EngineSelector;
  readonly text: string;
  readonly kana: string | undefined;
  readonly speaker: StyleRef | undefined;
  readonly speed: number;
  readonly pitch: number;
  readonly intonation: number;
  readonly volume: number;
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
  readonly notes: readonly Note[];
  readonly tempo: number;
  readonly singer: StyleRef | undefined;
  readonly teacher: StyleRef | undefined;
  readonly transpose: number;
  readonly volume: number;
  readonly vibratoDepth: number | undefined;
  readonly vibratoRate: number;
  readonly leadIn: number;
  readonly leadOut: number;
  readonly sampleRate: number | undefined;
  readonly seed: number;
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

export interface RenderResult {
  readonly audio: Uint8Array;
  readonly info: AudioInfo;
  readonly engine: EngineId;
  readonly kind: "speech" | "song";
  readonly styles: RenderStyles;
  readonly kana: string | undefined;
  readonly chunks: number;
  readonly cached: boolean;
  readonly sha256: string;
  readonly elapsedMs: number;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

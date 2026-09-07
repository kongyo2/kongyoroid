export const LIMITS: {
  readonly textChars: number;
  readonly kanaChars: number;
  readonly notes: number;
  readonly audioSeconds: number;
  readonly formantSeconds: number;
  readonly inputBytes: number;
  readonly batchLines: number;
  readonly concurrency: number;
  readonly responseBytes: number;
  readonly chunkChars: number;
  readonly dictionaryEntries: number;
  readonly streamSentenceChars: number;
} = {
  textChars: 20_000,
  kanaChars: 20_000,
  notes: 4096,
  audioSeconds: 3600,
  formantSeconds: 1800,
  inputBytes: 8 * 1024 * 1024,
  batchLines: 10_000,
  concurrency: 16,
  responseBytes: 512 * 1024 * 1024,
  chunkChars: 400,
  dictionaryEntries: 20_000,
  streamSentenceChars: 2000,
};

export const SAMPLE_RATE_RANGE: { readonly min: number; readonly max: number } = { min: 8000, max: 48_000 };
export const DEFAULT_SAMPLE_RATE: number = 24_000;
export const RECOMMENDED_SAMPLE_RATE: number = 24_000;
export const MAX_F0_HZ: number = 2500;
export const MIN_F0_HZ: number = 30;

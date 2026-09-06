export const LIMITS: {
  readonly textChars: number;
  readonly kanaChars: number;
  readonly notes: number;
  readonly audioSeconds: number;
  readonly inputBytes: number;
  readonly batchLines: number;
  readonly concurrency: number;
  readonly responseBytes: number;
  readonly chunkChars: number;
} = {
  textChars: 20_000,
  kanaChars: 20_000,
  notes: 4096,
  audioSeconds: 3600,
  inputBytes: 8 * 1024 * 1024,
  batchLines: 10_000,
  concurrency: 16,
  responseBytes: 512 * 1024 * 1024,
  chunkChars: 400,
};

export const SAMPLE_RATE_RANGE: { readonly min: number; readonly max: number } = { min: 8000, max: 48_000 };
export const DEFAULT_SAMPLE_RATE: number = 24_000;

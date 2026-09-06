export type ErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_TEXT"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_HTTP"
  | "ENGINE_REJECTED"
  | "ENGINE_PROTOCOL"
  | "TIMEOUT"
  | "ABORTED"
  | "QUEUE_FULL"
  | "IO_ERROR"
  | "PLAYER_UNAVAILABLE"
  | "INTERNAL";

export interface ErrorData {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly path?: string;
  readonly status?: number;
  readonly hint?: string;
  readonly detail?: unknown;
}

export const EXIT_CODES: {
  readonly success: 0;
  readonly internal: 1;
  readonly input: 2;
  readonly engine: 3;
  readonly io: 4;
  readonly aborted: 130;
} = { success: 0, internal: 1, input: 2, engine: 3, io: 4, aborted: 130 };

export class KongyoroidError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly path: string | undefined;
  public readonly status: number | undefined;
  public readonly hint: string | undefined;
  public readonly detail: unknown;

  public constructor(data: ErrorData, cause?: unknown) {
    super(data.message, cause === undefined ? {} : { cause });
    this.name = "KongyoroidError";
    this.code = data.code;
    this.retryable = data.retryable;
    this.path = data.path;
    this.status = data.status;
    this.hint = data.hint;
    this.detail = data.detail;
  }

  public toJSON(): ErrorData {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

export function invalid(path: string, message: string, hint?: string): never {
  throw new KongyoroidError({
    code: "INVALID_INPUT",
    message,
    path,
    retryable: false,
    ...(hint === undefined ? {} : { hint }),
  });
}

export function unsupported(path: string, message: string, hint?: string): never {
  throw new KongyoroidError({
    code: "UNSUPPORTED_TEXT",
    message,
    path,
    retryable: false,
    ...(hint === undefined ? {} : { hint }),
  });
}

export function aborted(message: string = "Operation cancelled."): KongyoroidError {
  return new KongyoroidError({ code: "ABORTED", message, retryable: false });
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

export function asKongyoroidError(error: unknown): KongyoroidError {
  if (error instanceof KongyoroidError) return error;
  if (error instanceof Error && error.name === "AbortError") return aborted();
  const message = error instanceof Error ? error.message : String(error);
  return new KongyoroidError(
    { code: "INTERNAL", message: `Unexpected internal error: ${message}`, retryable: false },
    error,
  );
}

const EXIT_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  INVALID_INPUT: EXIT_CODES.input,
  UNSUPPORTED_TEXT: EXIT_CODES.input,
  ENGINE_UNAVAILABLE: EXIT_CODES.engine,
  ENGINE_HTTP: EXIT_CODES.engine,
  ENGINE_REJECTED: EXIT_CODES.engine,
  ENGINE_PROTOCOL: EXIT_CODES.engine,
  TIMEOUT: EXIT_CODES.engine,
  QUEUE_FULL: EXIT_CODES.engine,
  IO_ERROR: EXIT_CODES.io,
  PLAYER_UNAVAILABLE: EXIT_CODES.io,
  ABORTED: EXIT_CODES.aborted,
  INTERNAL: EXIT_CODES.internal,
};

export function exitCodeOf(error: KongyoroidError): number {
  return EXIT_BY_CODE[error.code];
}

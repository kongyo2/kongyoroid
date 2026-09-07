export type ErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_TEXT"
  | "UNREADABLE_TEXT"
  | "NOTE_TOO_SHORT"
  | "PITCH_OUT_OF_RANGE"
  | "FRONTEND_UNAVAILABLE"
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

export type RepairAction =
  | "provide-kana"
  | "add-dictionary-entry"
  | "remove-characters"
  | "increase-duration"
  | "allow-consonant-compression"
  | "use-vowel-continuation"
  | "lower-pitch"
  | "raise-sample-rate"
  | "clamp-pitch"
  | "shorten-input"
  | "split-input"
  | "use-force"
  | "start-engine"
  | "use-formant-engine"
  | "retry-later";

export interface RepairOption {
  readonly action: RepairAction;
  readonly description: string;
  readonly path?: string;
}

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  readonly unit: "unicode-code-point";
}

export interface ErrorData {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly path?: string;
  readonly status?: number;
  readonly hint?: string;
  readonly detail?: unknown;
  readonly repairOptions?: readonly RepairOption[];
  readonly retryAfterMs?: number;
  readonly sourceSpan?: SourceSpan;
  readonly surface?: string;
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
  public readonly repairOptions: readonly RepairOption[] | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly sourceSpan: SourceSpan | undefined;
  public readonly surface: string | undefined;

  public constructor(data: ErrorData, cause?: unknown) {
    super(data.message, cause === undefined ? {} : { cause });
    this.name = "KongyoroidError";
    this.code = data.code;
    this.retryable = data.retryable;
    this.path = data.path;
    this.status = data.status;
    this.hint = data.hint;
    this.detail = data.detail;
    this.repairOptions = data.repairOptions;
    this.retryAfterMs = data.retryAfterMs;
    this.sourceSpan = data.sourceSpan;
    this.surface = data.surface;
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
      ...(this.repairOptions === undefined ? {} : { repairOptions: this.repairOptions }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.sourceSpan === undefined ? {} : { sourceSpan: this.sourceSpan }),
      ...(this.surface === undefined ? {} : { surface: this.surface }),
    };
  }
}

export interface InvalidOptions {
  readonly hint?: string;
  readonly repairOptions?: readonly RepairOption[];
  readonly detail?: unknown;
  readonly sourceSpan?: SourceSpan;
  readonly surface?: string;
  readonly code?: Extract<ErrorCode, "INVALID_INPUT" | "NOTE_TOO_SHORT" | "PITCH_OUT_OF_RANGE" | "UNREADABLE_TEXT">;
}

export function invalid(path: string, message: string, hint?: string | InvalidOptions): never {
  const options: InvalidOptions = typeof hint === "string" ? { hint } : (hint ?? {});
  throw new KongyoroidError({
    code: options.code ?? "INVALID_INPUT",
    message,
    path,
    retryable: false,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.repairOptions === undefined ? {} : { repairOptions: options.repairOptions }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.sourceSpan === undefined ? {} : { sourceSpan: options.sourceSpan }),
    ...(options.surface === undefined ? {} : { surface: options.surface }),
  });
}

export function unsupported(path: string, message: string, hint?: string, options: InvalidOptions = {}): never {
  throw new KongyoroidError({
    code: "UNSUPPORTED_TEXT",
    message,
    path,
    retryable: false,
    ...(hint === undefined ? {} : { hint }),
    ...(options.repairOptions === undefined ? {} : { repairOptions: options.repairOptions }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.sourceSpan === undefined ? {} : { sourceSpan: options.sourceSpan }),
    ...(options.surface === undefined ? {} : { surface: options.surface }),
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
  UNREADABLE_TEXT: EXIT_CODES.input,
  NOTE_TOO_SHORT: EXIT_CODES.input,
  PITCH_OUT_OF_RANGE: EXIT_CODES.input,
  FRONTEND_UNAVAILABLE: EXIT_CODES.engine,
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

export const ERROR_CODES: readonly ErrorCode[] = [
  "INVALID_INPUT",
  "UNSUPPORTED_TEXT",
  "UNREADABLE_TEXT",
  "NOTE_TOO_SHORT",
  "PITCH_OUT_OF_RANGE",
  "FRONTEND_UNAVAILABLE",
  "ENGINE_UNAVAILABLE",
  "ENGINE_HTTP",
  "ENGINE_REJECTED",
  "ENGINE_PROTOCOL",
  "TIMEOUT",
  "QUEUE_FULL",
  "IO_ERROR",
  "PLAYER_UNAVAILABLE",
  "ABORTED",
  "INTERNAL",
];

export function exitCodeOf(error: KongyoroidError): number {
  return EXIT_BY_CODE[error.code];
}

export type DiagnosticSeverity = "error" | "warning" | "advice";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly help?: string;
  readonly sourceSpan?: SourceSpan;
  readonly surface?: string;
  readonly detail?: unknown;
}

export function formatDiagnostic(diagnostic: Diagnostic, location: string = "<request>"): string {
  const collapse = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();
  const where =
    diagnostic.sourceSpan === undefined
      ? diagnostic.path === undefined
        ? location
        : `${location}:${diagnostic.path}`
      : `${location}:${diagnostic.sourceSpan.start + 1}:1`;
  const help = diagnostic.help === undefined ? "" : ` help: ${collapse(diagnostic.help)}`;
  return `${where}: ${diagnostic.severity} kongyoroid(${diagnostic.code}): ${collapse(diagnostic.message)}${help}`;
}

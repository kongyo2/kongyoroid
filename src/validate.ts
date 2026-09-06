import { invalid } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown, path: string): JsonObject {
  if (!isObject(value)) invalid(path, "Expected a JSON object.");
  return value;
}

export function array(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, "Expected an array.");
  if (value.length < min || value.length > max) invalid(path, `Expected an array of ${min}–${max} items.`);
  return value;
}

export function keys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      invalid(`${path}.${key}`, "Unknown property.", `Allowed properties: ${allowed.join(", ")}.`);
    }
  }
}

export function has(value: JsonObject, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined;
}

export function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, `Expected a finite number in [${min}, ${max}].`);
  }
  return value;
}

export function integer(value: unknown, path: string, min: number, max: number): number {
  const numeric = number(value, path, min, max);
  if (!Number.isSafeInteger(numeric)) invalid(path, "Expected an integer.");
  return numeric;
}

export function string(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    invalid(path, `Expected a string of ${min}–${max} characters.`);
  }
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "Expected true or false.");
  return value;
}

export function literal<const T extends string>(value: unknown, path: string, options: readonly T[]): T {
  for (const option of options) if (value === option) return option;
  return invalid(path, `Expected one of: ${options.map((o) => JSON.stringify(o)).join(", ")}.`);
}

export function optional<T>(
  source: JsonObject,
  key: string,
  path: string,
  fallback: T,
  read: (value: unknown, path: string) => T,
): T {
  return has(source, key) ? read(source[key], `${path}.${key}`) : fallback;
}

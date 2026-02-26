// shared/parse.ts — Schema-validated JSON parsing (replaces unsafe `as` casts)

import * as v from "valibot";

/**
 * Parse a JSON string and validate it against a valibot schema.
 * Returns the validated value, or null if parsing/validation fails.
 */
export function parseJsonWith<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  text: string,
  schema: T,
): v.InferOutput<T> | null {
  try {
    return v.parse(schema, JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Escape hatch: parse JSON to `unknown` without schema validation.
 * Use for dynamic response formats where a fixed schema isn't practical
 * (e.g., Fly orgs with 5+ response shapes).
 */
export function parseJsonRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a JSON string and return it as a Record<string, unknown> or null.
 * Rejects non-object results (arrays, primitives).
 * Use for API responses that are always a JSON object.
 */
export function parseJsonObj(text: string): Record<string, unknown> | null {
  try {
    const val = JSON.parse(text);
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return val;
    }
    return null;
  } catch {
    return null;
  }
}

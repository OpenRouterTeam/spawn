export { getErrorMessage, hasStatus, isNumber, isString, toObjectArray, toRecord } from "@openrouter/spawn-shared";

/** Type guard: returns true for non-null, non-array objects (plain objects). */
export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

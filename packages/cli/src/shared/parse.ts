export { parseJsonObj, parseJsonWith } from "@openrouter/spawn-shared";

import { isPlainObject } from "./type-guards";

/**
 * Recursively deep-merge `source` into `target`, returning a new object.
 * Arrays and non-plain-objects are overwritten (not merged).
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...target,
  };
  for (const key of Object.keys(source)) {
    const tVal = target[key];
    const sVal = source[key];
    if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = deepMerge(tVal, sVal);
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

// CLI-specific schema — not in shared package
import * as v from "valibot";

/** Schema for responses containing a `version` field (npm registry, GitHub releases). */
export const PkgVersionSchema = v.object({
  version: v.string(),
});

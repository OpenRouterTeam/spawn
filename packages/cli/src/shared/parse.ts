export { parseJsonObj, parseJsonWith } from "@openrouter/spawn-shared";

// CLI-specific schema — not in shared package
import * as v from "valibot";

/** Schema for responses containing a `version` field (npm registry, GitHub releases). */
export const PkgVersionSchema = v.object({
  version: v.string(),
});

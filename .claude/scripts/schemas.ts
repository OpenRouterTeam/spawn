/**
 * Shared valibot schemas for Claude Code hook stdin payloads.
 *
 * PreToolUse hooks receive JSON on stdin with { tool_input: { ... } }.
 * Each schema validates the specific fields a hook needs.
 */

import * as v from "valibot";

/** PreToolUse payload for Write|Edit hooks — extracts file_path */
export const FilePathInput = v.object({
  tool_input: v.object({
    file_path: v.string(),
  }),
});

/** PreToolUse payload for Bash hooks — extracts command */
export const CommandInput = v.object({
  tool_input: v.object({
    command: v.string(),
  }),
});

/**
 * Parse stdin text against a valibot schema.
 * Returns the validated output or null if JSON parsing or validation fails.
 */
export function parseStdin<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  raw: string,
  schema: T,
): v.InferOutput<T> | null {
  try {
    const result = v.safeParse(schema, JSON.parse(raw));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

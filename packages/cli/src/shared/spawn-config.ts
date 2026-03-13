// shared/spawn-config.ts — Load and validate --config JSON files

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "valibot";
import { parseJsonWith } from "./parse.js";
import { logWarn } from "./ui.js";

const SpawnConfigSetupSchema = v.object({
  telegram_bot_token: v.optional(v.string()),
  github_token: v.optional(v.string()),
});

const SpawnConfigSchema = v.object({
  model: v.optional(v.string()),
  steps: v.optional(v.array(v.string())),
  name: v.optional(v.string()),
  setup: v.optional(SpawnConfigSetupSchema),
});

type SpawnConfig = v.InferOutput<typeof SpawnConfigSchema>;

/** Maximum config file size (1 MB) */
const MAX_CONFIG_SIZE = 1024 * 1024;

/**
 * Load and validate a spawn config file.
 * Returns null on parse failure (with warning to stderr).
 * Throws on missing file or security violations.
 */
export function loadSpawnConfig(filePath: string): SpawnConfig | null {
  // Security: reject null bytes before any filesystem operations
  if (filePath.includes("\0")) {
    throw new Error("Config file path contains null bytes");
  }

  const resolved = resolve(filePath);

  const stats = statSync(resolved);
  if (!stats.isFile()) {
    throw new Error(`Config path is not a file: ${resolved}`);
  }
  if (stats.size > MAX_CONFIG_SIZE) {
    throw new Error(`Config file too large (${stats.size} bytes, max ${MAX_CONFIG_SIZE})`);
  }

  const content = readFileSync(resolved, "utf-8");
  const parsed = parseJsonWith(content, SpawnConfigSchema);

  if (!parsed) {
    logWarn(`Invalid config file: ${resolved} — ignoring`);
    return null;
  }

  return parsed;
}

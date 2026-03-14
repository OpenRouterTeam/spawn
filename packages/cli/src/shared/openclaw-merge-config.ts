#!/usr/bin/env bun

/**
 * Deep-merge a spawn config patch into the existing openclaw.json.
 *
 * Runs on the remote VM via `bun run`. Reads _PATCH_B64 from the environment
 * (base64-encoded JSON), merges it recursively into ~/.openclaw/openclaw.json,
 * and writes the result atomically. Spawn-managed fields win; everything else
 * (meta, wizard, tools, skills, etc.) is preserved.
 *
 * Usage:  _PATCH_B64="<base64>" bun run openclaw-merge-config.ts
 *
 * NOTE: This file runs on remote VMs — it cannot import from @openrouter/spawn-shared.
 * Biome overrides in biome.json relax node: protocol and try/catch rules for this file.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;

const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...target,
  };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv satisfies Record<string, unknown>, sv satisfies Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

// Read existing config — fall back to empty object if missing or corrupt
let existing: Record<string, unknown> = {};
if (existsSync(configPath)) {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    existing = raw satisfies Record<string, unknown>;
  }
}

const patchB64 = process.env._PATCH_B64 ?? "";
const patch: unknown = JSON.parse(Buffer.from(patchB64, "base64").toString());
if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
  throw new Error("_PATCH_B64 must decode to a JSON object");
}

const merged = deepMerge(existing, patch satisfies Record<string, unknown>);
const tmpPath = join(dirname(configPath), `.openclaw.json.tmp.${process.pid}`);
writeFileSync(tmpPath, JSON.stringify(merged, null, 2), {
  mode: 0o600,
});
renameSync(tmpPath, configPath);

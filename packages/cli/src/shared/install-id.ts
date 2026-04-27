// shared/install-id.ts — Stable per-machine identifier for PostHog bucketing.
//
// Generated lazily on first call and persisted to $SPAWN_HOME/install-id.
// Used as the PostHog `distinct_id` for telemetry events and feature-flag
// evaluation, so the same machine reliably gets the same flag variant across
// runs (per-run session UUIDs would re-bucket every invocation).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getInstallIdPath } from "./paths.js";
import { tryCatch } from "./result.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let _cached: string | null = null;

/**
 * Return the persistent install ID, creating it on first call.
 * Falls back to an ephemeral UUID if the disk write fails (read-only home,
 * permission errors). Never throws.
 */
export function getInstallId(): string {
  if (_cached) {
    return _cached;
  }
  const path = getInstallIdPath();

  // Try to read existing
  const readResult = tryCatch(() => readFileSync(path, "utf8").trim());
  if (readResult.ok && UUID_RE.test(readResult.data)) {
    _cached = readResult.data;
    return _cached;
  }

  // Generate and persist
  const id = crypto.randomUUID();
  const writeResult = tryCatch(() => {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, {
        recursive: true,
      });
    }
    writeFileSync(path, id, {
      mode: 0o600,
    });
  });
  if (!writeResult.ok) {
    // Disk-write failure: still return a UUID so flag evaluation works for
    // this run. The user gets re-bucketed next time, but no breakage.
    _cached = id;
    return _cached;
  }
  _cached = id;
  return _cached;
}

/** Test-only: reset the in-memory cache so a fresh getInstallId() reads disk. */
export function _resetInstallIdCache(): void {
  _cached = null;
}

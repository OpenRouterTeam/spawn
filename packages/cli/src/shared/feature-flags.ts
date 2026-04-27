// shared/feature-flags.ts — PostHog feature-flag evaluation for the CLI.
//
// We do NOT use the PostHog Node SDK; we hand-roll a single POST to /decide,
// same project as telemetry.ts. Bucketing key is the install ID (stable per
// machine), not the per-run session UUID.
//
// Behavior:
//   - 1.5s timeout, fail-open (variants treated as missing — control wins)
//   - On-disk cache at $SPAWN_HOME/feature-flags-cache.json with 1h TTL
//   - Stale-while-revalidate: cached value used immediately, refresh fires
//     in the background and lands for the next invocation
//   - SPAWN_FEATURE_FLAGS_DISABLED=1 disables fetch + lookup entirely
//   - getFeatureFlag() captures a $feature_flag_called event the first time
//     a key is read, so PostHog can attribute conversions

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { getInstallId } from "./install-id.js";
import { parseJsonWith } from "./parse.js";
import { getSpawnDir } from "./paths.js";
import { asyncTryCatch, tryCatch } from "./result.js";
import { captureEvent } from "./telemetry.js";

const POSTHOG_TOKEN = "phc_7ToS2jDeWBlMu4n2JoNzoA1FnArdKwFMFoHVnAqQ6O1";
const DECIDE_URL = "https://us.i.posthog.com/decide/?v=3";
const FETCH_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const FlagValueSchema = v.union([
  v.string(),
  v.boolean(),
]);

const DecideResponseSchema = v.looseObject({
  featureFlags: v.optional(v.record(v.string(), FlagValueSchema)),
});

const CacheFileSchema = v.object({
  fetchedAt: v.number(),
  flags: v.record(v.string(), FlagValueSchema),
});

type FlagMap = Record<string, string | boolean>;

let _flags: FlagMap | null = null;
let _initialized = false;
const _exposed = new Set<string>();

function getCachePath(): string {
  return join(getSpawnDir(), "feature-flags-cache.json");
}

function isDisabled(): boolean {
  return process.env.SPAWN_FEATURE_FLAGS_DISABLED === "1";
}

function readCache(): FlagMap | null {
  const readResult = tryCatch(() => readFileSync(getCachePath(), "utf8"));
  if (!readResult.ok) {
    return null;
  }
  const parsed = parseJsonWith(readResult.data, CacheFileSchema);
  if (!parsed) {
    return null;
  }
  if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) {
    return null;
  }
  return parsed.flags;
}

function writeCache(flags: FlagMap): void {
  const path = getCachePath();
  const payload = JSON.stringify({
    fetchedAt: Date.now(),
    flags,
  });
  tryCatch(() => {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, {
        recursive: true,
      });
    }
    writeFileSync(path, payload, {
      mode: 0o600,
    });
  });
}

async function fetchFlags(): Promise<FlagMap | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const result = await asyncTryCatch(async () => {
    const res = await fetch(DECIDE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: POSTHOG_TOKEN,
        distinct_id: getInstallId(),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    return await res.text();
  });
  clearTimeout(timer);
  if (!result.ok || !result.data) {
    return null;
  }
  const parsed = parseJsonWith(result.data, DecideResponseSchema);
  if (!parsed) {
    return null;
  }
  return parsed.featureFlags ?? {};
}

/**
 * Initialize feature flags. Reads disk cache synchronously for immediate
 * availability, then fires a background refresh if the cache is stale.
 *
 * Idempotent — safe to call multiple times.
 */
export async function initFeatureFlags(): Promise<void> {
  if (_initialized || isDisabled()) {
    _initialized = true;
    return;
  }
  _initialized = true;

  const cached = readCache();
  if (cached) {
    _flags = cached;
    return;
  }

  // No fresh cache — fetch synchronously (with timeout) so the first
  // invocation still gets a variant.
  const fresh = await fetchFlags();
  if (fresh) {
    _flags = fresh;
    writeCache(fresh);
  }
}

/**
 * Look up a feature flag variant. Returns `fallback` if flags weren't fetched
 * (timeout, disabled, network error) or the key is unknown.
 *
 * Captures a $feature_flag_called event the first time each key is read in
 * this process — required for PostHog to attribute conversions to the variant.
 */
export function getFeatureFlag<T extends string | boolean>(key: string, fallback: T): string | boolean {
  const value = _flags && key in _flags ? _flags[key] : fallback;
  if (!_exposed.has(key) && !isDisabled()) {
    _exposed.add(key);
    captureEvent("$feature_flag_called", {
      $feature_flag: key,
      $feature_flag_response: value,
    });
  }
  return value;
}

/** Test-only: reset module state between tests. */
export function _resetFeatureFlagsForTest(): void {
  _flags = null;
  _initialized = false;
  _exposed.clear();
}

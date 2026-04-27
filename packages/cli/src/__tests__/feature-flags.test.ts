// Unit tests for shared/feature-flags.ts — fetch, cache, exposure events.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { _resetFeatureFlagsForTest, getFeatureFlag, initFeatureFlags } from "../shared/feature-flags.js";
import { _resetInstallIdCache } from "../shared/install-id.js";
import { getSpawnDir } from "../shared/paths.js";

const cachePath = (): string => join(getSpawnDir(), "feature-flags-cache.json");

function writeCache(flags: Record<string, string | boolean>, ageMs = 0): void {
  const path = cachePath();
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), {
      recursive: true,
    });
  }
  writeFileSync(
    path,
    JSON.stringify({
      fetchedAt: Date.now() - ageMs,
      flags,
    }),
  );
}

describe("feature flags", () => {
  const originalFetch = global.fetch;
  const originalSpawnHome = process.env.SPAWN_HOME;
  const originalDisabled = process.env.SPAWN_FEATURE_FLAGS_DISABLED;
  let testHome: string;

  beforeEach(() => {
    // Pin SPAWN_HOME to a fresh dir under the sandboxed HOME — other tests in
    // the suite mutate it and don't always restore. We need a known-empty dir
    // for the cache tests. SPAWN_HOME is required to live inside HOME so we
    // mkdtemp inside the preload-provided test HOME, not the system tmp.
    testHome = mkdtempSync(join(process.env.HOME ?? "", "spawn-ff-test-"));
    process.env.SPAWN_HOME = testHome;
    _resetFeatureFlagsForTest();
    _resetInstallIdCache();
    delete process.env.SPAWN_FEATURE_FLAGS_DISABLED;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSpawnHome === undefined) {
      delete process.env.SPAWN_HOME;
    } else {
      process.env.SPAWN_HOME = originalSpawnHome;
    }
    if (originalDisabled === undefined) {
      delete process.env.SPAWN_FEATURE_FLAGS_DISABLED;
    } else {
      process.env.SPAWN_FEATURE_FLAGS_DISABLED = originalDisabled;
    }
    rmSync(testHome, {
      recursive: true,
      force: true,
    });
  });

  describe("initFeatureFlags", () => {
    it("populates flags from a successful /decide response", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              featureFlags: {
                fast_provision: "test",
                other: true,
              },
            }),
          ),
        ),
      );
      await initFeatureFlags();
      expect(getFeatureFlag("fast_provision", "control")).toBe("test");
      expect(getFeatureFlag("other", false)).toBe(true);
    });

    it("falls open on a network error — getFeatureFlag returns the fallback", async () => {
      global.fetch = mock(() => Promise.reject(new Error("network down")));
      await initFeatureFlags();
      expect(getFeatureFlag("fast_provision", "control")).toBe("control");
    });

    it("falls open on HTTP 500", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response("oops", {
            status: 500,
          }),
        ),
      );
      await initFeatureFlags();
      expect(getFeatureFlag("fast_provision", "control")).toBe("control");
    });

    it("falls open on malformed JSON", async () => {
      global.fetch = mock(() => Promise.resolve(new Response("not json")));
      await initFeatureFlags();
      expect(getFeatureFlag("fast_provision", "control")).toBe("control");
    });

    it("ignores stale cache (>1h old) and re-fetches", async () => {
      writeCache(
        {
          fast_provision: "stale",
        },
        2 * 60 * 60 * 1000,
      );
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              featureFlags: {
                fast_provision: "fresh",
              },
            }),
          ),
        ),
      );
      await initFeatureFlags();
      expect(getFeatureFlag("fast_provision", "control")).toBe("fresh");
    });

    it("writes the response to the cache file", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              featureFlags: {
                fast_provision: "test",
              },
            }),
          ),
        ),
      );
      await initFeatureFlags();
      expect(existsSync(cachePath())).toBe(true);
    });

    it("short-circuits when SPAWN_FEATURE_FLAGS_DISABLED=1 is set", async () => {
      process.env.SPAWN_FEATURE_FLAGS_DISABLED = "1";
      let fetched = false;
      global.fetch = mock(() => {
        fetched = true;
        return Promise.resolve(new Response("{}"));
      });
      await initFeatureFlags();
      expect(fetched).toBe(false);
      expect(getFeatureFlag("fast_provision", "control")).toBe("control");
    });

    it("is idempotent — second call does not refetch", async () => {
      let count = 0;
      global.fetch = mock(() => {
        count++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              featureFlags: {
                fast_provision: "test",
              },
            }),
          ),
        );
      });
      await initFeatureFlags();
      await initFeatureFlags();
      expect(count).toBe(1);
    });
  });

  describe("getFeatureFlag", () => {
    it("returns fallback when flags were never initialized", () => {
      expect(getFeatureFlag("missing", "default")).toBe("default");
      expect(getFeatureFlag("missing-bool", false)).toBe(false);
    });

    it("returns fallback for unknown keys when flags are loaded", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              featureFlags: {
                known: "yes",
              },
            }),
          ),
        ),
      );
      await initFeatureFlags();
      expect(getFeatureFlag("known", "default")).toBe("yes");
      expect(getFeatureFlag("unknown", "default")).toBe("default");
    });
  });
});

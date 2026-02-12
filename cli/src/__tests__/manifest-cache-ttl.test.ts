import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  utimesSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Manifest } from "../manifest";
import { createMockManifest } from "./test-helpers";

/**
 * Tests for manifest.ts cache TTL (time-to-live) boundary behavior.
 *
 * The disk cache has a TTL of 3600 seconds (1 hour). The cacheAge function
 * checks the file's mtime to decide if it's fresh or stale. The
 * tryLoadFromDiskCache function gates on this TTL before reading the cache.
 *
 * Since cacheAge and tryLoadFromDiskCache are internal (not exported),
 * we test exact replicas here. This is the same pattern used by other
 * test files in this codebase (e.g., list-display.test.ts tests
 * formatTimestamp via replica).
 *
 * Tested behaviors:
 * - cacheAge: file mtime calculation, missing files, error handling
 * - TTL boundary: fresh (< 3600s) vs stale (>= 3600s) determination
 * - tryLoadFromDiskCache: TTL gating + JSON parsing + error recovery
 * - writeCache: directory creation, JSON formatting, round-trip integrity
 *
 * Agent: test-engineer
 */

const CACHE_TTL = 3600; // 1 hour, must match manifest.ts

const mockManifest = createMockManifest();

// ── Replica of cacheAge from manifest.ts (lines 52-59) ──────────────────────

function cacheAge(cacheFile: string): number {
  try {
    const st: ReturnType<typeof statSync> = statSync(cacheFile);
    return (Date.now() - st.mtimeMs) / 1000;
  } catch {
    return Infinity;
  }
}

// ── Replica of readCache from manifest.ts (lines 67-75) ─────────────────────

function readCache(cacheFile: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf-8")) as Manifest;
  } catch {
    return null;
  }
}

// ── Replica of writeCache from manifest.ts (lines 77-80) ────────────────────

function writeCache(cacheDir: string, cacheFile: string, data: Manifest): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
}

// ── Replica of tryLoadFromDiskCache from manifest.ts (lines 113-116) ────────

function tryLoadFromDiskCache(cacheFile: string): Manifest | null {
  if (cacheAge(cacheFile) >= CACHE_TTL) return null;
  return readCache(cacheFile);
}

// ── Replica of isValidManifest from manifest.ts (lines 84-86) ──────────────

function isValidManifest(data: any): data is Manifest {
  return data && data.agents && data.clouds && data.matrix;
}

describe("Manifest Cache TTL Behavior", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-cache-ttl-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── cacheAge ──────────────────────────────────────────────────────────

  describe("cacheAge", () => {
    it("should return Infinity when file does not exist", () => {
      expect(cacheAge(join(testDir, "nonexistent.json"))).toBe(Infinity);
    });

    it("should return near-zero age for freshly created file", () => {
      const file = join(testDir, "fresh.json");
      writeFileSync(file, "{}");
      expect(cacheAge(file)).toBeLessThan(5);
    });

    it("should return approximately 1800 seconds for a 30-minute-old file", () => {
      const file = join(testDir, "aged.json");
      writeFileSync(file, "{}");
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(file, thirtyMinAgo, thirtyMinAgo);

      const age = cacheAge(file);
      expect(age).toBeGreaterThan(1790);
      expect(age).toBeLessThan(1810);
    });

    it("should return approximately CACHE_TTL for a 1-hour-old file", () => {
      const file = join(testDir, "stale.json");
      writeFileSync(file, "{}");
      const oneHourAgo = new Date(Date.now() - CACHE_TTL * 1000);
      utimesSync(file, oneHourAgo, oneHourAgo);

      const age = cacheAge(file);
      expect(age).toBeGreaterThan(CACHE_TTL - 10);
      expect(age).toBeLessThan(CACHE_TTL + 10);
    });

    it("should return approximately 86400 for a 24-hour-old file", () => {
      const file = join(testDir, "old.json");
      writeFileSync(file, "{}");
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      utimesSync(file, dayAgo, dayAgo);

      const age = cacheAge(file);
      expect(age).toBeGreaterThan(86000);
      expect(age).toBeLessThan(86500);
    });

    it("should return Infinity for inaccessible path", () => {
      expect(cacheAge("/root/definitely/not/accessible/manifest.json")).toBe(Infinity);
    });

    it("should handle directory path (directories have mtimes too)", () => {
      expect(cacheAge(testDir)).toBeLessThan(60);
    });
  });

  // ── TTL boundary: fresh vs stale ──────────────────────────────────────

  describe("TTL boundary determination", () => {
    it("should be fresh when age is 0", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "{}");
      expect(cacheAge(file) < CACHE_TTL).toBe(true);
    });

    it("should be fresh when age is TTL - 1 second (3599s)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "{}");
      const almostStale = new Date(Date.now() - (CACHE_TTL - 1) * 1000);
      utimesSync(file, almostStale, almostStale);
      expect(cacheAge(file) < CACHE_TTL).toBe(true);
    });

    it("should be stale when age equals TTL exactly (3600s)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "{}");
      const exactTTL = new Date(Date.now() - CACHE_TTL * 1000);
      utimesSync(file, exactTTL, exactTTL);
      expect(cacheAge(file) >= CACHE_TTL).toBe(true);
    });

    it("should be stale when age is TTL + 1 second (3601s)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "{}");
      const justStale = new Date(Date.now() - (CACHE_TTL + 1) * 1000);
      utimesSync(file, justStale, justStale);
      expect(cacheAge(file) >= CACHE_TTL).toBe(true);
    });

    it("should be stale when age is 2x TTL (7200s)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "{}");
      const veryStale = new Date(Date.now() - CACHE_TTL * 2 * 1000);
      utimesSync(file, veryStale, veryStale);
      expect(cacheAge(file) >= CACHE_TTL).toBe(true);
    });

    it("should treat non-existent file as stale (Infinity >= TTL)", () => {
      expect(cacheAge(join(testDir, "nope.json")) >= CACHE_TTL).toBe(true);
    });
  });

  // ── tryLoadFromDiskCache ──────────────────────────────────────────────

  describe("tryLoadFromDiskCache TTL gating", () => {
    it("should return manifest when cache is fresh (10 seconds old)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest));
      const tenSecsAgo = new Date(Date.now() - 10 * 1000);
      utimesSync(file, tenSecsAgo, tenSecsAgo);

      const result = tryLoadFromDiskCache(file);
      expect(result).not.toBeNull();
      expect(result!.agents.claude.name).toBe("Claude Code");
    });

    it("should return null when cache is stale (TTL + 1 second)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest));
      const staleTime = new Date(Date.now() - (CACHE_TTL + 1) * 1000);
      utimesSync(file, staleTime, staleTime);

      expect(tryLoadFromDiskCache(file)).toBeNull();
    });

    it("should return null when file does not exist", () => {
      expect(tryLoadFromDiskCache(join(testDir, "nope.json"))).toBeNull();
    });

    it("should return null for invalid JSON in fresh cache", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "not json{{{");
      expect(tryLoadFromDiskCache(file)).toBeNull();
    });

    it("should return null for empty fresh cache file", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "");
      expect(tryLoadFromDiskCache(file)).toBeNull();
    });

    it("should return manifest at TTL - 1 second boundary", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest));
      const almostStale = new Date(Date.now() - (CACHE_TTL - 1) * 1000);
      utimesSync(file, almostStale, almostStale);

      expect(tryLoadFromDiskCache(file)).not.toBeNull();
    });

    it("should return null at exact TTL boundary", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest));
      const exactTTL = new Date(Date.now() - CACHE_TTL * 1000);
      utimesSync(file, exactTTL, exactTTL);

      expect(tryLoadFromDiskCache(file)).toBeNull();
    });

    it("should preserve all manifest fields through cache read", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest, null, 2));

      const result = tryLoadFromDiskCache(file);
      expect(result).not.toBeNull();
      expect(result!.agents.claude.name).toBe("Claude Code");
      expect(result!.agents.aider.name).toBe("Aider");
      expect(result!.clouds.sprite.name).toBe("Sprite");
      expect(result!.clouds.hetzner.name).toBe("Hetzner Cloud");
      expect(result!.matrix["sprite/claude"]).toBe("implemented");
      expect(result!.matrix["hetzner/aider"]).toBe("missing");
    });
  });

  // ── readCache ─────────────────────────────────────────────────────────

  describe("readCache", () => {
    it("should parse valid JSON cache file", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest));
      const result = readCache(file);
      expect(result).not.toBeNull();
      expect(result!.agents).toBeDefined();
    });

    it("should return null for missing file", () => {
      expect(readCache(join(testDir, "nope.json"))).toBeNull();
    });

    it("should return null for corrupted JSON", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "corrupted{{{");
      expect(readCache(file)).toBeNull();
    });

    it("should return null for empty file", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, "");
      expect(readCache(file)).toBeNull();
    });

    it("should parse JSON with whitespace/formatting", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify(mockManifest, null, 4));
      const result = readCache(file);
      expect(result).not.toBeNull();
      expect(result!.agents.claude.name).toBe("Claude Code");
    });

    it("should return the parsed object (not validate structure)", () => {
      const file = join(testDir, "cache.json");
      writeFileSync(file, JSON.stringify({ random: "data" }));
      const result = readCache(file);
      // readCache only parses JSON, doesn't validate
      expect(result).not.toBeNull();
      expect((result as any).random).toBe("data");
    });
  });

  // ── writeCache ────────────────────────────────────────────────────────

  describe("writeCache", () => {
    it("should create directory if it does not exist", () => {
      const cacheDir = join(testDir, "nested", "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      expect(existsSync(file)).toBe(true);
    });

    it("should write pretty-printed JSON", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const raw = readFileSync(file, "utf-8");
      // Pretty-printed JSON has indentation
      expect(raw).toContain("  ");
      expect(raw).toContain("\n");
    });

    it("should produce valid JSON that can be parsed back", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      expect(parsed.agents.claude.name).toBe("Claude Code");
      expect(parsed.clouds.sprite.name).toBe("Sprite");
      expect(parsed.matrix["sprite/claude"]).toBe("implemented");
    });

    it("should overwrite existing cache file", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const updatedManifest = createMockManifest();
      updatedManifest.agents.claude.description = "Updated";
      writeCache(cacheDir, file, updatedManifest);

      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      expect(parsed.agents.claude.description).toBe("Updated");
    });

    it("should produce file that passes isValidManifest", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      expect(isValidManifest(parsed)).toBeTruthy();
    });

    it("should write with UTF-8 encoding", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      // readFileSync with utf-8 should work
      const raw = readFileSync(file, "utf-8");
      expect(typeof raw).toBe("string");
      expect(raw.length).toBeGreaterThan(0);
    });
  });

  // ── Round-trip: writeCache -> tryLoadFromDiskCache ─────────────────────

  describe("writeCache -> tryLoadFromDiskCache round-trip", () => {
    it("should be readable immediately after writing (fresh cache)", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const result = tryLoadFromDiskCache(file);
      expect(result).not.toBeNull();
      expect(result!.agents.claude.name).toBe("Claude Code");
    });

    it("should preserve all fields through write -> read cycle", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const result = tryLoadFromDiskCache(file);
      expect(result).not.toBeNull();
      // Verify every key-value pair
      for (const [key, agent] of Object.entries(mockManifest.agents)) {
        expect(result!.agents[key].name).toBe(agent.name);
        expect(result!.agents[key].description).toBe(agent.description);
      }
      for (const [key, cloud] of Object.entries(mockManifest.clouds)) {
        expect(result!.clouds[key].name).toBe(cloud.name);
        expect(result!.clouds[key].type).toBe(cloud.type);
      }
      for (const [key, status] of Object.entries(mockManifest.matrix)) {
        expect(result!.matrix[key]).toBe(status);
      }
    });

    it("should not be readable after TTL expires", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      // Simulate cache aging past TTL
      const staleTime = new Date(Date.now() - (CACHE_TTL + 100) * 1000);
      utimesSync(file, staleTime, staleTime);

      expect(tryLoadFromDiskCache(file)).toBeNull();
    });

    it("should be readable at TTL - 1 second", () => {
      const cacheDir = join(testDir, "spawn");
      const file = join(cacheDir, "manifest.json");

      writeCache(cacheDir, file, mockManifest);

      const almostStale = new Date(Date.now() - (CACHE_TTL - 1) * 1000);
      utimesSync(file, almostStale, almostStale);

      expect(tryLoadFromDiskCache(file)).not.toBeNull();
    });
  });
});

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest } from "../manifest";

/**
 * Manifest integrity tests.
 *
 * Validates that manifest.json is internally consistent and that every
 * "implemented" matrix entry has a corresponding script file on disk.
 * Also validates structural constraints: required fields, naming conventions,
 * URL formats, and matrix key consistency.
 *
 * These tests catch configuration drift — when someone adds a script
 * without updating the manifest, or marks an entry "implemented" without
 * creating the script.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf-8");
const manifest: Manifest = JSON.parse(manifestRaw);

const agents = Object.keys(manifest.agents);
const clouds = Object.keys(manifest.clouds);
const matrixEntries = Object.entries(manifest.matrix);

describe("Manifest Integrity", () => {
  // ── Basic structure ─────────────────────────────────────────────────

  describe("structure", () => {
    it("should parse as valid JSON", () => {
      expect(() => JSON.parse(manifestRaw)).not.toThrow();
    });

    it("should have agents, clouds, and matrix top-level keys", () => {
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should have at least one agent", () => {
      expect(agents.length).toBeGreaterThan(0);
    });

    it("should have at least one cloud", () => {
      expect(clouds.length).toBeGreaterThan(0);
    });

    it("should have matrix entries", () => {
      expect(matrixEntries.length).toBeGreaterThan(0);
    });
  });

  // ── Agent definitions ───────────────────────────────────────────────

  describe("agent definitions", () => {
    it("should have required fields for every agent", () => {
      for (const [key, agent] of Object.entries(manifest.agents)) {
        expect(agent.name).toBeTruthy();
        expect(agent.description).toBeTruthy();
        expect(agent.url).toBeTruthy();
        expect(agent.install).toBeTruthy();
        expect(agent.launch).toBeTruthy();
        expect(agent.env).toBeTruthy();
      }
    });

    it("should use lowercase-hyphen-underscore keys for agents", () => {
      for (const key of agents) {
        expect(key).toMatch(/^[a-z0-9_-]+$/);
      }
    });

    it("should have valid URL format for agent urls", () => {
      for (const [key, agent] of Object.entries(manifest.agents)) {
        expect(agent.url).toMatch(/^https?:\/\//);
      }
    });

    it("should have env as an object for every agent", () => {
      for (const [key, agent] of Object.entries(manifest.agents)) {
        expect(typeof agent.env).toBe("object");
        expect(agent.env).not.toBeNull();
      }
    });

    it("should have unique agent display names", () => {
      const names = Object.values(manifest.agents).map((a) => a.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  // ── Cloud definitions ───────────────────────────────────────────────

  describe("cloud definitions", () => {
    it("should have required fields for every cloud", () => {
      for (const [key, cloud] of Object.entries(manifest.clouds)) {
        expect(cloud.name).toBeTruthy();
        expect(cloud.description).toBeTruthy();
        expect(cloud.url).toBeTruthy();
        expect(cloud.type).toBeTruthy();
        expect(cloud.auth).toBeTruthy();
        expect(cloud.provision_method).toBeTruthy();
        expect(cloud.exec_method).toBeTruthy();
        expect(cloud.interactive_method).toBeTruthy();
      }
    });

    it("should use lowercase-hyphen-underscore keys for clouds", () => {
      for (const key of clouds) {
        expect(key).toMatch(/^[a-z0-9_-]+$/);
      }
    });

    it("should have valid URL format for cloud urls", () => {
      for (const [key, cloud] of Object.entries(manifest.clouds)) {
        expect(cloud.url).toMatch(/^https?:\/\//);
      }
    });

    it("should have unique cloud display names", () => {
      const names = Object.values(manifest.clouds).map((c) => c.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  // ── Matrix consistency ──────────────────────────────────────────────

  describe("matrix consistency", () => {
    it("should only contain valid status values", () => {
      const validStatuses = [
        "implemented",
        "missing",
      ];
      for (const [key, status] of matrixEntries) {
        expect(validStatuses).toContain(status);
      }
    });

    it("should only reference existing clouds and agents in matrix keys", () => {
      for (const [key] of matrixEntries) {
        const slashIndex = key.indexOf("/");
        expect(slashIndex).toBeGreaterThan(0);

        const cloud = key.substring(0, slashIndex);
        const agent = key.substring(slashIndex + 1);

        expect(clouds).toContain(cloud);
        expect(agents).toContain(agent);
      }
    });

    it("should have a matrix entry for every cloud/agent combination", () => {
      const expectedCount = clouds.length * agents.length;
      expect(matrixEntries.length).toBe(expectedCount);
    });

    it("should have exactly one entry per cloud/agent pair (no duplicates)", () => {
      const keys = matrixEntries.map(([k]) => k);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("should use cloud/agent key format consistently", () => {
      for (const [key] of matrixEntries) {
        // Must be exactly "cloud/agent" with a single slash
        const parts = key.split("/");
        expect(parts.length).toBe(2);
        expect(parts[0].length).toBeGreaterThan(0);
        expect(parts[1].length).toBeGreaterThan(0);
      }
    });
  });

  // ── File existence ──────────────────────────────────────────────────

  describe("implemented entries have script files", () => {
    const implemented = matrixEntries.filter(([, status]) => status === "implemented");

    it("should have at least one implemented entry", () => {
      expect(implemented.length).toBeGreaterThan(0);
    });

    it("should have a .sh script file for every implemented entry", () => {
      const missing: string[] = [];

      for (const [key] of implemented) {
        const scriptPath = join(REPO_ROOT, "sh", key + ".sh");
        if (!existsSync(scriptPath)) {
          missing.push(key + ".sh");
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `${missing.length} implemented entries are missing script files:\n` +
            missing.map((f) => `  - ${f}`).join("\n"),
        );
      }
    });
  });

  // ── Script content validation ──────────────────────────────────────

  describe("script content basics", () => {
    const implemented = matrixEntries.filter(([, status]) => status === "implemented");
    // Sample a subset to keep tests fast
    const sample = implemented.slice(0, 20);

    it("should start with shebang in sampled scripts", () => {
      const badScripts: string[] = [];

      for (const [key] of sample) {
        const scriptPath = join(REPO_ROOT, "sh", key + ".sh");
        if (existsSync(scriptPath)) {
          const content = readFileSync(scriptPath, "utf-8");
          if (!content.trimStart().startsWith("#!")) {
            badScripts.push(key + ".sh");
          }
        }
      }

      if (badScripts.length > 0) {
        throw new Error("Scripts missing shebang:\n" + badScripts.map((f) => `  - ${f}`).join("\n"));
      }
    });

    it("should use set -eo pipefail in sampled scripts", () => {
      const badScripts: string[] = [];

      for (const [key] of sample) {
        const scriptPath = join(REPO_ROOT, "sh", key + ".sh");
        if (existsSync(scriptPath)) {
          const content = readFileSync(scriptPath, "utf-8");
          if (!content.includes("set -eo pipefail")) {
            badScripts.push(key + ".sh");
          }
        }
      }

      if (badScripts.length > 0) {
        throw new Error(`Scripts missing 'set -eo pipefail':\n` + badScripts.map((f) => `  - ${f}`).join("\n"));
      }
    });
  });

  // ── Cross-reference: orphaned scripts ──────────────────────────────

  describe("orphaned scripts", () => {
    it("should not have script files for missing matrix entries", () => {
      const missingEntries = matrixEntries.filter(([, status]) => status === "missing");
      const orphaned: string[] = [];

      for (const [key] of missingEntries) {
        const scriptPath = join(REPO_ROOT, "sh", key + ".sh");
        if (existsSync(scriptPath)) {
          orphaned.push(key + ".sh");
        }
      }

      if (orphaned.length > 0) {
        throw new Error(
          `${orphaned.length} scripts exist but are marked "missing" in manifest:\n` +
            orphaned.map((f) => `  - ${f}`).join("\n") +
            `\nUpdate manifest.json to mark these as "implemented".`,
        );
      }
    });
  });
});

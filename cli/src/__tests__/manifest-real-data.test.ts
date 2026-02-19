import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Tests that validate CLI helper functions against the REAL manifest.json.
 *
 * Unlike other test files that use small mock manifests (2 agents, 2 clouds),
 * these tests load the actual manifest.json and verify that every cloud and
 * agent entry works correctly with the CLI display and utility functions.
 *
 * This catches real-world issues that mock tests miss:
 * - The "local" cloud has auth: "none" (no env vars to parse)
 * - Some clouds have multi-var auth ("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")
 * - Cloud types vary (vm, cloud, container, sandbox, local)
 * - Some agents/clouds have optional "notes" fields
 * - Matrix keys must follow the "cloud/agent" format exactly
 *
 * Agent: test-engineer
 */

// Load the real manifest
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifest: Manifest = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "manifest.json"), "utf-8")
);

const allAgents = Object.keys(manifest.agents);
const allClouds = Object.keys(manifest.clouds);

// Mock @clack/prompts before importing commands
mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

const {
  getImplementedClouds,
  getImplementedAgents,
  getMissingClouds,
  getErrorMessage,
  calculateColumnWidth,
  getStatusDescription,
  parseAuthEnvVars,
  levenshtein,
  findClosestMatch,
  resolveAgentKey,
  resolveCloudKey,
} = await import("../commands.js");

const {
  agentKeys,
  cloudKeys,
  matrixStatus,
  countImplemented,
} = await import("../manifest.js");

// ── Manifest structure sanity checks ─────────────────────────────────────

describe("Real manifest data validation", () => {
  describe("manifest has expected scale", () => {
    it("should have at least 10 agents", () => {
      expect(allAgents.length).toBeGreaterThanOrEqual(10);
    });

    it("should have at least 8 clouds", () => {
      expect(allClouds.length).toBeGreaterThanOrEqual(8);
    });

    it("should have at least 80 matrix entries", () => {
      expect(Object.keys(manifest.matrix).length).toBeGreaterThanOrEqual(80);
    });

    it("should have more implemented than missing entries", () => {
      const impl = countImplemented(manifest);
      const total = Object.keys(manifest.matrix).length;
      expect(impl).toBeGreaterThan(total / 2);
    });
  });

  describe("every agent has required fields", () => {
    for (const key of allAgents) {
      it(`agent "${key}" has name, description, install, launch, env`, () => {
        const a = manifest.agents[key];
        expect(a.name).toBeTruthy();
        expect(a.description).toBeTruthy();
        expect(a.install).toBeTruthy();
        expect(a.launch).toBeTruthy();
        expect(a.env).toBeTruthy();
        expect(typeof a.env).toBe("object");
      });
    }
  });

  describe("every cloud has required fields", () => {
    for (const key of allClouds) {
      it(`cloud "${key}" has name, description, type, auth`, () => {
        const c = manifest.clouds[key];
        expect(c.name).toBeTruthy();
        expect(c.description).toBeTruthy();
        expect(c.type).toBeTruthy();
        expect(typeof c.auth).toBe("string");
      });
    }
  });

  describe("every matrix key follows cloud/agent format", () => {
    for (const key of Object.keys(manifest.matrix)) {
      it(`matrix key "${key}" has exactly one slash`, () => {
        const parts = key.split("/");
        expect(parts.length).toBe(2);
        expect(parts[0].length).toBeGreaterThan(0);
        expect(parts[1].length).toBeGreaterThan(0);
      });

      it(`matrix key "${key}" references valid cloud and agent`, () => {
        const [cloud, agent] = key.split("/");
        expect(allClouds).toContain(cloud);
        expect(allAgents).toContain(agent);
      });

      it(`matrix key "${key}" has valid status`, () => {
        const status = manifest.matrix[key];
        expect(["implemented", "missing"]).toContain(status);
      });
    }
  });
});

// ── CLI utility functions with real data ─────────────────────────────────

describe("CLI functions with real manifest", () => {
  describe("getImplementedClouds for every agent", () => {
    for (const agent of allAgents) {
      it(`should return valid cloud list for agent "${agent}"`, () => {
        const clouds = getImplementedClouds(manifest, agent);
        expect(Array.isArray(clouds)).toBe(true);
        // Every returned cloud should be a real cloud
        for (const c of clouds) {
          expect(allClouds).toContain(c);
        }
        // Every returned cloud should be implemented for this agent
        for (const c of clouds) {
          expect(matrixStatus(manifest, c, agent)).toBe("implemented");
        }
      });
    }
  });

  describe("getImplementedAgents for every cloud", () => {
    for (const cloud of allClouds) {
      it(`should return valid agent list for cloud "${cloud}"`, () => {
        const agents = getImplementedAgents(manifest, cloud);
        expect(Array.isArray(agents)).toBe(true);
        for (const a of agents) {
          expect(allAgents).toContain(a);
        }
        for (const a of agents) {
          expect(matrixStatus(manifest, cloud, a)).toBe("implemented");
        }
      });
    }
  });

  describe("getMissingClouds for every agent", () => {
    for (const agent of allAgents) {
      it(`should return complementary set for agent "${agent}"`, () => {
        const impl = getImplementedClouds(manifest, agent);
        const missing = getMissingClouds(manifest, agent, allClouds);
        // impl + missing should equal all clouds
        expect(impl.length + missing.length).toBe(allClouds.length);
        // No overlap
        for (const c of impl) {
          expect(missing).not.toContain(c);
        }
        for (const c of missing) {
          expect(impl).not.toContain(c);
        }
      });
    }
  });

  describe("parseAuthEnvVars for every cloud", () => {
    for (const cloud of allClouds) {
      it(`should parse auth string for cloud "${cloud}" without error`, () => {
        const auth = manifest.clouds[cloud].auth;
        const vars = parseAuthEnvVars(auth);
        expect(Array.isArray(vars)).toBe(true);
        // Every extracted var should match the env var pattern
        for (const v of vars) {
          expect(v).toMatch(/^[A-Z][A-Z0-9_]{3,}$/);
        }
      });
    }
  });

  describe("resolveAgentKey for every agent", () => {
    for (const agent of allAgents) {
      it(`should resolve exact key "${agent}"`, () => {
        expect(resolveAgentKey(manifest, agent)).toBe(agent);
      });

      it(`should resolve display name "${manifest.agents[agent].name}"`, () => {
        const name = manifest.agents[agent].name;
        const resolved = resolveAgentKey(manifest, name);
        // Display name should resolve back to the key
        // (unless the display name happens to be the same as a different key)
        if (resolved) {
          expect(manifest.agents[resolved].name.toLowerCase()).toBe(name.toLowerCase());
        }
      });
    }
  });

  describe("resolveCloudKey for every cloud", () => {
    for (const cloud of allClouds) {
      it(`should resolve exact key "${cloud}"`, () => {
        expect(resolveCloudKey(manifest, cloud)).toBe(cloud);
      });

      it(`should resolve display name "${manifest.clouds[cloud].name}"`, () => {
        const name = manifest.clouds[cloud].name;
        const resolved = resolveCloudKey(manifest, name);
        if (resolved) {
          expect(manifest.clouds[resolved].name.toLowerCase()).toBe(name.toLowerCase());
        }
      });
    }
  });

  describe("calculateColumnWidth with real names", () => {
    it("should calculate agent column width from real agent names", () => {
      const agentNames = allAgents.map(a => manifest.agents[a].name);
      const width = calculateColumnWidth(agentNames, 16);
      expect(width).toBeGreaterThanOrEqual(16);
      // Width should be at least as wide as the longest name + padding
      const maxNameLen = Math.max(...agentNames.map(n => n.length));
      expect(width).toBeGreaterThanOrEqual(maxNameLen + 2);
    });

    it("should calculate cloud column width from real cloud names", () => {
      const cloudNames = allClouds.map(c => manifest.clouds[c].name);
      const width = calculateColumnWidth(cloudNames, 10);
      expect(width).toBeGreaterThanOrEqual(10);
    });
  });
});

// ── Local cloud specific tests ───────────────────────────────────────────

describe("Local cloud provider integration", () => {
  it("should exist in the manifest", () => {
    expect(manifest.clouds["local"]).toBeDefined();
  });

  it('should have type "local"', () => {
    expect(manifest.clouds["local"].type).toBe("local");
  });

  it('should have auth "none"', () => {
    expect(manifest.clouds["local"].auth).toBe("none");
  });

  it("should parse auth as empty env var list", () => {
    const vars = parseAuthEnvVars(manifest.clouds["local"].auth);
    expect(vars).toEqual([]);
  });

  it("should have at least one implemented agent", () => {
    const agents = getImplementedAgents(manifest, "local");
    expect(agents.length).toBeGreaterThan(0);
  });

  it("should be returned by getImplementedClouds for its agents", () => {
    const agents = getImplementedAgents(manifest, "local");
    for (const agent of agents) {
      const clouds = getImplementedClouds(manifest, agent);
      expect(clouds).toContain("local");
    }
  });

  it("should have notes field", () => {
    expect(manifest.clouds["local"].notes).toBeTruthy();
  });

  it("should resolve exact key", () => {
    expect(resolveCloudKey(manifest, "local")).toBe("local");
  });

  it('should resolve display name "Local Machine"', () => {
    expect(resolveCloudKey(manifest, "Local Machine")).toBe("local");
  });

  it("should resolve case-insensitive display name", () => {
    expect(resolveCloudKey(manifest, "local machine")).toBe("local");
  });
});

// ── Cloud type grouping validation ───────────────────────────────────────

describe("Cloud type grouping with real data", () => {
  it("should have clouds of multiple types", () => {
    const types = new Set(allClouds.map(c => manifest.clouds[c].type));
    expect(types.size).toBeGreaterThanOrEqual(2);
  });

  it("every cloud type should be a non-empty string", () => {
    for (const cloud of allClouds) {
      const type = manifest.clouds[cloud].type;
      expect(typeof type).toBe("string");
      expect(type.length).toBeGreaterThan(0);
    }
  });

  it('should include "local" as a cloud type', () => {
    const types = new Set(allClouds.map(c => manifest.clouds[c].type));
    expect(types.has("local")).toBe(true);
  });

  it("every cloud type group should have at least one cloud", () => {
    const byType: Record<string, string[]> = {};
    for (const cloud of allClouds) {
      const type = manifest.clouds[cloud].type;
      if (!byType[type]) byType[type] = [];
      byType[type].push(cloud);
    }
    for (const [type, clouds] of Object.entries(byType)) {
      expect(clouds.length).toBeGreaterThan(0);
    }
  });
});

// ── Fuzzy matching with real data ────────────────────────────────────────

describe("Fuzzy matching with real agent and cloud names", () => {
  it("should find exact matches at distance 0", () => {
    for (const agent of allAgents.slice(0, 5)) {
      expect(levenshtein(agent, agent)).toBe(0);
    }
  });

  it("should find close agent matches for common typos", () => {
    // Test a few realistic typos
    if (allAgents.includes("claude")) {
      const match = findClosestMatch("claud", allAgents);
      expect(match).toBe("claude");
    }
    if (allAgents.includes("codex")) {
      const match = findClosestMatch("codx", allAgents);
      expect(match).toBe("codex");
    }
  });

  it("should find close cloud matches for common typos", () => {
    if (allClouds.includes("hetzner")) {
      const match = findClosestMatch("hetznr", allClouds);
      expect(match).toBe("hetzner");
    }
    if (allClouds.includes("sprite")) {
      const match = findClosestMatch("sprit", allClouds);
      expect(match).toBe("sprite");
    }
  });

  it("should not match completely unrelated strings", () => {
    const match = findClosestMatch("xyzzyplugh", allAgents);
    expect(match).toBeNull();
  });

  it("should not match very long random strings", () => {
    const match = findClosestMatch("a".repeat(50), allClouds);
    expect(match).toBeNull();
  });
});

// ── countImplemented consistency ─────────────────────────────────────────

describe("countImplemented consistency with real data", () => {
  it("should match manual count of implemented entries", () => {
    const manualCount = Object.values(manifest.matrix)
      .filter(s => s === "implemented").length;
    expect(countImplemented(manifest)).toBe(manualCount);
  });

  it("implemented + missing should equal total matrix entries", () => {
    const impl = Object.values(manifest.matrix).filter(s => s === "implemented").length;
    const missing = Object.values(manifest.matrix).filter(s => s === "missing").length;
    const total = Object.keys(manifest.matrix).length;
    expect(impl + missing).toBe(total);
  });

  it("total matrix entries should be <= agents * clouds", () => {
    const maxEntries = allAgents.length * allClouds.length;
    expect(Object.keys(manifest.matrix).length).toBeLessThanOrEqual(maxEntries);
  });
});

// ── Agent/Cloud key naming conventions ───────────────────────────────────

describe("Key naming conventions", () => {
  for (const agent of allAgents) {
    it(`agent key "${agent}" should be lowercase alphanumeric with hyphens`, () => {
      expect(agent).toMatch(/^[a-z0-9-]+$/);
    });
  }

  for (const cloud of allClouds) {
    it(`cloud key "${cloud}" should be lowercase alphanumeric with hyphens`, () => {
      expect(cloud).toMatch(/^[a-z0-9-]+$/);
    });
  }

  it("no agent key should match a cloud key", () => {
    for (const agent of allAgents) {
      expect(allClouds).not.toContain(agent);
    }
  });
});

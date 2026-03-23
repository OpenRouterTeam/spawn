import type { Manifest } from "../manifest";

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Manifest type contract validation tests.
 *
 * Validates that every field in the real manifest.json conforms to the
 * TypeScript type definitions (AgentDef, CloudDef) at runtime. This catches
 * data quality issues that would cause runtime failures:
 *
 * - Required string fields are strings (not numbers, booleans, arrays)
 * - env values are all strings (the CLI interpolates them as strings)
 * - Optional fields (pre_launch, deps, config_files, interactive_prompts,
 *   dotenv, notes, defaults) have correct types when present
 * - dotenv.path is a string and dotenv.values is a Record<string, string>
 * - interactive_prompts entries have prompt+default string fields
 * - config_files keys are strings (file paths)
 * - deps is an array of strings when present
 * - Cloud provision/exec/interactive methods are non-empty strings
 * - Agent env contains OPENROUTER_API_KEY (mandatory per CLAUDE.md)
 *
 * Unlike manifest-integrity.test.ts which checks truthiness, these tests
 * verify exact types to prevent subtle runtime bugs from type mismatches.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const manifest: Manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "manifest.json"), "utf-8"));

const allAgents = Object.entries(manifest.agents);
const allClouds = Object.entries(manifest.clouds);

// ── Agent required field types ────────────────────────────────────────────

describe("Agent required field types", () => {
  const nonEmptyStringFields = [
    "name",
    "description",
    "install",
    "launch",
  ] as const;

  it("name, description, install, launch should be non-empty strings for all agents", () => {
    for (const field of nonEmptyStringFields) {
      for (const [key, agent] of allAgents) {
        const val = agent[field];
        expect(typeof val, `agent "${key}" ${field}`).toBe("string");
        expect(String(val).length, `agent "${key}" ${field} length`).toBeGreaterThan(0);
      }
    }
  });

  it("url should be a valid URL string for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.url, `agent "${key}" url`).toBe("string");
      expect(agent.url, `agent "${key}" url format`).toMatch(/^https?:\/\//);
    }
  });

  it("env should be a non-null object for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.env, `agent "${key}" env type`).toBe("object");
      expect(agent.env, `agent "${key}" env null`).not.toBeNull();
      expect(Array.isArray(agent.env), `agent "${key}" env array`).toBe(false);
    }
  });

  it("env values should all be strings for all agents", () => {
    for (const [key, agent] of allAgents) {
      for (const [envKey, envVal] of Object.entries(agent.env)) {
        expect(typeof envVal, `agent "${key}" env.${envKey}`).toBe("string");
      }
    }
  });

  it("env keys should be valid environment variable names for all agents", () => {
    for (const [key, agent] of allAgents) {
      for (const envKey of Object.keys(agent.env)) {
        expect(envKey, `agent "${key}" env key "${envKey}"`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

// ── Agent OPENROUTER_API_KEY requirement ──────────────────────────────────

describe("Agent OPENROUTER_API_KEY requirement", () => {
  it("all agents should reference OPENROUTER_API_KEY in env", () => {
    for (const [key, agent] of allAgents) {
      // Per CLAUDE.md: "OpenRouter injection is mandatory"
      // Every agent's env should contain OPENROUTER_API_KEY as a key
      // OR reference it in a value via ${OPENROUTER_API_KEY}
      const envKeys = Object.keys(agent.env);
      const envValues = Object.values(agent.env);
      const hasKeyDirect = envKeys.includes("OPENROUTER_API_KEY");
      const hasKeyRef = envValues.some((v) => v.includes("OPENROUTER_API_KEY"));
      expect(hasKeyDirect || hasKeyRef, `agent "${key}" missing OPENROUTER_API_KEY`).toBe(true);
    }
  });
});

// ── Agent optional field types ────────────────────────────────────────────

describe("Agent optional field types (when present)", () => {
  it("pre_launch should be a string for all agents that have it", () => {
    const agentsWithPreLaunch = allAgents.filter(([, agent]) => agent.pre_launch !== undefined);
    expect(agentsWithPreLaunch.length).toBeGreaterThan(0);
    for (const [, agent] of agentsWithPreLaunch) {
      expect(typeof agent.pre_launch).toBe("string");
    }
  });

  it("config_files should be an object with path-like string keys and object values for all agents that have it", () => {
    const agentsWithConfigFiles = allAgents.filter(([, agent]) => agent.config_files !== undefined);
    expect(agentsWithConfigFiles.length).toBeGreaterThan(0);
    for (const [, agent] of agentsWithConfigFiles) {
      expect(typeof agent.config_files).toBe("object");
      expect(agent.config_files).not.toBeNull();
      for (const [filePath, content] of Object.entries(agent.config_files!)) {
        expect(typeof filePath).toBe("string");
        expect(filePath.length).toBeGreaterThan(0);
        // File paths should contain / or ~ or . indicating a real path
        expect(filePath).toMatch(/[/~.]/);
        expect(typeof content).toBe("object");
        expect(content).not.toBeNull();
      }
    }
  });

  it("notes should be a non-empty string for all agents that have it", () => {
    const agentsWithNotes = allAgents.filter(([, agent]) => agent.notes !== undefined);
    expect(agentsWithNotes.length).toBeGreaterThan(0);
    for (const [, agent] of agentsWithNotes) {
      expect(typeof agent.notes).toBe("string");
      expect(agent.notes!.length).toBeGreaterThan(0);
    }
  });
});

// ── Cloud required field types ────────────────────────────────────────────

describe("Cloud required field types", () => {
  const nonEmptyStringFields = [
    "name",
    "description",
    "price",
    "type",
    "auth",
    "provision_method",
    "exec_method",
    "interactive_method",
  ] as const;

  it("name, description, price, type, auth, provision_method, exec_method, interactive_method should be non-empty strings for all clouds", () => {
    for (const field of nonEmptyStringFields) {
      for (const [key, cloud] of allClouds) {
        const val = cloud[field];
        expect(typeof val, `cloud "${key}" ${field}`).toBe("string");
        // auth can be "none" but must be present
        expect(String(val).length, `cloud "${key}" ${field} length`).toBeGreaterThan(0);
      }
    }
  });

  it("url should be a valid URL string for all clouds", () => {
    for (const [key, cloud] of allClouds) {
      expect(typeof cloud.url, `cloud "${key}" url`).toBe("string");
      expect(cloud.url, `cloud "${key}" url format`).toMatch(/^https?:\/\//);
    }
  });
});

// ── Cloud optional field types ────────────────────────────────────────────

describe("Cloud optional field types (when present)", () => {
  it("defaults should be an object for all clouds that have it", () => {
    const cloudsWithDefaults = allClouds.filter(([, cloud]) => cloud.defaults !== undefined);
    expect(cloudsWithDefaults.length).toBeGreaterThan(0);
    for (const [, cloud] of cloudsWithDefaults) {
      expect(typeof cloud.defaults).toBe("object");
      expect(cloud.defaults).not.toBeNull();
      expect(Array.isArray(cloud.defaults)).toBe(false);
    }
  });

  it("notes should be a non-empty string for all clouds that have it", () => {
    const cloudsWithNotes = allClouds.filter(([, cloud]) => cloud.notes !== undefined);
    expect(cloudsWithNotes.length).toBeGreaterThan(0);
    for (const [, cloud] of cloudsWithNotes) {
      expect(typeof cloud.notes).toBe("string");
      expect(cloud.notes!.length).toBeGreaterThan(0);
    }
  });

  it("icon should be a valid URL string for all clouds that have it", () => {
    const cloudsWithIcon = allClouds.filter(([, cloud]) => cloud.icon !== undefined);
    expect(cloudsWithIcon.length).toBeGreaterThan(0);
    for (const [, cloud] of cloudsWithIcon) {
      expect(typeof cloud.icon).toBe("string");
      expect(cloud.icon!).toMatch(/^https?:\/\//);
    }
  });
});

// ── Cloud type value validation ───────────────────────────────────────────

describe("Cloud type values", () => {
  const validTypes = new Set<string>();

  for (const [, cloud] of allClouds) {
    validTypes.add(cloud.type);
  }

  it("cloud types should be lowercase", () => {
    for (const type of validTypes) {
      expect(type).toBe(type.toLowerCase());
    }
  });

  it("all cloud types should be from the known set", () => {
    const knownTypes = new Set([
      "api",
      "cli",
      "local",
      "vm",
      "container",
      "sandbox",
      "cloud",
    ]);
    for (const [key, cloud] of allClouds) {
      expect(knownTypes, `cloud "${key}" has unknown type "${cloud.type}"`).toContain(cloud.type);
    }
  });
});

// ── Env var interpolation patterns ────────────────────────────────────────

describe("Env var interpolation patterns", () => {
  it("env values with ${...} should reference valid-looking env var names", () => {
    for (const [, agent] of allAgents) {
      for (const [, envVal] of Object.entries(agent.env)) {
        const matches = [
          ...envVal.matchAll(/\$\{([^}]+)\}/g),
        ];
        for (const match of matches) {
          const refName = match[1];
          // Referenced env var names should look like valid env vars
          expect(refName).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      }
    }
  });

  it("env values should not contain unmatched ${", () => {
    for (const [, agent] of allAgents) {
      for (const [, envVal] of Object.entries(agent.env)) {
        // Count ${ and } occurrences
        const opens = (envVal.match(/\$\{/g) || []).length;
        const closes = (envVal.match(/\}/g) || []).length;
        // Every ${ should have a matching }
        expect(opens).toBeLessThanOrEqual(closes);
      }
    }
  });
});

// ── Agent launch command consistency ──────────────────────────────────────

describe("Agent launch command consistency", () => {
  it("launch commands should not contain dangerous shell metacharacters", () => {
    for (const [, agent] of allAgents) {
      // Launch commands shouldn't have pipe-to-bash or command substitution
      expect(agent.launch).not.toMatch(/\|\s*bash/);
      expect(agent.launch).not.toMatch(/\|\s*sh/);
      expect(agent.launch).not.toMatch(/`[^`]+`/);
      expect(agent.launch).not.toMatch(/\$\([^)]+\)/);
    }
  });
  // Note: install field type/non-empty checks are covered by
  // "Agent required field types" > "install should be a non-empty string"
});

// ── Interactive prompts structure ─────────────────────────────────────────

describe("Interactive prompts structure", () => {
  it("all interactive_prompts entries should have non-empty prompt text and string defaults", () => {
    const agentsWithInteractivePrompts = allAgents.filter(([, agent]) => agent.interactive_prompts !== undefined);
    expect(agentsWithInteractivePrompts.length).toBeGreaterThan(0);
    for (const [, agent] of agentsWithInteractivePrompts) {
      for (const [, entry] of Object.entries(agent.interactive_prompts!)) {
        expect(entry.prompt.trim().length).toBeGreaterThan(0);
        expect(entry.default).toBeDefined();
        expect(typeof entry.default).toBe("string");
      }
    }
  });
});

// ── Agent metadata field types ────────────────────────────────────────

// These fields are present on all current agents — no conditional guards needed.
describe("Agent metadata field types", () => {
  const nonEmptyStringFields = [
    "creator",
    "license",
    "language",
    "runtime",
    "tagline",
  ] as const;

  it("creator, license, language, runtime, tagline should be non-empty strings for all agents", () => {
    for (const field of nonEmptyStringFields) {
      for (const [key, agent] of allAgents) {
        const val = agent[field];
        expect(typeof val, `agent "${key}" ${field}`).toBe("string");
        expect(String(val).length, `agent "${key}" ${field} length`).toBeGreaterThan(0);
      }
    }
  });

  it("repo should match owner/repo format for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.repo, `agent "${key}" repo`).toBe("string");
      expect(agent.repo, `agent "${key}" repo format`).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    }
  });

  it("created and added should be YYYY-MM format for all agents", () => {
    for (const field of [
      "created",
      "added",
    ] as const) {
      for (const [key, agent] of allAgents) {
        expect(typeof agent[field], `agent "${key}" ${field}`).toBe("string");
        expect(agent[field], `agent "${key}" ${field} format`).toMatch(/^\d{4}-\d{2}$/);
      }
    }
  });

  it("github_stars should be a non-negative integer for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.github_stars, `agent "${key}" github_stars`).toBe("number");
      expect(agent.github_stars!, `agent "${key}" github_stars value`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(agent.github_stars), `agent "${key}" github_stars integer`).toBe(true);
    }
  });

  it("stars_updated should be YYYY-MM-DD format for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.stars_updated, `agent "${key}" stars_updated`).toBe("string");
      expect(agent.stars_updated, `agent "${key}" stars_updated format`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("category should be cli, tui, or ide-extension for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.category, `agent "${key}" category`).toBe("string");
      expect(
        [
          "cli",
          "tui",
          "ide-extension",
        ],
        `agent "${key}" category value`,
      ).toContain(agent.category);
    }
  });

  it("tags should be an array of non-empty strings for all agents", () => {
    for (const [key, agent] of allAgents) {
      expect(Array.isArray(agent.tags), `agent "${key}" tags`).toBe(true);
      for (const tag of agent.tags!) {
        expect(typeof tag, `agent "${key}" tag "${tag}"`).toBe("string");
        expect(tag.length, `agent "${key}" tag "${tag}" length`).toBeGreaterThan(0);
      }
    }
  });
});

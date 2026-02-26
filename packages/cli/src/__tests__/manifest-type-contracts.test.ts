import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Manifest } from "../manifest";

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
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const manifest: Manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "manifest.json"), "utf-8"));

const allAgents = Object.entries(manifest.agents);
const allClouds = Object.entries(manifest.clouds);

// ── Agent required field types ────────────────────────────────────────────

describe("Agent required field types", () => {
  for (const [key, agent] of allAgents) {
    describe(`agent "${key}"`, () => {
      it("name should be a non-empty string", () => {
        expect(typeof agent.name).toBe("string");
        expect(agent.name.length).toBeGreaterThan(0);
      });

      it("description should be a non-empty string", () => {
        expect(typeof agent.description).toBe("string");
        expect(agent.description.length).toBeGreaterThan(0);
      });

      it("url should be a valid URL string", () => {
        expect(typeof agent.url).toBe("string");
        expect(agent.url).toMatch(/^https?:\/\//);
      });

      it("install should be a non-empty string", () => {
        expect(typeof agent.install).toBe("string");
        expect(agent.install.length).toBeGreaterThan(0);
      });

      it("launch should be a non-empty string", () => {
        expect(typeof agent.launch).toBe("string");
        expect(agent.launch.length).toBeGreaterThan(0);
      });

      it("env should be a non-null object", () => {
        expect(typeof agent.env).toBe("object");
        expect(agent.env).not.toBeNull();
        expect(Array.isArray(agent.env)).toBe(false);
      });

      it("env values should all be strings", () => {
        for (const [envKey, envVal] of Object.entries(agent.env)) {
          expect(typeof envVal).toBe("string");
        }
      });

      it("env keys should be valid environment variable names", () => {
        for (const envKey of Object.keys(agent.env)) {
          expect(envKey).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      });
    });
  }
});

// ── Agent OPENROUTER_API_KEY requirement ──────────────────────────────────

describe("Agent OPENROUTER_API_KEY requirement", () => {
  for (const [key, agent] of allAgents) {
    it(`agent "${key}" should reference OPENROUTER_API_KEY in env`, () => {
      // Per CLAUDE.md: "OpenRouter injection is mandatory"
      // Every agent's env should contain OPENROUTER_API_KEY as a key
      // OR reference it in a value via ${OPENROUTER_API_KEY}
      const envKeys = Object.keys(agent.env);
      const envValues = Object.values(agent.env);
      const hasKeyDirect = envKeys.includes("OPENROUTER_API_KEY");
      const hasKeyRef = envValues.some((v) => v.includes("OPENROUTER_API_KEY"));
      expect(hasKeyDirect || hasKeyRef).toBe(true);
    });
  }
});

// ── Agent optional field types ────────────────────────────────────────────

describe("Agent optional field types (when present)", () => {
  for (const [key, agent] of allAgents) {
    if (agent.pre_launch !== undefined) {
      it(`agent "${key}" pre_launch should be a string`, () => {
        expect(typeof agent.pre_launch).toBe("string");
      });
    }

    if (agent.deps !== undefined) {
      it(`agent "${key}" deps should be an array of strings`, () => {
        expect(Array.isArray(agent.deps)).toBe(true);
        for (const dep of agent.deps!) {
          expect(typeof dep).toBe("string");
          expect(dep.length).toBeGreaterThan(0);
        }
      });
    }

    if (agent.config_files !== undefined) {
      it(`agent "${key}" config_files should be an object with string keys`, () => {
        expect(typeof agent.config_files).toBe("object");
        expect(agent.config_files).not.toBeNull();
        for (const filePath of Object.keys(agent.config_files!)) {
          expect(typeof filePath).toBe("string");
          expect(filePath.length).toBeGreaterThan(0);
        }
      });
    }

    if (agent.interactive_prompts !== undefined) {
      it(`agent "${key}" interactive_prompts should have valid entries`, () => {
        expect(typeof agent.interactive_prompts).toBe("object");
        expect(agent.interactive_prompts).not.toBeNull();
        for (const [promptKey, entry] of Object.entries(agent.interactive_prompts!)) {
          expect(typeof promptKey).toBe("string");
          expect(typeof entry.prompt).toBe("string");
          expect(entry.prompt.length).toBeGreaterThan(0);
          expect(typeof entry.default).toBe("string");
        }
      });
    }

    if (agent.dotenv !== undefined) {
      it(`agent "${key}" dotenv should have path and values`, () => {
        expect(typeof agent.dotenv!.path).toBe("string");
        expect(agent.dotenv!.path.length).toBeGreaterThan(0);
        expect(typeof agent.dotenv!.values).toBe("object");
        expect(agent.dotenv!.values).not.toBeNull();
        for (const [k, v] of Object.entries(agent.dotenv!.values)) {
          expect(typeof k).toBe("string");
          expect(typeof v).toBe("string");
        }
      });
    }

    if (agent.notes !== undefined) {
      it(`agent "${key}" notes should be a non-empty string`, () => {
        expect(typeof agent.notes).toBe("string");
        expect(agent.notes!.length).toBeGreaterThan(0);
      });
    }
  }
});

// ── Cloud required field types ────────────────────────────────────────────

describe("Cloud required field types", () => {
  for (const [key, cloud] of allClouds) {
    describe(`cloud "${key}"`, () => {
      it("name should be a non-empty string", () => {
        expect(typeof cloud.name).toBe("string");
        expect(cloud.name.length).toBeGreaterThan(0);
      });

      it("description should be a non-empty string", () => {
        expect(typeof cloud.description).toBe("string");
        expect(cloud.description.length).toBeGreaterThan(0);
      });

      it("url should be a valid URL string", () => {
        expect(typeof cloud.url).toBe("string");
        expect(cloud.url).toMatch(/^https?:\/\//);
      });

      it("type should be a non-empty string", () => {
        expect(typeof cloud.type).toBe("string");
        expect(cloud.type.length).toBeGreaterThan(0);
      });

      it("auth should be a string", () => {
        expect(typeof cloud.auth).toBe("string");
        // auth can be "none" but must be present
        expect(cloud.auth.length).toBeGreaterThan(0);
      });

      it("provision_method should be a non-empty string", () => {
        expect(typeof cloud.provision_method).toBe("string");
        expect(cloud.provision_method.length).toBeGreaterThan(0);
      });

      it("exec_method should be a non-empty string", () => {
        expect(typeof cloud.exec_method).toBe("string");
        expect(cloud.exec_method.length).toBeGreaterThan(0);
      });

      it("interactive_method should be a non-empty string", () => {
        expect(typeof cloud.interactive_method).toBe("string");
        expect(cloud.interactive_method.length).toBeGreaterThan(0);
      });
    });
  }
});

// ── Cloud optional field types ────────────────────────────────────────────

describe("Cloud optional field types (when present)", () => {
  for (const [key, cloud] of allClouds) {
    if (cloud.defaults !== undefined) {
      it(`cloud "${key}" defaults should be an object`, () => {
        expect(typeof cloud.defaults).toBe("object");
        expect(cloud.defaults).not.toBeNull();
        expect(Array.isArray(cloud.defaults)).toBe(false);
      });
    }

    if (cloud.notes !== undefined) {
      it(`cloud "${key}" notes should be a non-empty string`, () => {
        expect(typeof cloud.notes).toBe("string");
        expect(cloud.notes!.length).toBeGreaterThan(0);
      });
    }

    if (cloud.icon !== undefined) {
      it(`cloud "${key}" icon should be a valid URL string`, () => {
        expect(typeof cloud.icon).toBe("string");
        expect(cloud.icon).toMatch(/^https?:\/\//);
      });
    }
  }
});

// ── Cloud type value validation ───────────────────────────────────────────

describe("Cloud type values", () => {
  const validTypes = new Set<string>();

  for (const [key, cloud] of allClouds) {
    validTypes.add(cloud.type);
  }

  it("should have a reasonable number of distinct cloud types", () => {
    // There should be a few types (vm, cloud, container, sandbox, local, etc.)
    // but not so many that it's disorganized
    expect(validTypes.size).toBeGreaterThanOrEqual(2);
    expect(validTypes.size).toBeLessThanOrEqual(10);
  });

  it("cloud types should be lowercase", () => {
    for (const type of validTypes) {
      expect(type).toBe(type.toLowerCase());
    }
  });
});

// ── Cross-referential consistency ─────────────────────────────────────────

describe("Cross-referential consistency", () => {
  it("matrix keys should cover all cloud/agent combinations", () => {
    const expectedKeys = new Set<string>();
    for (const [cloud] of allClouds) {
      for (const [agent] of allAgents) {
        expectedKeys.add(`${cloud}/${agent}`);
      }
    }
    const actualKeys = new Set(Object.keys(manifest.matrix));
    expect(actualKeys.size).toBe(expectedKeys.size);
    for (const key of expectedKeys) {
      expect(actualKeys.has(key)).toBe(true);
    }
  });

  it("no matrix key should reference a nonexistent agent or cloud", () => {
    const agentSet = new Set(allAgents.map(([k]) => k));
    const cloudSet = new Set(allClouds.map(([k]) => k));
    for (const key of Object.keys(manifest.matrix)) {
      const [cloud, agent] = key.split("/");
      expect(cloudSet.has(cloud)).toBe(true);
      expect(agentSet.has(agent)).toBe(true);
    }
  });

  it("matrix values should only be 'implemented' or 'missing'", () => {
    for (const [key, status] of Object.entries(manifest.matrix)) {
      expect(status === "implemented" || status === "missing").toBe(true);
    }
  });
});

// ── Display name uniqueness ───────────────────────────────────────────────

describe("Display name uniqueness", () => {
  it("agent display names should be unique", () => {
    const names = allAgents.map(([, a]) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("cloud display names should be unique", () => {
    const names = allClouds.map(([, c]) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("agent keys should not collide with cloud keys", () => {
    const agentKeySet = new Set(allAgents.map(([k]) => k));
    for (const [cloudKey] of allClouds) {
      expect(agentKeySet.has(cloudKey)).toBe(false);
    }
  });
});

// ── Env var interpolation patterns ────────────────────────────────────────

describe("Env var interpolation patterns", () => {
  it("env values with ${...} should reference valid-looking env var names", () => {
    const varRefPattern = /\$\{([^}]+)\}/g;
    for (const [key, agent] of allAgents) {
      for (const [envKey, envVal] of Object.entries(agent.env)) {
        let match;
        while ((match = varRefPattern.exec(envVal)) !== null) {
          const refName = match[1];
          // Referenced env var names should look like valid env vars
          expect(refName).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      }
    }
  });

  it("env values should not contain unmatched ${", () => {
    for (const [key, agent] of allAgents) {
      for (const [envKey, envVal] of Object.entries(agent.env)) {
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
    for (const [key, agent] of allAgents) {
      // Launch commands shouldn't have pipe-to-bash or command substitution
      expect(agent.launch).not.toMatch(/\|\s*bash/);
      expect(agent.launch).not.toMatch(/\|\s*sh/);
      expect(agent.launch).not.toMatch(/`[^`]+`/);
      expect(agent.launch).not.toMatch(/\$\([^)]+\)/);
    }
  });

  it("install commands should be strings (can contain pipe for curl|bash)", () => {
    for (const [key, agent] of allAgents) {
      expect(typeof agent.install).toBe("string");
      expect(agent.install.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── Dotenv path validation ────────────────────────────────────────────────

describe("Dotenv configuration", () => {
  for (const [key, agent] of allAgents.filter(([, a]) => a.dotenv !== undefined)) {
    it(`agent "${key}" dotenv path should look like a file path`, () => {
      const path = agent.dotenv!.path;
      // Should contain a / or ~ indicating a path
      expect(path).toMatch(/[/~]/);
    });

    it(`agent "${key}" dotenv values should all be strings`, () => {
      for (const [k, v] of Object.entries(agent.dotenv!.values)) {
        expect(typeof v).toBe("string");
      }
    });
  }
});

// ── Interactive prompts structure ─────────────────────────────────────────

describe("Interactive prompts structure", () => {
  for (const [key, agent] of allAgents.filter(([, a]) => a.interactive_prompts !== undefined)) {
    for (const [promptKey, entry] of Object.entries(agent.interactive_prompts!)) {
      it(`agent "${key}" prompt "${promptKey}" should have non-empty prompt text`, () => {
        expect(entry.prompt.trim().length).toBeGreaterThan(0);
      });

      it(`agent "${key}" prompt "${promptKey}" default should be defined`, () => {
        expect(entry.default).toBeDefined();
        expect(typeof entry.default).toBe("string");
      });
    }
  }
});

// ── Agent metadata field types ────────────────────────────────────────

describe("Agent metadata field types (when present)", () => {
  for (const [key, agent] of allAgents) {
    if (agent.creator !== undefined) {
      it(`agent "${key}" creator should be a non-empty string`, () => {
        expect(typeof agent.creator).toBe("string");
        expect(agent.creator!.length).toBeGreaterThan(0);
      });
    }

    if (agent.repo !== undefined) {
      it(`agent "${key}" repo should match owner/repo format`, () => {
        expect(typeof agent.repo).toBe("string");
        expect(agent.repo).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
      });
    }

    if (agent.license !== undefined) {
      it(`agent "${key}" license should be a non-empty string`, () => {
        expect(typeof agent.license).toBe("string");
        expect(agent.license!.length).toBeGreaterThan(0);
      });
    }

    if (agent.created !== undefined) {
      it(`agent "${key}" created should be YYYY-MM format`, () => {
        expect(typeof agent.created).toBe("string");
        expect(agent.created).toMatch(/^\d{4}-\d{2}$/);
      });
    }

    if (agent.added !== undefined) {
      it(`agent "${key}" added should be YYYY-MM format`, () => {
        expect(typeof agent.added).toBe("string");
        expect(agent.added).toMatch(/^\d{4}-\d{2}$/);
      });
    }

    if (agent.github_stars !== undefined) {
      it(`agent "${key}" github_stars should be a non-negative number`, () => {
        expect(typeof agent.github_stars).toBe("number");
        expect(agent.github_stars!).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(agent.github_stars)).toBe(true);
      });
    }

    if (agent.stars_updated !== undefined) {
      it(`agent "${key}" stars_updated should be YYYY-MM-DD format`, () => {
        expect(typeof agent.stars_updated).toBe("string");
        expect(agent.stars_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    }

    if (agent.language !== undefined) {
      it(`agent "${key}" language should be a non-empty string`, () => {
        expect(typeof agent.language).toBe("string");
        expect(agent.language!.length).toBeGreaterThan(0);
      });
    }

    if (agent.runtime !== undefined) {
      it(`agent "${key}" runtime should be a non-empty string`, () => {
        expect(typeof agent.runtime).toBe("string");
        expect(agent.runtime!.length).toBeGreaterThan(0);
      });
    }

    if (agent.category !== undefined) {
      it(`agent "${key}" category should be cli, tui, or ide-extension`, () => {
        expect(typeof agent.category).toBe("string");
        expect([
          "cli",
          "tui",
          "ide-extension",
        ]).toContain(agent.category);
      });
    }

    if (agent.tagline !== undefined) {
      it(`agent "${key}" tagline should be a non-empty string`, () => {
        expect(typeof agent.tagline).toBe("string");
        expect(agent.tagline!.length).toBeGreaterThan(0);
      });
    }

    if (agent.tags !== undefined) {
      it(`agent "${key}" tags should be an array of non-empty strings`, () => {
        expect(Array.isArray(agent.tags)).toBe(true);
        for (const tag of agent.tags!) {
          expect(typeof tag).toBe("string");
          expect(tag.length).toBeGreaterThan(0);
        }
      });
    }
  }
});

// ── Config files structure ────────────────────────────────────────────────

describe("Config files structure", () => {
  for (const [key, agent] of allAgents.filter(([, a]) => a.config_files !== undefined)) {
    it(`agent "${key}" config file paths should look like file paths`, () => {
      for (const filePath of Object.keys(agent.config_files!)) {
        // Should contain / or ~ or . indicating a path
        expect(filePath).toMatch(/[/~.]/);
      }
    });

    it(`agent "${key}" config file values should be objects`, () => {
      for (const [path, content] of Object.entries(agent.config_files!)) {
        expect(typeof content).toBe("object");
        expect(content).not.toBeNull();
      }
    });
  }
});

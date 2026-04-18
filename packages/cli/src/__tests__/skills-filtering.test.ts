import type { Manifest } from "../manifest.js";

import { describe, expect, it } from "bun:test";
import { getAvailableSkills } from "../shared/skills.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManifest(skills?: Manifest["skills"]): Manifest {
  return {
    agents: {},
    clouds: {},
    matrix: {},
    skills,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getAvailableSkills", () => {
  it("returns empty array when manifest has no skills field", () => {
    const manifest = makeManifest(undefined);
    expect(getAvailableSkills(manifest, "claude")).toEqual([]);
  });

  it("returns empty array when skills object is empty", () => {
    const manifest = makeManifest({});
    expect(getAvailableSkills(manifest, "claude")).toEqual([]);
  });

  it("returns empty array when agent has no matching skills", () => {
    const manifest = makeManifest({
      "github-mcp": {
        name: "GitHub MCP",
        description: "GitHub tools via MCP",
        type: "mcp",
        agents: {
          cursor: {
            default: true,
          },
        },
      },
    });
    expect(getAvailableSkills(manifest, "claude")).toEqual([]);
  });

  it("returns skills that match the requested agent", () => {
    const manifest = makeManifest({
      "github-mcp": {
        name: "GitHub MCP",
        description: "GitHub tools via MCP",
        type: "mcp",
        agents: {
          claude: {
            default: true,
          },
          cursor: {
            default: false,
          },
        },
      },
      "playwright-mcp": {
        name: "Playwright",
        description: "Browser automation",
        type: "mcp",
        agents: {
          claude: {
            default: false,
          },
        },
      },
    });

    const result = getAvailableSkills(manifest, "claude");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("github-mcp");
    expect(result[0].name).toBe("GitHub MCP");
    expect(result[1].id).toBe("playwright-mcp");
    expect(result[1].name).toBe("Playwright");
  });

  it("marks isDefault correctly from agent config", () => {
    const manifest = makeManifest({
      "skill-a": {
        name: "Skill A",
        description: "Default skill",
        type: "instruction",
        agents: {
          claude: {
            default: true,
          },
        },
      },
      "skill-b": {
        name: "Skill B",
        description: "Non-default skill",
        type: "instruction",
        agents: {
          claude: {
            default: false,
          },
        },
      },
    });

    const result = getAvailableSkills(manifest, "claude");
    expect(result[0].isDefault).toBe(true);
    expect(result[1].isDefault).toBe(false);
  });

  it("collects envVars from skill definitions", () => {
    const manifest = makeManifest({
      "db-skill": {
        name: "Database",
        description: "DB access",
        type: "mcp",
        env_vars: [
          "DB_HOST",
          "DB_PASSWORD",
        ],
        agents: {
          claude: {
            default: false,
          },
        },
      },
    });

    const result = getAvailableSkills(manifest, "claude");
    expect(result[0].envVars).toEqual([
      "DB_HOST",
      "DB_PASSWORD",
    ]);
  });

  it("defaults envVars to empty array when skill has no env_vars", () => {
    const manifest = makeManifest({
      "simple-skill": {
        name: "Simple",
        description: "No env needed",
        type: "instruction",
        agents: {
          claude: {
            default: true,
          },
        },
      },
    });

    const result = getAvailableSkills(manifest, "claude");
    expect(result[0].envVars).toEqual([]);
  });

  it("includes description from skill definition", () => {
    const manifest = makeManifest({
      "test-skill": {
        name: "Test Skill",
        description: "A detailed description of the skill",
        type: "config",
        agents: {
          opencode: {
            default: true,
          },
        },
      },
    });

    const result = getAvailableSkills(manifest, "opencode");
    expect(result[0].description).toBe("A detailed description of the skill");
  });

  it("filters to only the requested agent across multiple skills", () => {
    const manifest = makeManifest({
      "skill-1": {
        name: "S1",
        description: "d1",
        type: "mcp",
        agents: {
          claude: {
            default: true,
          },
          cursor: {
            default: true,
          },
        },
      },
      "skill-2": {
        name: "S2",
        description: "d2",
        type: "mcp",
        agents: {
          cursor: {
            default: true,
          },
        },
      },
      "skill-3": {
        name: "S3",
        description: "d3",
        type: "instruction",
        agents: {
          claude: {
            default: false,
          },
        },
      },
    });

    const claudeSkills = getAvailableSkills(manifest, "claude");
    expect(claudeSkills).toHaveLength(2);
    expect(claudeSkills.map((s) => s.id)).toEqual([
      "skill-1",
      "skill-3",
    ]);

    const cursorSkills = getAvailableSkills(manifest, "cursor");
    expect(cursorSkills).toHaveLength(2);
    expect(cursorSkills.map((s) => s.id)).toEqual([
      "skill-1",
      "skill-2",
    ]);
  });
});

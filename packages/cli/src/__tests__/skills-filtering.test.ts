import type { Manifest } from "../manifest.js";
import type { CloudRunner } from "../shared/agent-setup.js";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

const clack = mockClackPrompts();

const { getAvailableSkills, promptSkillSelection, collectSkillEnvVars, installSkills } = await import(
  "../shared/skills.js"
);

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

// ─── promptSkillSelection Tests ───────────────────────────────────────────────

describe("promptSkillSelection", () => {
  it("returns undefined when no skills available for agent", async () => {
    const manifest = makeManifest({});
    const result = await promptSkillSelection(manifest, "claude");
    expect(result).toBeUndefined();
  });

  it("returns selected skill IDs from multiselect", async () => {
    clack.multiselect.mockResolvedValueOnce([
      "github-mcp",
      "playwright-mcp",
    ]);
    const manifest = makeManifest({
      "github-mcp": {
        name: "GitHub MCP",
        description: "GitHub tools",
        type: "mcp",
        agents: {
          claude: {
            default: true,
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

    const result = await promptSkillSelection(manifest, "claude");
    expect(result).toEqual([
      "github-mcp",
      "playwright-mcp",
    ]);
  });

  it("returns empty array when user cancels", async () => {
    clack.multiselect.mockResolvedValueOnce(Symbol("cancel"));
    // Temporarily override isCancel to detect the cancel symbol
    mock.module("@clack/prompts", () => ({
      spinner: () => ({
        start: mock(() => {}),
        stop: mock(() => {}),
        message: mock(() => {}),
        clear: mock(() => {}),
      }),
      log: {
        step: mock(() => {}),
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        success: mock(() => {}),
        message: mock(() => {}),
      },
      intro: mock(() => {}),
      outro: mock(() => {}),
      cancel: mock(() => {}),
      select: mock(() => {}),
      autocomplete: mock(async () => "claude"),
      text: mock(async () => undefined),
      confirm: mock(async () => true),
      multiselect: clack.multiselect,
      isCancel: (val: unknown) => typeof val === "symbol",
    }));

    const manifest = makeManifest({
      "skill-a": {
        name: "Skill A",
        description: "desc",
        type: "mcp",
        agents: {
          claude: {
            default: true,
          },
        },
      },
    });

    const { promptSkillSelection: pss } = await import("../shared/skills.js");
    const result = await pss(manifest, "claude");
    expect(result).toEqual([]);

    // Restore the original mock
    mockClackPrompts();
  });
});

// ─── collectSkillEnvVars Tests ────────────────────────────────────────────────

describe("collectSkillEnvVars", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.TEST_VAR_A = process.env.TEST_VAR_A;
    originalEnv.TEST_VAR_B = process.env.TEST_VAR_B;
  });

  afterEach(() => {
    if (originalEnv.TEST_VAR_A === undefined) {
      delete process.env.TEST_VAR_A;
    } else {
      process.env.TEST_VAR_A = originalEnv.TEST_VAR_A;
    }
    if (originalEnv.TEST_VAR_B === undefined) {
      delete process.env.TEST_VAR_B;
    } else {
      process.env.TEST_VAR_B = originalEnv.TEST_VAR_B;
    }
  });

  it("returns empty array when manifest has no skills", async () => {
    const manifest = makeManifest(undefined);
    const result = await collectSkillEnvVars(manifest, [
      "some-skill",
    ]);
    expect(result).toEqual([]);
  });

  it("returns empty array when selected skills have no env_vars", async () => {
    const manifest = makeManifest({
      "simple-skill": {
        name: "Simple",
        description: "No env",
        type: "instruction",
        agents: {
          claude: {
            default: true,
          },
        },
      },
    });
    const result = await collectSkillEnvVars(manifest, [
      "simple-skill",
    ]);
    expect(result).toEqual([]);
  });

  it("uses env vars from process.env when available", async () => {
    process.env.TEST_VAR_A = "value_a";
    const manifest = makeManifest({
      "db-skill": {
        name: "Database",
        description: "DB",
        type: "mcp",
        env_vars: [
          "TEST_VAR_A",
        ],
        agents: {
          claude: {
            default: false,
          },
        },
      },
    });
    const result = await collectSkillEnvVars(manifest, [
      "db-skill",
    ]);
    expect(result).toEqual([
      "TEST_VAR_A=value_a",
    ]);
  });

  it("skips env var when text prompt returns empty", async () => {
    delete process.env.TEST_VAR_B;
    // Default text mock returns undefined → skipped
    const manifest = makeManifest({
      "api-skill": {
        name: "API",
        description: "API access",
        type: "mcp",
        env_vars: [
          "TEST_VAR_B",
        ],
        agents: {
          claude: {
            default: false,
          },
        },
      },
    });
    const result = await collectSkillEnvVars(manifest, [
      "api-skill",
    ]);
    expect(result).toEqual([]);
  });
});

// ─── installSkills Tests ──────────────────────────────────────────────────────

function makeMockRunner(commands?: string[]): CloudRunner {
  const cmds = commands ?? [];
  return {
    runServer: mock(async (cmd: string) => {
      cmds.push(cmd);
    }),
    uploadFile: mock(async () => {}),
    downloadFile: mock(async () => {}),
  };
}

describe("installSkills", () => {
  it("returns immediately when no skills provided", async () => {
    const runner = makeMockRunner();
    const manifest = makeManifest({
      "skill-a": {
        name: "A",
        description: "d",
        type: "mcp",
        agents: {
          claude: {
            default: true,
          },
        },
      },
    });
    await installSkills(runner, manifest, "claude", []);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("returns immediately when manifest has no skills", async () => {
    const runner = makeMockRunner();
    const manifest = makeManifest(undefined);
    await installSkills(runner, manifest, "claude", [
      "nonexistent",
    ]);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("runs prerequisite commands before installing instruction skills", async () => {
    const commands: string[] = [];
    const runner = makeMockRunner(commands);
    const manifest = makeManifest({
      "chrome-skill": {
        name: "Chrome",
        description: "Browser instruction",
        type: "instruction",
        content: "# Use Chrome for testing",
        prerequisites: {
          commands: [
            "apt-get install -y chromium",
          ],
        },
        agents: {
          claude: {
            default: true,
            instruction_path: "$HOME/.claude/skills/chrome/SKILL.md",
          },
        },
      },
    });

    await installSkills(runner, manifest, "claude", [
      "chrome-skill",
    ]);
    // prerequisite command should have been called first
    expect(commands[0]).toBe("apt-get install -y chromium");
  });

  it("installs instruction skills via base64 injection", async () => {
    const commands: string[] = [];
    const runner = makeMockRunner(commands);
    const manifest = makeManifest({
      "my-instruction": {
        name: "My Instruction",
        description: "A skill",
        type: "instruction",
        content: "# Hello World",
        agents: {
          claude: {
            default: true,
            instruction_path: "$HOME/.claude/skills/my-instruction/SKILL.md",
          },
        },
      },
    });

    await installSkills(runner, manifest, "claude", [
      "my-instruction",
    ]);
    // Should have run a mkdir + base64 decode command
    const injectionCmd = commands.find((c) => c.includes("base64"));
    expect(injectionCmd).toBeDefined();
    expect(injectionCmd).toContain("mkdir -p");
  });
});

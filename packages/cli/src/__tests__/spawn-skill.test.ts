import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSpawnSkillPath,
  getSpawnSkillSourceFile,
  injectSpawnSkill,
  isAppendMode,
  readSkillContent,
} from "../shared/spawn-skill.js";

// ─── Path mapping tests ─────────────────────────────────────────────────────

describe("getSpawnSkillPath", () => {
  it("returns correct path for claude", () => {
    expect(getSpawnSkillPath("claude")).toBe("~/.claude/skills/spawn/SKILL.md");
  });

  it("returns correct path for codex", () => {
    expect(getSpawnSkillPath("codex")).toBe("~/.agents/skills/spawn/SKILL.md");
  });

  it("returns correct path for openclaw", () => {
    expect(getSpawnSkillPath("openclaw")).toBe("~/.openclaw/skills/spawn/SKILL.md");
  });

  it("returns correct path for zeroclaw", () => {
    expect(getSpawnSkillPath("zeroclaw")).toBe("~/.zeroclaw/workspace/AGENTS.md");
  });

  it("returns correct path for opencode", () => {
    expect(getSpawnSkillPath("opencode")).toBe("~/.config/opencode/AGENTS.md");
  });

  it("returns correct path for kilocode", () => {
    expect(getSpawnSkillPath("kilocode")).toBe("~/.kilocode/rules/spawn.md");
  });

  it("returns correct path for hermes", () => {
    expect(getSpawnSkillPath("hermes")).toBe("~/.hermes/SOUL.md");
  });

  it("returns correct path for junie", () => {
    expect(getSpawnSkillPath("junie")).toBe("~/.junie/AGENTS.md");
  });

  it("returns undefined for unknown agent", () => {
    expect(getSpawnSkillPath("nonexistent")).toBeUndefined();
  });
});

describe("getSpawnSkillSourceFile", () => {
  it("returns correct source for claude", () => {
    expect(getSpawnSkillSourceFile("claude")).toBe("claude/SKILL.md");
  });

  it("returns correct source for codex", () => {
    expect(getSpawnSkillSourceFile("codex")).toBe("codex/SKILL.md");
  });

  it("returns correct source for openclaw", () => {
    expect(getSpawnSkillSourceFile("openclaw")).toBe("openclaw/SKILL.md");
  });

  it("returns correct source for zeroclaw", () => {
    expect(getSpawnSkillSourceFile("zeroclaw")).toBe("zeroclaw/AGENTS.md");
  });

  it("returns correct source for opencode", () => {
    expect(getSpawnSkillSourceFile("opencode")).toBe("opencode/AGENTS.md");
  });

  it("returns correct source for kilocode", () => {
    expect(getSpawnSkillSourceFile("kilocode")).toBe("kilocode/spawn.md");
  });

  it("returns correct source for hermes", () => {
    expect(getSpawnSkillSourceFile("hermes")).toBe("hermes/SOUL.md");
  });

  it("returns correct source for junie", () => {
    expect(getSpawnSkillSourceFile("junie")).toBe("junie/AGENTS.md");
  });

  it("returns undefined for unknown agent", () => {
    expect(getSpawnSkillSourceFile("nonexistent")).toBeUndefined();
  });
});

// ─── Append mode tests ──────────────────────────────────────────────────────

describe("isAppendMode", () => {
  it("returns true for hermes", () => {
    expect(isAppendMode("hermes")).toBe(true);
  });

  it("returns false for claude", () => {
    expect(isAppendMode("claude")).toBe(false);
  });

  it("returns false for codex", () => {
    expect(isAppendMode("codex")).toBe(false);
  });

  it("returns false for openclaw", () => {
    expect(isAppendMode("openclaw")).toBe(false);
  });

  it("returns false for zeroclaw", () => {
    expect(isAppendMode("zeroclaw")).toBe(false);
  });

  it("returns false for opencode", () => {
    expect(isAppendMode("opencode")).toBe(false);
  });

  it("returns false for kilocode", () => {
    expect(isAppendMode("kilocode")).toBe(false);
  });

  it("returns false for junie", () => {
    expect(isAppendMode("junie")).toBe(false);
  });
});

// ─── Skill file existence tests ─────────────────────────────────────────────

describe("skill files exist in repo", () => {
  // Find the skills/ directory relative to this test
  const skillsDir = join(import.meta.dir, "../../../../skills");

  const agents = [
    "claude",
    "codex",
    "openclaw",
    "zeroclaw",
    "opencode",
    "kilocode",
    "hermes",
    "junie",
  ];

  for (const agent of agents) {
    it(`skill file exists and is non-empty for ${agent}`, () => {
      const sourceFile = getSpawnSkillSourceFile(agent);
      expect(sourceFile).toBeDefined();
      const filePath = join(skillsDir, sourceFile!);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  }

  for (const agent of [
    "claude",
    "codex",
    "openclaw",
  ]) {
    it(`${agent} skill file contains YAML frontmatter with name: spawn`, () => {
      const sourceFile = getSpawnSkillSourceFile(agent);
      const filePath = join(skillsDir, sourceFile!);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toStartWith("---\n");
      expect(content).toContain("name: spawn");
    });
  }

  for (const agent of [
    "zeroclaw",
    "opencode",
    "kilocode",
    "junie",
  ]) {
    it(`${agent} skill file is plain markdown (no YAML frontmatter)`, () => {
      const sourceFile = getSpawnSkillSourceFile(agent);
      const filePath = join(skillsDir, sourceFile!);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toStartWith("# Spawn");
    });
  }
});

// ─── injectSpawnSkill tests ─────────────────────────────────────────────────

describe("injectSpawnSkill", () => {
  it("calls runner.runServer with correct base64 + path for claude", async () => {
    let capturedCmd = "";
    const mockRunner = {
      runServer: mock(async (cmd: string) => {
        capturedCmd = cmd;
      }),
      uploadFile: mock(async () => {}),
    };

    await injectSpawnSkill(mockRunner, "claude");

    expect(mockRunner.runServer).toHaveBeenCalledTimes(1);
    expect(capturedCmd).toContain("~/.claude/skills/spawn/SKILL.md");
    expect(capturedCmd).toContain("mkdir -p ~/.claude/skills/spawn");
    expect(capturedCmd).toContain("base64 -d >");
    expect(capturedCmd).toContain("chmod 644");
    // Should use overwrite (>) not append (>>)
    expect(capturedCmd).not.toContain(">>");
  });

  it("uses append mode (>>) for hermes", async () => {
    let capturedCmd = "";
    const mockRunner = {
      runServer: mock(async (cmd: string) => {
        capturedCmd = cmd;
      }),
      uploadFile: mock(async () => {}),
    };

    await injectSpawnSkill(mockRunner, "hermes");

    expect(mockRunner.runServer).toHaveBeenCalledTimes(1);
    expect(capturedCmd).toContain("~/.hermes/SOUL.md");
    expect(capturedCmd).toContain(">>");
    // Should NOT contain chmod for append mode
    expect(capturedCmd).not.toContain("chmod");
  });

  it("creates parent directories for all agents", async () => {
    const agents = [
      "claude",
      "codex",
      "openclaw",
      "zeroclaw",
      "opencode",
      "kilocode",
      "hermes",
      "junie",
    ];
    for (const agent of agents) {
      let capturedCmd = "";
      const mockRunner = {
        runServer: mock(async (cmd: string) => {
          capturedCmd = cmd;
        }),
        uploadFile: mock(async () => {}),
      };

      await injectSpawnSkill(mockRunner, agent);
      expect(capturedCmd).toContain("mkdir -p");
    }
  });

  it("handles runner failure gracefully", async () => {
    const mockRunner = {
      runServer: mock(async () => {
        throw new Error("SSH connection refused");
      }),
      uploadFile: mock(async () => {}),
    };

    // Should not throw
    await injectSpawnSkill(mockRunner, "claude");
    expect(mockRunner.runServer).toHaveBeenCalledTimes(1);
  });

  it("does nothing for unknown agent", async () => {
    const mockRunner = {
      runServer: mock(async () => {}),
      uploadFile: mock(async () => {}),
    };

    await injectSpawnSkill(mockRunner, "nonexistent");
    expect(mockRunner.runServer).not.toHaveBeenCalled();
  });

  it("base64-encodes real skill content", async () => {
    let capturedCmd = "";
    const mockRunner = {
      runServer: mock(async (cmd: string) => {
        capturedCmd = cmd;
      }),
      uploadFile: mock(async () => {}),
    };

    await injectSpawnSkill(mockRunner, "codex");

    // Extract the base64 string from the command
    const b64Match = capturedCmd.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
    expect(b64Match).not.toBeNull();
    // Decode and verify it contains spawn skill content
    const decoded = Buffer.from(b64Match![1], "base64").toString("utf-8");
    expect(decoded).toContain("Spawn");
    expect(decoded).toContain("spawn");
  });
});

// ─── readSkillContent tests ─────────────────────────────────────────────────

describe("readSkillContent", () => {
  it("returns content for known agent", () => {
    const content = readSkillContent("claude");
    expect(content).not.toBeNull();
    expect(content).toContain("Spawn");
  });

  it("returns null for unknown agent", () => {
    expect(readSkillContent("nonexistent")).toBeNull();
  });
});

// ─── "spawn" step visibility tests ──────────────────────────────────────────

describe("spawn step gating", () => {
  const savedBeta = process.env.SPAWN_BETA;

  afterEach(() => {
    if (savedBeta === undefined) {
      delete process.env.SPAWN_BETA;
    } else {
      process.env.SPAWN_BETA = savedBeta;
    }
  });

  it("spawn step appears when SPAWN_BETA includes recursive", async () => {
    process.env.SPAWN_BETA = "recursive";
    // Re-import to pick up the env var (the function reads env at call time)
    const { getAgentOptionalSteps } = await import("../shared/agents.js");
    const steps = getAgentOptionalSteps("claude");
    const spawnStep = steps.find((s) => s.value === "spawn");
    expect(spawnStep).toBeDefined();
    expect(spawnStep!.defaultOn).toBe(true);
  });

  it("spawn step does not appear without --beta recursive", async () => {
    delete process.env.SPAWN_BETA;
    const { getAgentOptionalSteps } = await import("../shared/agents.js");
    const steps = getAgentOptionalSteps("claude");
    const spawnStep = steps.find((s) => s.value === "spawn");
    expect(spawnStep).toBeUndefined();
  });

  it("spawn step appears alongside other beta features", async () => {
    process.env.SPAWN_BETA = "tarball,recursive";
    const { getAgentOptionalSteps } = await import("../shared/agents.js");
    const steps = getAgentOptionalSteps("openclaw");
    const spawnStep = steps.find((s) => s.value === "spawn");
    expect(spawnStep).toBeDefined();
  });
});

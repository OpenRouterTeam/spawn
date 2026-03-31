import { afterEach, describe, expect, it, mock } from "bun:test";
import { getSkillContent, getSpawnSkillPath, injectSpawnSkill, isAppendMode } from "../shared/spawn-skill.js";

// ─── Path mapping tests ─────────────────────────────────────────────────────

describe("getSpawnSkillPath", () => {
  const expectedPaths: Array<
    [
      string,
      string,
    ]
  > = [
    [
      "claude",
      "~/.claude/skills/spawn/SKILL.md",
    ],
    [
      "codex",
      "~/.agents/skills/spawn/SKILL.md",
    ],
    [
      "openclaw",
      "~/.openclaw/skills/spawn/SKILL.md",
    ],
    [
      "opencode",
      "~/.config/opencode/AGENTS.md",
    ],
    [
      "kilocode",
      "~/.kilocode/rules/spawn.md",
    ],
    [
      "hermes",
      "~/.hermes/SOUL.md",
    ],
    [
      "junie",
      "~/.junie/AGENTS.md",
    ],
  ];

  it("returns correct remote path for each known agent", () => {
    for (const [agent, expectedPath] of expectedPaths) {
      expect(getSpawnSkillPath(agent), `agent "${agent}"`).toBe(expectedPath);
    }
  });

  it("returns undefined for unknown agent", () => {
    expect(getSpawnSkillPath("nonexistent")).toBeUndefined();
  });
});

// ─── Append mode tests ──────────────────────────────────────────────────────

describe("isAppendMode", () => {
  it("returns true only for hermes (appends to SOUL.md)", () => {
    expect(isAppendMode("hermes")).toBe(true);
  });

  it("returns false for all non-hermes agents", () => {
    const overwriteAgents = [
      "claude",
      "codex",
      "openclaw",
      "opencode",
      "kilocode",
      "junie",
    ];
    for (const agent of overwriteAgents) {
      expect(isAppendMode(agent), `agent "${agent}"`).toBe(false);
    }
  });
});

// ─── Embedded content tests ─────────────────────────────────────────────────

describe("getSkillContent", () => {
  const agents = [
    "claude",
    "codex",
    "openclaw",
    "opencode",
    "kilocode",
    "hermes",
    "junie",
  ];

  for (const agent of agents) {
    it(`returns non-empty content for ${agent}`, () => {
      const content = getSkillContent(agent);
      expect(content).toBeDefined();
      expect(content!.length).toBeGreaterThan(0);
    });
  }

  for (const agent of [
    "claude",
    "codex",
    "openclaw",
  ]) {
    it(`${agent} content has YAML frontmatter with name: spawn`, () => {
      const content = getSkillContent(agent);
      expect(content).toBeDefined();
      expect(content!).toStartWith("---\n");
      expect(content!).toContain("name: spawn");
    });
  }

  for (const agent of [
    "opencode",
    "kilocode",
    "junie",
  ]) {
    it(`${agent} content is plain markdown (no YAML frontmatter)`, () => {
      const content = getSkillContent(agent);
      expect(content).toBeDefined();
      expect(content!).toStartWith("# Spawn");
    });
  }

  it("hermes content is short append snippet", () => {
    const content = getSkillContent("hermes");
    expect(content).toBeDefined();
    expect(content!).toContain("Spawn Capability");
    expect(content!).not.toContain("# Spawn — Create Child VMs");
  });

  it("returns undefined for unknown agent", () => {
    expect(getSkillContent("nonexistent")).toBeUndefined();
  });
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

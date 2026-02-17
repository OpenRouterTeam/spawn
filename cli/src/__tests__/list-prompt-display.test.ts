import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Tests for prompt-related display logic in cmdList and the
 * suggestCloudsForPrompt error path in index.ts.
 *
 * cmdList (commands.ts) has prompt-specific display paths:
 * - Record rows show a truncated prompt preview (>40 chars get "...")
 * - Rerun hint includes --prompt with short prompts
 * - Rerun hint truncates long prompts (>30 chars get "...")
 * - Records without prompts show no --prompt in rerun hint
 *
 * suggestCloudsForPrompt (index.ts) handles the error path when
 * a user provides --prompt with an agent but no cloud:
 * - Shows "requires both <agent> and <cloud>" error
 * - Fetches manifest to suggest available clouds
 * - Lists up to 5 cloud suggestions with example commands
 * - Shows "see all N clouds" hint when >5 clouds are available
 * - Handles unresolvable agent names gracefully
 * - Handles manifest fetch failures gracefully
 *
 * Agent: test-engineer
 */

// ── Replica of suggestCloudsForPrompt routing logic ──────────────────────────
// This is the display-name resolution + cloud suggestion logic from index.ts
// lines 156-180. We test the exact logic via a faithful replica because
// suggestCloudsForPrompt is not exported and calls process.exit.

interface SuggestResult {
  errorMessages: string[];
  suggestions: string[];
  overflowHint?: string;
}

function suggestCloudsForPrompt(
  agent: string,
  manifest: {
    agents: Record<string, { name: string }>;
    clouds: Record<string, { name: string }>;
    matrix: Record<string, string>;
  } | null,
  resolveAgentKey: (manifest: any, agent: string) => string | null
): SuggestResult {
  const result: SuggestResult = {
    errorMessages: [],
    suggestions: [],
  };

  result.errorMessages.push("Error: --prompt requires both <agent> and <cloud>");
  result.errorMessages.push(`Usage: spawn ${agent} <cloud> --prompt "your prompt here"`);

  if (!manifest) return result;

  const resolvedAgent = resolveAgentKey(manifest, agent);
  if (!resolvedAgent) return result;

  const clouds = Object.keys(manifest.clouds).filter(
    (c: string) => manifest.matrix[`${c}/${resolvedAgent}`] === "implemented"
  );
  if (clouds.length === 0) return result;

  for (const c of clouds.slice(0, 5)) {
    result.suggestions.push(`spawn ${resolvedAgent} ${c} --prompt "..."`);
  }
  if (clouds.length > 5) {
    result.overflowHint = `Run spawn ${resolvedAgent} to see all ${clouds.length} clouds.`;
  }

  return result;
}

// ── Replica of resolveEntityKey from commands.ts ─────────────────────────────

function resolveAgentKey(
  manifest: { agents: Record<string, { name: string }> },
  input: string
): string | null {
  if (manifest.agents[input]) return input;
  const keys = Object.keys(manifest.agents);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of keys) {
    if (manifest.agents[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

// ── suggestCloudsForPrompt tests ─────────────────────────────────────────────

describe("suggestCloudsForPrompt", () => {
  const manifest = {
    agents: {
      claude: { name: "Claude Code" },
      aider: { name: "Aider" },
    },
    clouds: {
      sprite: { name: "Sprite" },
      hetzner: { name: "Hetzner Cloud" },
      vultr: { name: "Vultr" },
    },
    matrix: {
      "sprite/claude": "implemented",
      "hetzner/claude": "implemented",
      "vultr/claude": "implemented",
      "sprite/aider": "implemented",
      "hetzner/aider": "missing",
      "vultr/aider": "missing",
    },
  };

  describe("error message formatting", () => {
    it("should always include the 'requires both' error", () => {
      const result = suggestCloudsForPrompt("claude", manifest, resolveAgentKey);
      expect(result.errorMessages[0]).toContain("--prompt requires both");
    });

    it("should include usage example with agent name", () => {
      const result = suggestCloudsForPrompt("claude", manifest, resolveAgentKey);
      expect(result.errorMessages[1]).toContain("spawn claude");
      expect(result.errorMessages[1]).toContain("<cloud>");
    });

    it("should use the actual agent name in usage example", () => {
      const result = suggestCloudsForPrompt("aider", manifest, resolveAgentKey);
      expect(result.errorMessages[1]).toContain("spawn aider");
    });
  });

  describe("cloud suggestions", () => {
    it("should suggest all implemented clouds for the agent", () => {
      const result = suggestCloudsForPrompt("claude", manifest, resolveAgentKey);
      expect(result.suggestions).toHaveLength(3);
      expect(result.suggestions[0]).toContain("spawn claude sprite");
      expect(result.suggestions[1]).toContain("spawn claude hetzner");
      expect(result.suggestions[2]).toContain("spawn claude vultr");
    });

    it("should suggest only implemented clouds for partially implemented agent", () => {
      const result = suggestCloudsForPrompt("aider", manifest, resolveAgentKey);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toContain("spawn aider sprite");
    });

    it("should include --prompt in each suggestion", () => {
      const result = suggestCloudsForPrompt("claude", manifest, resolveAgentKey);
      for (const suggestion of result.suggestions) {
        expect(suggestion).toContain("--prompt");
      }
    });
  });

  describe("overflow hint for >5 clouds", () => {
    const manyCloudManifest = {
      agents: { claude: { name: "Claude Code" } },
      clouds: {
        c1: { name: "Cloud 1" },
        c2: { name: "Cloud 2" },
        c3: { name: "Cloud 3" },
        c4: { name: "Cloud 4" },
        c5: { name: "Cloud 5" },
        c6: { name: "Cloud 6" },
        c7: { name: "Cloud 7" },
      },
      matrix: {
        "c1/claude": "implemented",
        "c2/claude": "implemented",
        "c3/claude": "implemented",
        "c4/claude": "implemented",
        "c5/claude": "implemented",
        "c6/claude": "implemented",
        "c7/claude": "implemented",
      },
    };

    it("should limit suggestions to 5 clouds", () => {
      const result = suggestCloudsForPrompt("claude", manyCloudManifest, resolveAgentKey);
      expect(result.suggestions).toHaveLength(5);
    });

    it("should show overflow hint with total count", () => {
      const result = suggestCloudsForPrompt("claude", manyCloudManifest, resolveAgentKey);
      expect(result.overflowHint).toContain("7 clouds");
    });

    it("should include agent name in overflow hint", () => {
      const result = suggestCloudsForPrompt("claude", manyCloudManifest, resolveAgentKey);
      expect(result.overflowHint).toContain("spawn claude");
    });
  });

  describe("no overflow hint for <=5 clouds", () => {
    it("should not show overflow hint when exactly 5 clouds", () => {
      const fiveCloudManifest = {
        agents: { claude: { name: "Claude Code" } },
        clouds: {
          c1: { name: "C1" }, c2: { name: "C2" }, c3: { name: "C3" },
          c4: { name: "C4" }, c5: { name: "C5" },
        },
        matrix: {
          "c1/claude": "implemented", "c2/claude": "implemented",
          "c3/claude": "implemented", "c4/claude": "implemented",
          "c5/claude": "implemented",
        },
      };
      const result = suggestCloudsForPrompt("claude", fiveCloudManifest, resolveAgentKey);
      expect(result.suggestions).toHaveLength(5);
      expect(result.overflowHint).toBeUndefined();
    });

    it("should not show overflow hint when fewer than 5 clouds", () => {
      const result = suggestCloudsForPrompt("claude", manifest, resolveAgentKey);
      expect(result.overflowHint).toBeUndefined();
    });
  });

  describe("unresolvable agent", () => {
    it("should return no suggestions for unknown agent", () => {
      const result = suggestCloudsForPrompt("nonexistent", manifest, resolveAgentKey);
      expect(result.suggestions).toHaveLength(0);
      expect(result.overflowHint).toBeUndefined();
    });

    it("should still include error messages for unknown agent", () => {
      const result = suggestCloudsForPrompt("nonexistent", manifest, resolveAgentKey);
      expect(result.errorMessages.length).toBeGreaterThan(0);
      expect(result.errorMessages[0]).toContain("--prompt requires both");
    });
  });

  describe("manifest unavailable", () => {
    it("should return no suggestions when manifest is null", () => {
      const result = suggestCloudsForPrompt("claude", null, resolveAgentKey);
      expect(result.suggestions).toHaveLength(0);
    });

    it("should still include error messages when manifest is null", () => {
      const result = suggestCloudsForPrompt("claude", null, resolveAgentKey);
      expect(result.errorMessages.length).toBeGreaterThan(0);
    });
  });

  describe("agent with no implemented clouds", () => {
    const noImplManifest = {
      agents: { ghost: { name: "Ghost Agent" } },
      clouds: { sprite: { name: "Sprite" } },
      matrix: { "sprite/ghost": "missing" },
    };

    it("should return no suggestions when agent has no implementations", () => {
      const result = suggestCloudsForPrompt("ghost", noImplManifest, resolveAgentKey);
      expect(result.suggestions).toHaveLength(0);
    });
  });

  describe("agent resolved via display name", () => {
    it("should resolve via case-insensitive key and suggest clouds", () => {
      const result = suggestCloudsForPrompt("CLAUDE", manifest, resolveAgentKey);
      expect(result.suggestions.length).toBeGreaterThan(0);
      // Suggestions should use the resolved key, not the input
      expect(result.suggestions[0]).toContain("spawn claude");
    });

    it("should resolve via display name and suggest clouds", () => {
      const result = suggestCloudsForPrompt("Claude Code", manifest, resolveAgentKey);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions[0]).toContain("spawn claude");
    });
  });
});

// ── cmdList prompt display tests ─────────────────────────────────────────────

describe("cmdList prompt display", () => {
  let testDir: string;
  let consoleMocks: { log: ReturnType<typeof spyOn>; error: ReturnType<typeof spyOn> };
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(homedir(), `spawn-prompt-display-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    consoleMocks = {
      log: spyOn(console, "log").mockImplementation(() => {}),
      error: spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleMocks.log.mockRestore();
    consoleMocks.error.mockRestore();
    process.env = originalEnv;
    try { rmSync(testDir, { recursive: true, force: true }); } catch (err: any) {
      // Expected: ENOENT if directory doesn't exist.
      if (err.code !== "ENOENT") console.error("Unexpected error removing test directory:", err);
    }
  });

  describe("prompt preview in record rows", () => {
    it("should show short prompt in full (<=40 chars)", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: "Fix the auth bug",
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("Fix the auth bug");
      expect(allOutput).toContain("--prompt");
    });

    it("should truncate long prompt with ellipsis (>40 chars)", async () => {
      const longPrompt = "Fix all the linter errors and add comprehensive unit tests for every module";
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: longPrompt,
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      // Row display should show first 40 chars + "..."
      expect(allOutput).toContain(longPrompt.slice(0, 40));
      expect(allOutput).toContain("...");
      // Rerun hint shows full prompt (<=80 chars) so it's a valid copyable command
      expect(allOutput).toContain(`--prompt "${longPrompt}"`);
    });

    it("should show prompt exactly at 40 chars without truncation", async () => {
      const exact40 = "A".repeat(40);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: exact40,
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain(exact40);
    });

    it("should truncate prompt at 41 chars", async () => {
      const chars41 = "B".repeat(41);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: chars41,
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("B".repeat(40));
      expect(allOutput).toContain("...");
    });

    it("should not show --prompt for records without prompt", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("claude");
      expect(allOutput).toContain("sprite");
      // Records without prompt should not show --prompt in the row
      const rowLines = consoleMocks.log.mock.calls
        .map(c => String(c[0] ?? ""))
        .filter(l => l.includes("claude") && l.includes("sprite") && !l.includes("AGENT"));
      for (const line of rowLines) {
        expect(line).not.toContain("--prompt");
      }
    });
  });

  describe("rerun hint with prompts", () => {
    it("should include --prompt in rerun hint when latest has a prompt", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: "Fix bugs",
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("Rerun last");
      expect(allOutput).toContain("--prompt");
      expect(allOutput).toContain("Fix bugs");
    });

    it("should show full prompt in rerun hint when <= 80 chars", async () => {
      const longPrompt = "Fix all linter errors and refactor the auth module completely";
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: longPrompt,
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("Rerun last");
      // buildRetryCommand includes full prompt when <= 80 chars for a valid copyable command
      expect(allOutput).toContain(`--prompt "${longPrompt}"`);
    });

    it("should suggest --prompt-file in rerun hint when > 80 chars", async () => {
      const veryLongPrompt = "A".repeat(81);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: veryLongPrompt,
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("Rerun last");
      expect(allOutput).toContain("--prompt-file");
    });

    it("should not truncate prompt in rerun hint at exactly 30 chars", async () => {
      const exact30 = "C".repeat(30);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: exact30,
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain(exact30);
    });

    it("should not include --prompt in rerun hint when latest has no prompt", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      expect(allOutput).toContain("Rerun last");
      expect(allOutput).toContain("spawn claude sprite");
      // Rerun line should NOT contain --prompt
      const rerunLines = consoleMocks.log.mock.calls
        .map(c => String(c[0] ?? ""))
        .filter(l => l.includes("Rerun last"));
      for (const line of rerunLines) {
        expect(line).not.toContain("--prompt");
      }
    });

    it("should use newest record for rerun hint (newest-first order)", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([
          { agent: "aider", cloud: "hetzner", timestamp: "2026-02-09T08:00:00Z", prompt: "Old prompt" },
          { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T12:00:00Z", prompt: "Latest prompt" },
        ])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      // Rerun hint should reference the newest (claude/sprite), not the oldest
      const rerunLines = consoleMocks.log.mock.calls
        .map(c => String(c[0] ?? ""))
        .filter(l => l.includes("Rerun last"));
      expect(rerunLines.length).toBeGreaterThan(0);
      expect(rerunLines[0]).toContain("claude");
      expect(rerunLines[0]).toContain("sprite");
      expect(rerunLines[0]).toContain("Latest prompt");
    });
  });

  describe("mixed records with and without prompts", () => {
    it("should display prompt preview only for records that have prompts", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([
          { agent: "claude", cloud: "sprite", timestamp: "2026-02-10T10:00:00Z" },
          { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T10:00:00Z", prompt: "Add tests" },
        ])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allLines = consoleMocks.log.mock.calls.map(c => String(c[0] ?? ""));

      // The aider/hetzner record should show prompt
      const aiderLines = allLines.filter(l => l.includes("aider") && l.includes("hetzner"));
      expect(aiderLines.some(l => l.includes("--prompt"))).toBe(true);
      expect(aiderLines.some(l => l.includes("Add tests"))).toBe(true);

      // The claude/sprite record should NOT show --prompt
      const claudeLines = allLines.filter(l =>
        l.includes("claude") && l.includes("sprite") && !l.includes("AGENT") && !l.includes("Rerun")
      );
      for (const line of claudeLines) {
        expect(line).not.toContain("--prompt");
      }
    });

    it("should handle special characters in prompt preview", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: 'Fix the "auth" module & add <tests>',
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
      // Should contain the special characters without breaking
      expect(allOutput).toContain("auth");
      expect(allOutput).toContain("--prompt");
    });

    it("should handle empty string prompt (falsy but present)", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-02-11T10:00:00Z",
          prompt: "",
        }])
      );
      const { cmdList } = await import("../commands.js");
      await cmdList();
      // Should not crash. Empty prompt is falsy so r.prompt is ""
      // which is falsy - the preview check is `if (r.prompt)` so it should skip
      const rerunLines = consoleMocks.log.mock.calls
        .map(c => String(c[0] ?? ""))
        .filter(l => l.includes("Rerun last"));
      expect(rerunLines.length).toBeGreaterThan(0);
      // Empty prompt is falsy, so rerun hint should NOT include --prompt
      expect(rerunLines[0]).not.toContain("--prompt");
    });
  });
});

import { describe, it, expect } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Tests for recently extracted list display helpers (PR #506):
 *
 * showEmptyListMessage (commands.ts:769-797): Displays appropriate message
 * when spawn list returns no results, with filter suggestions.
 *
 * showListFooter (commands.ts:799-817): Shows rerun hint and filter info
 * after the list table.
 *
 * suggestFilterCorrection (commands.ts:750-767): Suggests corrections for
 * mistyped -a/-c filter values using resolve + fuzzy match.
 *
 * showUnknownCommandError (index.ts:89-106): Shows error with fuzzy
 * suggestions when a single-arg command is not recognized.
 *
 * These helpers were extracted from inline code and have zero direct unit
 * tests. Since they are not exported, we test exact replicas (same pattern
 * used in dispatch-extra-args.test.ts and version-comparison.test.ts).
 *
 * Agent: test-engineer
 */

// ── Mock manifest ──────────────────────────────────────────────────────────────

const mockManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "test" },
    },
    aider: {
      name: "Aider",
      description: "AI pair programmer",
      url: "https://aider.chat",
      install: "pip install aider-chat",
      launch: "aider",
      env: { OPENAI_API_KEY: "test" },
    },
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
      url: "https://sprite.sh",
      type: "vm",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/aider": "missing",
  },
};

// ── Replicas of internal functions from commands.ts ─────────────────────────

// Replica of levenshtein (commands.ts:77-91)
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Replica of findClosestKeyByNameOrKey (commands.ts:111-133)
function findClosestKeyByNameOrKey(
  input: string,
  keys: string[],
  getName: (key: string) => string
): string | null {
  let bestKey: string | null = null;
  let bestDist = Infinity;
  const lower = input.toLowerCase();
  for (const key of keys) {
    const keyDist = levenshtein(lower, key.toLowerCase());
    if (keyDist < bestDist) {
      bestDist = keyDist;
      bestKey = key;
    }
    const nameDist = levenshtein(lower, getName(key).toLowerCase());
    if (nameDist < bestDist) {
      bestDist = nameDist;
      bestKey = key;
    }
  }
  return bestDist <= 3 ? bestKey : null;
}

// Replica of resolveEntityKey (commands.ts:140-152)
function resolveEntityKey(
  manifest: Manifest,
  input: string,
  kind: "agent" | "cloud"
): string | null {
  const collection = kind === "agent" ? manifest.agents : manifest.clouds;
  if (collection[input]) return input;
  const keys = Object.keys(collection);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of keys) {
    if (collection[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

function resolveAgentKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "agent");
}

function resolveCloudKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "cloud");
}

// ── Replica of suggestFilterCorrection (commands.ts:750-767) ────────────────

interface SuggestionResult {
  suggested: boolean;
  suggestion?: string;
}

function suggestFilterCorrection(
  filter: string,
  flag: string,
  keys: string[],
  resolveKey: (m: Manifest, input: string) => string | null,
  getDisplayName: (k: string) => string,
  manifest: Manifest,
): SuggestionResult {
  const resolved = resolveKey(manifest, filter);
  if (resolved && resolved !== filter) {
    return { suggested: true, suggestion: `spawn list ${flag} ${resolved}` };
  } else if (!resolved) {
    const match = findClosestKeyByNameOrKey(filter, keys, getDisplayName);
    if (match) {
      return { suggested: true, suggestion: `spawn list ${flag} ${match}` };
    }
  }
  return { suggested: false };
}

// ── Replica of showListFooter logic (commands.ts) ──────────────────────────
// Now delegates to buildRetryCommand for the rerun hint to avoid truncated prompts.

interface SpawnRecord {
  agent: string;
  cloud: string;
  timestamp: string;
  prompt?: string;
}

interface FooterOutput {
  rerunHint: string;
  filterInfo: string;
  countInfo: string;
}

// Replica of buildRetryCommand (commands.ts)
function buildRetryCommand(agent: string, cloud: string, prompt?: string): string {
  if (!prompt) return `spawn ${agent} ${cloud}`;
  if (prompt.length <= 80) {
    const safe = prompt.replace(/"/g, '\\"');
    return `spawn ${agent} ${cloud} --prompt "${safe}"`;
  }
  return `spawn ${agent} ${cloud} --prompt-file <your-prompt-file>`;
}

function buildFooter(
  records: SpawnRecord[],
  totalRecords: number,
  agentFilter?: string,
  cloudFilter?: string,
): FooterOutput {
  const latest = records[0];
  const rerunHint = buildRetryCommand(latest.agent, latest.cloud, latest.prompt);

  let filterInfo: string;
  let countInfo: string;
  if (agentFilter || cloudFilter) {
    countInfo = `Showing ${records.length} of ${totalRecords} spawn${totalRecords !== 1 ? "s" : ""}`;
    filterInfo = "Clear filter: spawn list";
  } else {
    countInfo = `${records.length} spawn${records.length !== 1 ? "s" : ""} recorded`;
    filterInfo = "Filter: spawn list -a <agent>  or  spawn list -c <cloud>";
  }

  return { rerunHint, filterInfo, countInfo };
}

// ── Replica of showEmptyListMessage logic (commands.ts:769-797) ─────────────

interface EmptyListOutput {
  mainMessage: string;
  filterParts: string[];
  hasTotalHint: boolean;
  totalHint?: string;
}

function buildEmptyListMessage(
  totalRecords: number,
  agentFilter?: string,
  cloudFilter?: string,
): EmptyListOutput {
  if (!agentFilter && !cloudFilter) {
    return {
      mainMessage: "No spawns recorded yet.",
      filterParts: [],
      hasTotalHint: false,
    };
  }

  const parts: string[] = [];
  if (agentFilter) parts.push(`agent=${agentFilter}`);
  if (cloudFilter) parts.push(`cloud=${cloudFilter}`);
  const mainMessage = `No spawns found matching ${parts.join(", ")}.`;

  const hasTotalHint = totalRecords > 0;
  const totalHint = hasTotalHint
    ? `Run spawn list to see all ${totalRecords} recorded spawn${totalRecords !== 1 ? "s" : ""}.`
    : undefined;

  return { mainMessage, filterParts: parts, hasTotalHint, totalHint };
}

// ── Replica of showUnknownCommandError logic (index.ts:89-106) ─────────────

interface UnknownCommandOutput {
  errorMessage: string;
  hasSuggestion: boolean;
  suggestion?: string;
}

function buildUnknownCommandError(
  name: string,
  manifest: { agents: Record<string, { name: string }>; clouds: Record<string, { name: string }> },
): UnknownCommandOutput {
  const agentKeys = Object.keys(manifest.agents);
  const cloudKeys = Object.keys(manifest.clouds);
  const agentMatch = findClosestKeyByNameOrKey(name, agentKeys, (k) => manifest.agents[k].name);
  const cloudMatch = findClosestKeyByNameOrKey(name, cloudKeys, (k) => manifest.clouds[k].name);

  const suggestions: string[] = [];
  if (agentMatch) suggestions.push(`${agentMatch} (agent: ${manifest.agents[agentMatch].name})`);
  if (cloudMatch) suggestions.push(`${cloudMatch} (cloud: ${manifest.clouds[cloudMatch].name})`);

  return {
    errorMessage: `Unknown agent or cloud: ${name}`,
    hasSuggestion: suggestions.length > 0,
    suggestion: suggestions.length > 0 ? `Did you mean ${suggestions.join(" or ")}?` : undefined,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("suggestFilterCorrection", () => {
  const agentKeys = Object.keys(mockManifest.agents);
  const cloudKeys = Object.keys(mockManifest.clouds);

  describe("agent filter corrections", () => {
    it("should suggest resolved key when display name is used", () => {
      const result = suggestFilterCorrection(
        "Claude Code", "-a", agentKeys,
        resolveAgentKey, (k) => mockManifest.agents[k].name, mockManifest,
      );
      expect(result.suggested).toBe(true);
      expect(result.suggestion).toContain("claude");
      expect(result.suggestion).toContain("-a");
    });

    it("should suggest resolved key for case-insensitive match", () => {
      const result = suggestFilterCorrection(
        "CLAUDE", "-a", agentKeys,
        resolveAgentKey, (k) => mockManifest.agents[k].name, mockManifest,
      );
      expect(result.suggested).toBe(true);
      expect(result.suggestion).toContain("claude");
    });

    it("should suggest fuzzy match for typos", () => {
      const result = suggestFilterCorrection(
        "claud", "-a", agentKeys,
        resolveAgentKey, (k) => mockManifest.agents[k].name, mockManifest,
      );
      expect(result.suggested).toBe(true);
      expect(result.suggestion).toContain("claude");
    });

    it("should not suggest when exact match is provided", () => {
      const result = suggestFilterCorrection(
        "claude", "-a", agentKeys,
        resolveAgentKey, (k) => mockManifest.agents[k].name, mockManifest,
      );
      // Exact match: resolved === filter, so no suggestion
      expect(result.suggested).toBe(false);
    });

    it("should not suggest when input is completely different", () => {
      const result = suggestFilterCorrection(
        "kubernetes", "-a", agentKeys,
        resolveAgentKey, (k) => mockManifest.agents[k].name, mockManifest,
      );
      expect(result.suggested).toBe(false);
    });
  });

  describe("cloud filter corrections", () => {
    it("should suggest resolved key when display name is used", () => {
      const result = suggestFilterCorrection(
        "Sprite", "-c", cloudKeys,
        resolveCloudKey, (k) => mockManifest.clouds[k].name, mockManifest,
      );
      expect(result.suggested).toBe(true);
      expect(result.suggestion).toContain("sprite");
      expect(result.suggestion).toContain("-c");
    });

    it("should suggest fuzzy match for cloud typos", () => {
      const result = suggestFilterCorrection(
        "sprte", "-c", cloudKeys,
        resolveCloudKey, (k) => mockManifest.clouds[k].name, mockManifest,
      );
      expect(result.suggested).toBe(true);
      expect(result.suggestion).toContain("sprite");
    });

    it("should include the correct flag in suggestion", () => {
      const result = suggestFilterCorrection(
        "Hetzner Cloud", "-c", cloudKeys,
        resolveCloudKey, (k) => mockManifest.clouds[k].name, mockManifest,
      );
      expect(result.suggested).toBe(true);
      expect(result.suggestion).toContain("spawn list -c hetzner");
    });
  });
});

describe("showEmptyListMessage logic", () => {
  describe("no filters applied", () => {
    it("should show 'no spawns recorded yet' message", () => {
      const result = buildEmptyListMessage(0);
      expect(result.mainMessage).toBe("No spawns recorded yet.");
      expect(result.filterParts).toHaveLength(0);
      expect(result.hasTotalHint).toBe(false);
    });

    it("should not show total hint even if records exist", () => {
      // When no filters, showEmptyListMessage returns early before checking totalRecords
      const result = buildEmptyListMessage(5);
      expect(result.mainMessage).toBe("No spawns recorded yet.");
      expect(result.hasTotalHint).toBe(false);
    });
  });

  describe("agent filter applied", () => {
    it("should show 'no spawns found matching agent=X'", () => {
      const result = buildEmptyListMessage(0, "unknown-agent");
      expect(result.mainMessage).toContain("No spawns found matching");
      expect(result.mainMessage).toContain("agent=unknown-agent");
    });

    it("should not include cloud in message when only agent filter", () => {
      const result = buildEmptyListMessage(0, "claude");
      expect(result.mainMessage).not.toContain("cloud=");
    });

    it("should show total hint when other records exist", () => {
      const result = buildEmptyListMessage(10, "nonexistent");
      expect(result.hasTotalHint).toBe(true);
      expect(result.totalHint).toContain("spawn list");
      expect(result.totalHint).toContain("10");
    });

    it("should not show total hint when no records exist at all", () => {
      const result = buildEmptyListMessage(0, "nonexistent");
      expect(result.hasTotalHint).toBe(false);
    });
  });

  describe("cloud filter applied", () => {
    it("should show 'no spawns found matching cloud=X'", () => {
      const result = buildEmptyListMessage(0, undefined, "unknown-cloud");
      expect(result.mainMessage).toContain("No spawns found matching");
      expect(result.mainMessage).toContain("cloud=unknown-cloud");
    });

    it("should not include agent in message when only cloud filter", () => {
      const result = buildEmptyListMessage(0, undefined, "sprite");
      expect(result.mainMessage).not.toContain("agent=");
    });
  });

  describe("both filters applied", () => {
    it("should show both agent and cloud in message", () => {
      const result = buildEmptyListMessage(0, "claude", "sprite");
      expect(result.mainMessage).toContain("agent=claude");
      expect(result.mainMessage).toContain("cloud=sprite");
    });

    it("should join filter parts with comma and space", () => {
      const result = buildEmptyListMessage(0, "claude", "sprite");
      expect(result.mainMessage).toContain("agent=claude, cloud=sprite");
    });

    it("should show total hint when records exist", () => {
      const result = buildEmptyListMessage(5, "claude", "sprite");
      expect(result.hasTotalHint).toBe(true);
      expect(result.totalHint).toContain("5 recorded spawns");
    });
  });

  describe("pluralization", () => {
    it("should use singular 'spawn' for 1 total record", () => {
      const result = buildEmptyListMessage(1, "nonexistent");
      expect(result.totalHint).toContain("1 recorded spawn.");
      expect(result.totalHint).not.toContain("spawns");
    });

    it("should use plural 'spawns' for multiple records", () => {
      const result = buildEmptyListMessage(3, "nonexistent");
      expect(result.totalHint).toContain("3 recorded spawns.");
    });
  });
});

describe("showListFooter logic", () => {
  describe("rerun hint without prompt", () => {
    it("should show rerun command for latest record", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.rerunHint).toBe("spawn claude sprite");
    });

    it("should use the first record (newest) for rerun hint", () => {
      const records: SpawnRecord[] = [
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T12:00:00Z" },
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 2);
      expect(footer.rerunHint).toBe("spawn aider hetzner");
    });
  });

  describe("rerun hint with prompt", () => {
    it("should include prompt in rerun hint for short prompts", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z", prompt: "Fix the bug" },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.rerunHint).toContain("--prompt");
      expect(footer.rerunHint).toContain("Fix the bug");
    });

    it("should suggest --prompt-file for long prompts instead of truncating", () => {
      const longPrompt = "This is a very long prompt that exceeds eighty characters by a lot and keeps going on and on";
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z", prompt: longPrompt },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.rerunHint).toContain("--prompt-file");
      // Should NOT contain truncated prompt text with "..."
      expect(footer.rerunHint).not.toContain("...");
      // Should NOT contain the prompt content
      expect(footer.rerunHint).not.toContain("This is a very long");
    });

    it("should include full prompt up to 80 characters", () => {
      const prompt80 = "B".repeat(80);
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z", prompt: prompt80 },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.rerunHint).toContain(prompt80);
      expect(footer.rerunHint).not.toContain("prompt-file");
    });

    it("should suggest --prompt-file for prompts over 80 characters", () => {
      const prompt81 = "C".repeat(81);
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z", prompt: prompt81 },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.rerunHint).toContain("--prompt-file");
      expect(footer.rerunHint).not.toContain("C".repeat(81));
    });

    it("should escape double quotes in prompt", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z", prompt: 'Fix "all" bugs' },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.rerunHint).toBe('spawn claude sprite --prompt "Fix \\"all\\" bugs"');
    });
  });

  describe("filter info when no filters applied", () => {
    it("should show count of recorded spawns", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "sprite", timestamp: "2026-02-11T09:00:00Z" },
      ];
      const footer = buildFooter(records, 2);
      expect(footer.countInfo).toBe("2 spawns recorded");
    });

    it("should use singular for 1 spawn", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.countInfo).toBe("1 spawn recorded");
    });

    it("should show filter instructions", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 1);
      expect(footer.filterInfo).toContain("spawn list -a <agent>");
      expect(footer.filterInfo).toContain("spawn list -c <cloud>");
    });
  });

  describe("filter info when filters applied", () => {
    it("should show showing X of Y spawns with agent filter", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 5, "claude");
      expect(footer.countInfo).toBe("Showing 1 of 5 spawns");
    });

    it("should show showing X of Y spawns with cloud filter", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "sprite", timestamp: "2026-02-11T09:00:00Z" },
      ];
      const footer = buildFooter(records, 10, undefined, "sprite");
      expect(footer.countInfo).toBe("Showing 2 of 10 spawns");
    });

    it("should show clear filter hint", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 5, "claude");
      expect(footer.filterInfo).toContain("Clear filter: spawn list");
    });

    it("should use singular when total is 1", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 1, "claude");
      expect(footer.countInfo).toBe("Showing 1 of 1 spawn");
    });

    it("should show filtered view with both filters", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ];
      const footer = buildFooter(records, 8, "claude", "sprite");
      expect(footer.countInfo).toBe("Showing 1 of 8 spawns");
      expect(footer.filterInfo).toContain("Clear filter");
    });
  });
});

describe("showUnknownCommandError logic", () => {
  describe("with close agent match", () => {
    it("should suggest the closest agent for a typo", () => {
      const result = buildUnknownCommandError("claud", mockManifest);
      expect(result.errorMessage).toContain("claud");
      expect(result.hasSuggestion).toBe(true);
      expect(result.suggestion).toContain("claude");
      expect(result.suggestion).toContain("agent:");
    });

    it("should include agent display name in suggestion", () => {
      const result = buildUnknownCommandError("aidr", mockManifest);
      expect(result.hasSuggestion).toBe(true);
      expect(result.suggestion).toContain("Aider");
    });
  });

  describe("with close cloud match", () => {
    it("should suggest the closest cloud for a typo", () => {
      const result = buildUnknownCommandError("sprte", mockManifest);
      expect(result.hasSuggestion).toBe(true);
      expect(result.suggestion).toContain("sprite");
      expect(result.suggestion).toContain("cloud:");
    });

    it("should include cloud display name in suggestion", () => {
      const result = buildUnknownCommandError("hetzne", mockManifest);
      expect(result.hasSuggestion).toBe(true);
      expect(result.suggestion).toContain("Hetzner");
    });
  });

  describe("with both agent and cloud matches", () => {
    // Create a manifest where the input is close to both an agent and a cloud
    const overlappingManifest = {
      agents: {
        test: { name: "Test Agent", description: "test", url: "", install: "", launch: "", env: {} },
      },
      clouds: {
        tset: { name: "Tset Cloud", description: "test", url: "", type: "vm", auth: "none", provision_method: "api", exec_method: "ssh", interactive_method: "ssh" },
      },
      matrix: {},
    };

    it("should suggest both agent and cloud when close to both", () => {
      const result = buildUnknownCommandError("tes", overlappingManifest);
      expect(result.hasSuggestion).toBe(true);
      // Should include "or" joining agent and cloud suggestions
      expect(result.suggestion).toContain(" or ");
    });
  });

  describe("with no close matches", () => {
    it("should not suggest anything for completely unrelated input", () => {
      const result = buildUnknownCommandError("xyzzyplugh", mockManifest);
      expect(result.errorMessage).toContain("xyzzyplugh");
      expect(result.hasSuggestion).toBe(false);
      expect(result.suggestion).toBeUndefined();
    });

    it("should not suggest for very long unrelated input", () => {
      const result = buildUnknownCommandError("this-is-nothing-like-any-key", mockManifest);
      expect(result.hasSuggestion).toBe(false);
    });
  });

  describe("error message format", () => {
    it("should always include Unknown agent or cloud prefix", () => {
      const result = buildUnknownCommandError("foo", mockManifest);
      expect(result.errorMessage).toStartWith("Unknown agent or cloud:");
    });

    it("should include the actual input in error message", () => {
      const result = buildUnknownCommandError("my-thing", mockManifest);
      expect(result.errorMessage).toContain("my-thing");
    });

    it("should format suggestion with Did you mean prefix", () => {
      const result = buildUnknownCommandError("claud", mockManifest);
      expect(result.suggestion).toStartWith("Did you mean ");
      expect(result.suggestion).toEndWith("?");
    });
  });
});

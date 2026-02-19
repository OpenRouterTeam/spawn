import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import type { SpawnRecord } from "../history";
import type { Manifest } from "../manifest";

/**
 * Tests for internal functions in commands.ts and index.ts that previously
 * had zero test coverage:
 *
 * From index.ts:
 *   - formatCacheAge: converts cache age (seconds) to human-readable string
 *
 * From commands.ts:
 *   - handleUserInterrupt: detects Ctrl+C interruption message and exits 130
 *   - runWithRetries: retry logic for SSH failures (exit 255)
 *   - printInfoHeader: display header for agent/cloud info pages
 *   - printGroupedList: grouped display with type labels and command hints
 *   - renderListTable: table display for spawn history
 *
 * These functions are not exported, so we test exact replicas following
 * the codebase pattern (see version-comparison.test.ts, dispatch-extra-args.test.ts).
 *
 * Agent: test-engineer
 */

// ── Exact replicas of internal functions ─────────────────────────────────────

// From index.ts lines 268-274
function formatCacheAge(seconds: number): string {
  if (!isFinite(seconds)) return "no cache";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// From commands.ts lines 757-764 (simplified: we track calls instead of calling process.exit)
function handleUserInterrupt(errMsg: string): { shouldExit: boolean } {
  if (!errMsg.includes("interrupted by user")) return { shouldExit: false };
  return { shouldExit: true };
}

// From commands.ts lines 749-755
function isRetryableExitCode(errMsg: string): boolean {
  const exitCodeMatch = errMsg.match(/exited with code (\d+)/);
  if (!exitCodeMatch) return false;
  const code = parseInt(exitCodeMatch[1], 10);
  return code === 255;
}

// From commands.ts lines 746-747
const MAX_RETRIES = 2;
const RETRY_DELAYS = [5, 10];

// Simplified runWithRetries that takes a mock runner function
async function runWithRetries(
  runner: () => Promise<void>,
  getErrorMessage: (err: unknown) => string
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      await runner();
      return undefined; // success
    } catch (err) {
      const errMsg = getErrorMessage(err);
      const interrupt = handleUserInterrupt(errMsg);
      if (interrupt.shouldExit) return "interrupted";

      if (attempt <= MAX_RETRIES && isRetryableExitCode(errMsg)) {
        // In tests we don't actually delay
        continue;
      }

      return errMsg;
    }
  }
  return "Script failed after all retries";
}

// From commands.ts lines 1301-1306
function printInfoHeader(entry: {
  name: string;
  description: string;
  url?: string;
  notes?: string;
}): string[] {
  const lines: string[] = [];
  lines.push(`${entry.name} -- ${entry.description}`);
  if (entry.url) lines.push(`  ${entry.url}`);
  if (entry.notes) lines.push(`  ${entry.notes}`);
  return lines;
}

// From commands.ts lines 1309-1317
function groupByType(
  keys: string[],
  getType: (key: string) => string
): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const key of keys) {
    const type = getType(key);
    if (!byType[type]) byType[type] = [];
    byType[type].push(key);
  }
  return byType;
}

const NAME_COLUMN_WIDTH = 18;

// From commands.ts lines 1320-1332
function printGroupedList(
  byType: Record<string, string[]>,
  getName: (key: string) => string,
  getHint: (key: string) => string,
  indent: string = "  "
): string[] {
  const lines: string[] = [];
  for (const [type, keys] of Object.entries(byType)) {
    lines.push(`${indent}${type}`);
    for (const key of keys) {
      lines.push(
        `${indent}  ${key.padEnd(NAME_COLUMN_WIDTH)} ${getName(key).padEnd(NAME_COLUMN_WIDTH)} ${getHint(key)}`
      );
    }
  }
  return lines;
}

// From commands.ts lines 984-1005
function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return "just now";
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays === 1) return "yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    const date = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return date;
  } catch {
    return iso;
  }
}

// From commands.ts lines 1084-1088
function resolveDisplayName(
  manifest: Manifest | null,
  key: string,
  kind: "agent" | "cloud"
): string {
  if (!manifest) return key;
  const entry =
    kind === "agent" ? manifest.agents[key] : manifest.clouds[key];
  return entry ? entry.name : key;
}

// From commands.ts lines 1090-1110
function renderListTable(
  records: SpawnRecord[],
  manifest: Manifest | null
): string[] {
  const lines: string[] = [];
  lines.push(""); // blank line
  lines.push("AGENT".padEnd(20) + "CLOUD".padEnd(20) + "WHEN");
  lines.push("-".repeat(60));

  for (const r of records) {
    const relative = formatRelativeTime(r.timestamp);
    const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
    const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
    let line = agentDisplay.padEnd(20) + cloudDisplay.padEnd(20) + relative;
    if (r.prompt) {
      const preview =
        r.prompt.length > 40 ? r.prompt.slice(0, 40) + "..." : r.prompt;
      line += `  --prompt "${preview}"`;
    }
    lines.push(line);
  }
  lines.push(""); // blank line
  return lines;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("formatCacheAge", () => {
  it("should return 'no cache' for Infinity", () => {
    expect(formatCacheAge(Infinity)).toBe("no cache");
  });

  it("should return 'no cache' for -Infinity", () => {
    expect(formatCacheAge(-Infinity)).toBe("no cache");
  });

  it("should return 'no cache' for NaN", () => {
    expect(formatCacheAge(NaN)).toBe("no cache");
  });

  it("should return 'just now' for 0 seconds", () => {
    expect(formatCacheAge(0)).toBe("just now");
  });

  it("should return 'just now' for 59 seconds", () => {
    expect(formatCacheAge(59)).toBe("just now");
  });

  it("should return '1m ago' for 60 seconds", () => {
    expect(formatCacheAge(60)).toBe("1m ago");
  });

  it("should return '59m ago' for 3599 seconds", () => {
    expect(formatCacheAge(3599)).toBe("59m ago");
  });

  it("should return '1h ago' for 3600 seconds", () => {
    expect(formatCacheAge(3600)).toBe("1h ago");
  });

  it("should return '23h ago' for 86399 seconds", () => {
    expect(formatCacheAge(86399)).toBe("23h ago");
  });

  it("should return '1d ago' for 86400 seconds", () => {
    expect(formatCacheAge(86400)).toBe("1d ago");
  });

  it("should return '7d ago' for one week", () => {
    expect(formatCacheAge(7 * 86400)).toBe("7d ago");
  });

  it("should return '30d ago' for 30 days", () => {
    expect(formatCacheAge(30 * 86400)).toBe("30d ago");
  });

  it("should handle fractional seconds by flooring", () => {
    expect(formatCacheAge(90.9)).toBe("1m ago");
  });

  it("should handle negative values as 'just now'", () => {
    // Negative seconds means "in the future" which falls through < 60 check
    expect(formatCacheAge(-10)).toBe("just now");
  });

  it("should handle very large values", () => {
    expect(formatCacheAge(365 * 86400)).toBe("365d ago");
  });
});

// ── handleUserInterrupt ──────────────────────────────────────────────────────

describe("handleUserInterrupt", () => {
  it("should detect Ctrl+C interruption message", () => {
    const result = handleUserInterrupt(
      "Script interrupted by user (Ctrl+C)"
    );
    expect(result.shouldExit).toBe(true);
  });

  it("should not trigger for normal error messages", () => {
    const result = handleUserInterrupt("Script exited with code 1");
    expect(result.shouldExit).toBe(false);
  });

  it("should not trigger for SSH failure messages", () => {
    const result = handleUserInterrupt("Script exited with code 255");
    expect(result.shouldExit).toBe(false);
  });

  it("should not trigger for empty string", () => {
    const result = handleUserInterrupt("");
    expect(result.shouldExit).toBe(false);
  });

  it("should detect interrupt anywhere in message", () => {
    const result = handleUserInterrupt(
      "Error: process was interrupted by user during setup"
    );
    expect(result.shouldExit).toBe(true);
  });

  it("should not trigger for partial match without 'by user'", () => {
    const result = handleUserInterrupt("Script was interrupted");
    expect(result.shouldExit).toBe(false);
  });
});

// ── runWithRetries ───────────────────────────────────────────────────────────

describe("runWithRetries", () => {
  const getErrorMessage = (err: unknown): string => {
    return err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  };

  it("should return undefined on first-attempt success", async () => {
    const runner = async () => {};
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBeUndefined();
  });

  it("should retry on SSH failure (exit 255) and succeed on second attempt", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      if (attempt === 1) throw new Error("Script exited with code 255");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBeUndefined();
    expect(attempt).toBe(2);
  });

  it("should retry up to MAX_RETRIES times on persistent SSH failure", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      throw new Error("Script exited with code 255");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    // MAX_RETRIES=2, so total attempts = 3 (1 initial + 2 retries)
    expect(attempt).toBe(3);
    expect(result).toBe("Script exited with code 255");
  });

  it("should not retry on exit code 1 (general failure)", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      throw new Error("Script exited with code 1");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(attempt).toBe(1);
    expect(result).toBe("Script exited with code 1");
  });

  it("should not retry on exit code 130 (Ctrl+C)", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      throw new Error("Script interrupted by user (Ctrl+C)");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(attempt).toBe(1);
    expect(result).toBe("interrupted");
  });

  it("should not retry on exit code 127 (command not found)", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      throw new Error("Script exited with code 127");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(attempt).toBe(1);
    expect(result).toBe("Script exited with code 127");
  });

  it("should succeed after transient SSH failures", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      if (attempt <= 2) throw new Error("Script exited with code 255");
      // Third attempt succeeds
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBeUndefined();
    expect(attempt).toBe(3);
  });

  it("should return error string for non-retryable failures", async () => {
    const runner = async () => {
      throw new Error("Script exited with code 137");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBe("Script exited with code 137");
  });

  it("should handle errors without exit code pattern", async () => {
    const runner = async () => {
      throw new Error("Unknown error occurred");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBe("Unknown error occurred");
  });
});

// ── printInfoHeader ──────────────────────────────────────────────────────────

describe("printInfoHeader", () => {
  it("should include name and description", () => {
    const lines = printInfoHeader({
      name: "Claude Code",
      description: "AI coding assistant",
    });
    expect(lines[0]).toContain("Claude Code");
    expect(lines[0]).toContain("AI coding assistant");
    expect(lines[0]).toContain("--");
  });

  it("should include URL when provided", () => {
    const lines = printInfoHeader({
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
    });
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("https://claude.ai");
  });

  it("should include notes when provided", () => {
    const lines = printInfoHeader({
      name: "Claude Code",
      description: "AI coding assistant",
      notes: "Requires Node.js 18+",
    });
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("Requires Node.js 18+");
  });

  it("should include both URL and notes when provided", () => {
    const lines = printInfoHeader({
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      notes: "Requires Node.js 18+",
    });
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain("https://claude.ai");
    expect(lines[2]).toContain("Requires Node.js 18+");
  });

  it("should not include URL line when url is undefined", () => {
    const lines = printInfoHeader({
      name: "Test Agent",
      description: "A test",
    });
    expect(lines.length).toBe(1);
  });

  it("should not include notes line when notes is undefined", () => {
    const lines = printInfoHeader({
      name: "Test Agent",
      description: "A test",
      url: "https://example.com",
    });
    expect(lines.length).toBe(2);
    expect(lines.every((l) => !l.includes("undefined"))).toBe(true);
  });

  it("should handle empty string name gracefully", () => {
    const lines = printInfoHeader({
      name: "",
      description: "No name agent",
    });
    expect(lines[0]).toContain("No name agent");
  });

  it("should handle empty string description gracefully", () => {
    const lines = printInfoHeader({
      name: "Agent",
      description: "",
    });
    expect(lines[0]).toContain("Agent");
  });
});

// ── printGroupedList ─────────────────────────────────────────────────────────

describe("printGroupedList", () => {
  it("should render single-type group with proper indentation", () => {
    const byType = { vm: ["sprite", "hetzner"] };
    const lines = printGroupedList(
      byType,
      (k) => (k === "sprite" ? "Sprite" : "Hetzner Cloud"),
      (k) => `spawn claude ${k}`
    );
    expect(lines.length).toBe(3); // 1 type header + 2 entries
    expect(lines[0]).toContain("vm");
    expect(lines[1]).toContain("sprite");
    expect(lines[1]).toContain("Sprite");
    expect(lines[1]).toContain("spawn claude sprite");
    expect(lines[2]).toContain("hetzner");
  });

  it("should render multiple-type groups", () => {
    const byType = {
      vm: ["sprite"],
      cloud: ["hetzner"],
      sandbox: ["codesandbox"],
    };
    const lines = printGroupedList(
      byType,
      (k) => k,
      (k) => `hint for ${k}`
    );
    expect(lines.length).toBe(6); // 3 type headers + 3 entries
  });

  it("should use custom indent", () => {
    const byType = { vm: ["sprite"] };
    const lines = printGroupedList(
      byType,
      (k) => k,
      (k) => k,
      "    "
    );
    expect(lines[0]).toStartWith("    ");
    expect(lines[1]).toStartWith("      "); // indent + 2 spaces
  });

  it("should use default indent of 2 spaces", () => {
    const byType = { vm: ["sprite"] };
    const lines = printGroupedList(
      byType,
      (k) => k,
      (k) => k
    );
    expect(lines[0]).toStartWith("  ");
    expect(lines[1]).toStartWith("    "); // 2 + 2 spaces
  });

  it("should pad key to NAME_COLUMN_WIDTH", () => {
    const byType = { vm: ["x"] };
    const lines = printGroupedList(
      byType,
      () => "Name",
      () => "hint"
    );
    // "x" padded to 18 chars
    expect(lines[1]).toContain("x" + " ".repeat(17));
  });

  it("should handle empty group", () => {
    const byType: Record<string, string[]> = {};
    const lines = printGroupedList(
      byType,
      (k) => k,
      (k) => k
    );
    expect(lines.length).toBe(0);
  });

  it("should handle type with many keys", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `cloud-${i}`);
    const byType = { vm: keys };
    const lines = printGroupedList(
      byType,
      (k) => k,
      (k) => k
    );
    expect(lines.length).toBe(11); // 1 header + 10 entries
  });
});

// ── renderListTable ──────────────────────────────────────────────────────────

describe("renderListTable", () => {
  const manifest = createMockManifest();

  it("should render a table header with AGENT, CLOUD, WHEN columns", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    const headerLine = lines.find(
      (l) =>
        l.includes("AGENT") && l.includes("CLOUD") && l.includes("WHEN")
    );
    expect(headerLine).toBeDefined();
  });

  it("should render a separator line of dashes", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    const sepLine = lines.find((l) => /^-{50,}$/.test(l.trim()));
    expect(sepLine).toBeDefined();
  });

  it("should resolve agent display names from manifest", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    const dataLine = lines.find((l) => l.includes("Claude Code"));
    expect(dataLine).toBeDefined();
  });

  it("should resolve cloud display names from manifest", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    const dataLine = lines.find((l) => l.includes("Sprite"));
    expect(dataLine).toBeDefined();
  });

  it("should fall back to raw keys when manifest is null", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, null);
    // Should contain raw keys, not display names
    const dataLine = lines.find((l) => l.includes("claude"));
    expect(dataLine).toBeDefined();
    expect(lines.some((l) => l.includes("Claude Code"))).toBe(false);
  });

  it("should show prompt preview for records with prompts", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        prompt: "Fix all bugs",
      },
    ];
    const lines = renderListTable(records, manifest);
    const promptLine = lines.find((l) => l.includes("--prompt"));
    expect(promptLine).toBeDefined();
    expect(promptLine).toContain("Fix all bugs");
  });

  it("should truncate long prompts at 40 characters", () => {
    const longPrompt = "A".repeat(50);
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        prompt: longPrompt,
      },
    ];
    const lines = renderListTable(records, manifest);
    const promptLine = lines.find((l) => l.includes("--prompt"));
    expect(promptLine).toBeDefined();
    expect(promptLine).toContain("...");
    expect(promptLine).toContain("A".repeat(40));
    // Should NOT contain the full 50-char prompt
    expect(promptLine).not.toContain("A".repeat(50));
  });

  it("should not show prompt for records without prompts", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    expect(lines.every((l) => !l.includes("--prompt"))).toBe(true);
  });

  it("should render multiple records", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
      {
        agent: "codex",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    // Header line + separator + 2 data lines + 2 blank lines = 6
    expect(lines.length).toBe(6);
    expect(lines.some((l) => l.includes("Claude Code"))).toBe(true);
    expect(lines.some((l) => l.includes("Codex"))).toBe(true);
  });

  it("should show relative time for recent timestamps", () => {
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    const dataLine = lines.find((l) => l.includes("Claude Code"));
    expect(dataLine).toContain("just now");
  });

  it("should show prompt at exactly 40 characters without truncation", () => {
    const exactPrompt = "B".repeat(40);
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        prompt: exactPrompt,
      },
    ];
    const lines = renderListTable(records, manifest);
    const promptLine = lines.find((l) => l.includes("--prompt"));
    expect(promptLine).toContain("B".repeat(40));
    expect(promptLine).not.toContain("...");
  });

  it("should truncate prompt at 41 characters", () => {
    const longPrompt = "C".repeat(41);
    const records: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        prompt: longPrompt,
      },
    ];
    const lines = renderListTable(records, manifest);
    const promptLine = lines.find((l) => l.includes("--prompt"));
    expect(promptLine).toContain("...");
  });

  it("should handle unknown agent/cloud keys with null manifest", () => {
    const records: SpawnRecord[] = [
      {
        agent: "unknown-agent",
        cloud: "unknown-cloud",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, null);
    expect(lines.some((l) => l.includes("unknown-agent"))).toBe(true);
    expect(lines.some((l) => l.includes("unknown-cloud"))).toBe(true);
  });

  it("should handle unknown keys with a manifest that lacks the entries", () => {
    const records: SpawnRecord[] = [
      {
        agent: "nonexistent",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderListTable(records, manifest);
    // resolveDisplayName falls back to key when not in manifest
    expect(lines.some((l) => l.includes("nonexistent"))).toBe(true);
    expect(lines.some((l) => l.includes("Sprite"))).toBe(true);
  });
});

// ── formatCacheAge boundary transitions ──────────────────────────────────────

describe("formatCacheAge boundary transitions", () => {
  it("should transition from 'just now' to minutes at exactly 60s", () => {
    expect(formatCacheAge(59)).toBe("just now");
    expect(formatCacheAge(60)).toBe("1m ago");
  });

  it("should transition from minutes to hours at exactly 3600s", () => {
    expect(formatCacheAge(3599)).toBe("59m ago");
    expect(formatCacheAge(3600)).toBe("1h ago");
  });

  it("should transition from hours to days at exactly 86400s", () => {
    expect(formatCacheAge(86399)).toBe("23h ago");
    expect(formatCacheAge(86400)).toBe("1d ago");
  });

  it("should always floor, never round up", () => {
    // 119 seconds = 1.98 minutes, should floor to 1
    expect(formatCacheAge(119)).toBe("1m ago");
    // 7199 seconds = 1.999 hours, should floor to 1
    expect(formatCacheAge(7199)).toBe("1h ago");
    // 172799 seconds = 1.999 days, should floor to 1
    expect(formatCacheAge(172799)).toBe("1d ago");
  });
});

// ── runWithRetries edge cases ────────────────────────────────────────────────

describe("runWithRetries edge cases", () => {
  const getErrorMessage = (err: unknown): string => {
    return err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  };

  it("should handle runner that throws non-Error values", async () => {
    const runner = async () => {
      throw "plain string error";
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBe("plain string error");
  });

  it("should count total attempts correctly", async () => {
    let attempts = 0;
    const runner = async () => {
      attempts++;
      throw new Error("Script exited with code 255");
    };
    await runWithRetries(runner, getErrorMessage);
    // 1 initial + MAX_RETRIES(2) = 3 total
    expect(attempts).toBe(3);
  });

  it("should succeed on the last possible retry", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      // Fail on first 2 attempts, succeed on third (last)
      if (attempt < 3) throw new Error("Script exited with code 255");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBeUndefined();
    expect(attempt).toBe(3);
  });

  it("should detect interrupt on any attempt", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      if (attempt === 1) throw new Error("Script exited with code 255");
      throw new Error("Script interrupted by user (Ctrl+C)");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(result).toBe("interrupted");
    expect(attempt).toBe(2);
  });

  it("should not retry non-255 exit codes even on first attempt", async () => {
    let attempt = 0;
    const runner = async () => {
      attempt++;
      throw new Error("Script exited with code 126");
    };
    const result = await runWithRetries(runner, getErrorMessage);
    expect(attempt).toBe(1);
    expect(result).toBe("Script exited with code 126");
  });
});

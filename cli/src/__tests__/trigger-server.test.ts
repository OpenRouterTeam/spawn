import { describe, it, expect, beforeEach } from "bun:test";
import { timingSafeEqual } from "crypto";

/**
 * Tests for trigger-server logic (.claude/skills/setup-agent-team/trigger-server.ts).
 *
 * The trigger server is critical infrastructure that was recently hardened
 * with security fixes (PRs #745, #747):
 * - Timing-safe Bearer token comparison (prevents timing side-channel attacks)
 * - Reason parameter validation against allowlist (prevents env var injection)
 * - Issue parameter validation (positive integer only, prevents shell injection)
 * - Concurrent run management (capacity limits, dedup by issue number)
 * - Process reaping (dead process cleanup, timeout enforcement)
 *
 * These tests replicate the core logic functions from trigger-server.ts and
 * validate them comprehensively. This pattern matches the existing codebase
 * convention (e.g., commands-untested.test.ts, version-comparison.test.ts)
 * where pure functions are reimplemented to enable isolated testing.
 *
 * Agent: test-engineer
 */

// ── Replicated logic from trigger-server.ts ──────────────────────────────────

/** Exact replica of isAuthed from trigger-server.ts (lines 57-62) */
function isAuthed(
  givenAuth: string,
  expectedSecret: string
): boolean {
  const expected = `Bearer ${expectedSecret}`;
  if (givenAuth.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(givenAuth), Buffer.from(expected));
}

/** Exact replica of VALID_REASONS from trigger-server.ts (lines 65-73) */
const VALID_REASONS = new Set([
  "manual",
  "schedule",
  "issues",
  "team_building",
  "triage",
  "review_all",
  "hygiene",
]);

/** Exact replica of issue validation from trigger-server.ts (line 368) */
function isValidIssue(issue: string): boolean {
  if (!issue) return true; // empty issue is allowed (optional param)
  return /^\d+$/.test(issue);
}

// ── Run management types and logic ───────────────────────────────────────────

interface MockRunEntry {
  pid: number;
  startedAt: number;
  reason: string;
  issue: string;
  alive: boolean; // simulates whether the process is alive
}

/**
 * Replica of reapAndEnforce from trigger-server.ts (lines 86-112).
 * Uses a mock "alive" flag instead of process.kill(pid, 0).
 */
function reapAndEnforce(
  runs: Map<number, MockRunEntry>,
  timeoutMs: number
): { reaped: number[]; killed: number[] } {
  const now = Date.now();
  const reaped: number[] = [];
  const killed: number[] = [];

  for (const [id, run] of runs) {
    const elapsed = now - run.startedAt;

    if (!run.alive) {
      reaped.push(id);
      runs.delete(id);
      continue;
    }

    if (elapsed > timeoutMs) {
      killed.push(id);
      runs.delete(id);
    }
  }

  return { reaped, killed };
}

/**
 * Replica of issue dedup check from trigger-server.ts (lines 376-389).
 */
function hasDuplicateIssue(
  runs: Map<number, MockRunEntry>,
  issue: string
): boolean {
  if (!issue) return false;
  for (const [, run] of runs) {
    if (run.issue === issue) return true;
  }
  return false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ── isAuthed (timing-safe Bearer token comparison) ───────────────────────────

describe("isAuthed - timing-safe Bearer token comparison", () => {
  const SECRET = "test-secret-abc123";

  it("should accept correct Bearer token", () => {
    expect(isAuthed(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("should reject wrong token", () => {
    expect(isAuthed("Bearer wrong-token", SECRET)).toBe(false);
  });

  it("should reject empty Authorization header", () => {
    expect(isAuthed("", SECRET)).toBe(false);
  });

  it("should reject missing Bearer prefix", () => {
    expect(isAuthed(SECRET, SECRET)).toBe(false);
  });

  it("should reject Basic auth scheme", () => {
    expect(isAuthed(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  it("should reject Bearer with extra space", () => {
    expect(isAuthed(`Bearer  ${SECRET}`, SECRET)).toBe(false);
  });

  it("should reject Bearer with trailing space", () => {
    expect(isAuthed(`Bearer ${SECRET} `, SECRET)).toBe(false);
  });

  it("should reject token that is a prefix of the secret", () => {
    expect(isAuthed("Bearer test-secret", SECRET)).toBe(false);
  });

  it("should reject token that extends the secret", () => {
    expect(isAuthed(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
  });

  it("should reject lowercase bearer", () => {
    expect(isAuthed(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it("should reject BEARER (uppercase)", () => {
    expect(isAuthed(`BEARER ${SECRET}`, SECRET)).toBe(false);
  });

  it("should handle empty secret (edge case)", () => {
    // With empty secret, expected = "Bearer ", given = "Bearer " should match
    expect(isAuthed("Bearer ", "")).toBe(true);
  });

  it("should reject null-byte injection in token", () => {
    expect(isAuthed(`Bearer ${SECRET}\0`, SECRET)).toBe(false);
  });

  it("should reject token with newline", () => {
    expect(isAuthed(`Bearer ${SECRET}\n`, SECRET)).toBe(false);
  });

  it("should work with long secrets", () => {
    const longSecret = "a".repeat(256);
    expect(isAuthed(`Bearer ${longSecret}`, longSecret)).toBe(true);
    expect(isAuthed(`Bearer ${"b".repeat(256)}`, longSecret)).toBe(false);
  });

  it("should work with special characters in secret", () => {
    const specialSecret = "abc!@#$%^&*()_+-=[]{}|;':\",./<>?";
    expect(isAuthed(`Bearer ${specialSecret}`, specialSecret)).toBe(true);
  });

  it("should use constant-time comparison (length check first)", () => {
    // The length check is a fast-path optimization; if lengths differ,
    // timingSafeEqual is not called (it throws on length mismatch).
    // This test verifies the length check prevents the throw.
    const result = isAuthed("short", SECRET);
    expect(result).toBe(false);
  });
});

// ── VALID_REASONS allowlist ──────────────────────────────────────────────────

describe("VALID_REASONS allowlist", () => {
  it("should contain 'manual'", () => {
    expect(VALID_REASONS.has("manual")).toBe(true);
  });

  it("should contain 'schedule'", () => {
    expect(VALID_REASONS.has("schedule")).toBe(true);
  });

  it("should contain 'issues'", () => {
    expect(VALID_REASONS.has("issues")).toBe(true);
  });

  it("should contain 'team_building'", () => {
    expect(VALID_REASONS.has("team_building")).toBe(true);
  });

  it("should contain 'triage'", () => {
    expect(VALID_REASONS.has("triage")).toBe(true);
  });

  it("should contain 'review_all'", () => {
    expect(VALID_REASONS.has("review_all")).toBe(true);
  });

  it("should contain 'hygiene'", () => {
    expect(VALID_REASONS.has("hygiene")).toBe(true);
  });

  it("should have exactly 7 valid reasons", () => {
    expect(VALID_REASONS.size).toBe(7);
  });

  it("should reject empty string", () => {
    expect(VALID_REASONS.has("")).toBe(false);
  });

  it("should reject arbitrary string", () => {
    expect(VALID_REASONS.has("hack")).toBe(false);
  });

  it("should reject shell injection attempt", () => {
    expect(VALID_REASONS.has("manual; rm -rf /")).toBe(false);
  });

  it("should reject env var injection", () => {
    expect(VALID_REASONS.has("manual\nMALICIOUS_VAR=pwned")).toBe(false);
  });

  it("should be case-sensitive (reject 'Manual')", () => {
    expect(VALID_REASONS.has("Manual")).toBe(false);
  });

  it("should be case-sensitive (reject 'SCHEDULE')", () => {
    expect(VALID_REASONS.has("SCHEDULE")).toBe(false);
  });

  it("should reject reason with leading space", () => {
    expect(VALID_REASONS.has(" manual")).toBe(false);
  });

  it("should reject reason with trailing space", () => {
    expect(VALID_REASONS.has("manual ")).toBe(false);
  });

  it("should reject partial match 'man'", () => {
    expect(VALID_REASONS.has("man")).toBe(false);
  });

  it("should reject 'issue' (singular - must be 'issues')", () => {
    expect(VALID_REASONS.has("issue")).toBe(false);
  });
});

// ── Issue parameter validation ───────────────────────────────────────────────

describe("Issue parameter validation", () => {
  it("should accept single digit '1'", () => {
    expect(isValidIssue("1")).toBe(true);
  });

  it("should accept multi-digit '123'", () => {
    expect(isValidIssue("123")).toBe(true);
  });

  it("should accept large number '99999'", () => {
    expect(isValidIssue("99999")).toBe(true);
  });

  it("should accept '0'", () => {
    // The regex /^\d+$/ matches "0" - it's all digits
    expect(isValidIssue("0")).toBe(true);
  });

  it("should accept empty string (optional param)", () => {
    expect(isValidIssue("")).toBe(true);
  });

  it("should reject negative number", () => {
    expect(isValidIssue("-1")).toBe(false);
  });

  it("should reject alphabetic string", () => {
    expect(isValidIssue("abc")).toBe(false);
  });

  it("should reject mixed alphanumeric", () => {
    expect(isValidIssue("123abc")).toBe(false);
  });

  it("should reject decimal number", () => {
    expect(isValidIssue("1.5")).toBe(false);
  });

  it("should reject number with spaces", () => {
    expect(isValidIssue("12 34")).toBe(false);
  });

  it("should reject leading space", () => {
    expect(isValidIssue(" 123")).toBe(false);
  });

  it("should reject trailing space", () => {
    expect(isValidIssue("123 ")).toBe(false);
  });

  it("should reject shell injection: semicolon command", () => {
    expect(isValidIssue("123; rm -rf /")).toBe(false);
  });

  it("should reject shell injection: pipe", () => {
    expect(isValidIssue("123 | cat /etc/passwd")).toBe(false);
  });

  it("should reject shell injection: backticks", () => {
    expect(isValidIssue("`whoami`")).toBe(false);
  });

  it("should reject shell injection: $() substitution", () => {
    expect(isValidIssue("$(whoami)")).toBe(false);
  });

  it("should reject newline injection", () => {
    expect(isValidIssue("123\n456")).toBe(false);
  });

  it("should reject null byte injection", () => {
    expect(isValidIssue("123\0456")).toBe(false);
  });

  it("should reject special characters: #", () => {
    expect(isValidIssue("#123")).toBe(false);
  });

  it("should reject URL-encoded digits", () => {
    expect(isValidIssue("%31%32%33")).toBe(false);
  });

  it("should accept very large issue number", () => {
    expect(isValidIssue("9999999999")).toBe(true);
  });
});

// ── Issue dedup logic ────────────────────────────────────────────────────────

describe("Issue dedup logic", () => {
  let runs: Map<number, MockRunEntry>;

  beforeEach(() => {
    runs = new Map();
  });

  function addRun(id: number, issue: string, reason = "issues"): void {
    runs.set(id, {
      pid: 1000 + id,
      startedAt: Date.now(),
      reason,
      issue,
      alive: true,
    });
  }

  it("should detect duplicate issue", () => {
    addRun(1, "42");
    expect(hasDuplicateIssue(runs, "42")).toBe(true);
  });

  it("should not detect different issue", () => {
    addRun(1, "42");
    expect(hasDuplicateIssue(runs, "43")).toBe(false);
  });

  it("should not flag empty issue as duplicate", () => {
    addRun(1, "42");
    expect(hasDuplicateIssue(runs, "")).toBe(false);
  });

  it("should not flag empty issue even when run has empty issue", () => {
    addRun(1, "");
    expect(hasDuplicateIssue(runs, "")).toBe(false);
  });

  it("should detect duplicate among multiple runs", () => {
    addRun(1, "10");
    addRun(2, "20");
    addRun(3, "30");
    expect(hasDuplicateIssue(runs, "20")).toBe(true);
  });

  it("should not detect duplicate when no runs exist", () => {
    expect(hasDuplicateIssue(runs, "42")).toBe(false);
  });

  it("should match exact issue string only", () => {
    addRun(1, "42");
    expect(hasDuplicateIssue(runs, "4")).toBe(false);
    expect(hasDuplicateIssue(runs, "420")).toBe(false);
    expect(hasDuplicateIssue(runs, "042")).toBe(false);
  });

  it("should handle multiple runs with same issue", () => {
    // This shouldn't happen in practice (server prevents it), but test the logic
    addRun(1, "42");
    addRun(2, "42");
    expect(hasDuplicateIssue(runs, "42")).toBe(true);
  });
});

// ── Capacity checking ────────────────────────────────────────────────────────

describe("Capacity checking", () => {
  let runs: Map<number, MockRunEntry>;

  beforeEach(() => {
    runs = new Map();
  });

  function addRun(id: number): void {
    runs.set(id, {
      pid: 1000 + id,
      startedAt: Date.now(),
      reason: "manual",
      issue: "",
      alive: true,
    });
  }

  it("should have capacity when no runs", () => {
    expect(runs.size < 3).toBe(true);
  });

  it("should have capacity with 1 run and max 3", () => {
    addRun(1);
    expect(runs.size < 3).toBe(true);
  });

  it("should have capacity with 2 runs and max 3", () => {
    addRun(1);
    addRun(2);
    expect(runs.size < 3).toBe(true);
  });

  it("should be at capacity with 3 runs and max 3", () => {
    addRun(1);
    addRun(2);
    addRun(3);
    expect(runs.size >= 3).toBe(true);
  });

  it("should be at capacity with 1 run and max 1", () => {
    addRun(1);
    expect(runs.size >= 1).toBe(true);
  });

  it("should find oldest run for 429 response", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now() - 30000, // 30s ago
      reason: "manual",
      issue: "",
      alive: true,
    });
    runs.set(2, {
      pid: 1002,
      startedAt: Date.now() - 10000, // 10s ago
      reason: "schedule",
      issue: "",
      alive: true,
    });

    const oldest = Array.from(runs.values()).reduce((a, b) =>
      a.startedAt < b.startedAt ? a : b
    );
    expect(oldest.pid).toBe(1001);
    expect(oldest.reason).toBe("manual");
  });
});

// ── Reap and enforce (process cleanup) ───────────────────────────────────────

describe("reapAndEnforce - process cleanup", () => {
  let runs: Map<number, MockRunEntry>;
  const TIMEOUT_MS = 30000; // 30 seconds for tests

  beforeEach(() => {
    runs = new Map();
  });

  it("should reap dead processes", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now(),
      reason: "manual",
      issue: "",
      alive: false, // dead
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.reaped).toEqual([1]);
    expect(result.killed).toEqual([]);
    expect(runs.size).toBe(0);
  });

  it("should kill timed-out processes", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now() - TIMEOUT_MS - 1000, // exceeded timeout
      reason: "schedule",
      issue: "",
      alive: true,
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.reaped).toEqual([]);
    expect(result.killed).toEqual([1]);
    expect(runs.size).toBe(0);
  });

  it("should keep alive processes within timeout", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now() - 5000, // 5s ago, within timeout
      reason: "manual",
      issue: "",
      alive: true,
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.reaped).toEqual([]);
    expect(result.killed).toEqual([]);
    expect(runs.size).toBe(1);
  });

  it("should handle mixed dead and alive processes", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now(),
      reason: "manual",
      issue: "",
      alive: false, // dead
    });
    runs.set(2, {
      pid: 1002,
      startedAt: Date.now() - 5000,
      reason: "schedule",
      issue: "",
      alive: true, // alive, within timeout
    });
    runs.set(3, {
      pid: 1003,
      startedAt: Date.now() - TIMEOUT_MS - 5000,
      reason: "issues",
      issue: "42",
      alive: true, // alive, but timed out
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.reaped).toContain(1);
    expect(result.killed).toContain(3);
    expect(runs.size).toBe(1);
    expect(runs.has(2)).toBe(true);
  });

  it("should handle empty runs map", () => {
    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.reaped).toEqual([]);
    expect(result.killed).toEqual([]);
    expect(runs.size).toBe(0);
  });

  it("should not kill process that is exactly at timeout boundary", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now() - TIMEOUT_MS, // exactly at boundary
      reason: "manual",
      issue: "",
      alive: true,
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    // elapsed == TIMEOUT_MS, and check is elapsed > TIMEOUT_MS (strict >)
    expect(result.killed).toEqual([]);
    expect(runs.size).toBe(1);
  });

  it("should kill process 1ms after timeout", () => {
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now() - TIMEOUT_MS - 1, // 1ms past timeout
      reason: "manual",
      issue: "",
      alive: true,
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.killed).toEqual([1]);
    expect(runs.size).toBe(0);
  });

  it("should reap multiple dead processes", () => {
    runs.set(1, { pid: 1001, startedAt: Date.now(), reason: "a", issue: "", alive: false });
    runs.set(2, { pid: 1002, startedAt: Date.now(), reason: "b", issue: "", alive: false });
    runs.set(3, { pid: 1003, startedAt: Date.now(), reason: "c", issue: "", alive: false });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    expect(result.reaped).toHaveLength(3);
    expect(runs.size).toBe(0);
  });

  it("should handle dead process that also exceeds timeout", () => {
    // Dead processes should be reaped even if they exceed timeout
    runs.set(1, {
      pid: 1001,
      startedAt: Date.now() - TIMEOUT_MS - 60000, // way past timeout but dead
      reason: "manual",
      issue: "",
      alive: false,
    });

    const result = reapAndEnforce(runs, TIMEOUT_MS);
    // Should be reaped (dead check comes first), not killed
    expect(result.reaped).toEqual([1]);
    expect(result.killed).toEqual([]);
    expect(runs.size).toBe(0);
  });
});

// ── Health response structure ────────────────────────────────────────────────

describe("Health response structure", () => {
  it("should compute correct age from startedAt", () => {
    const startedAt = Date.now() - 5000; // 5 seconds ago
    const now = Date.now();
    const ageSec = Math.round((now - startedAt) / 1000);
    expect(ageSec).toBe(5);
  });

  it("should compute timeout seconds from milliseconds", () => {
    const timeoutMs = 75 * 60 * 1000; // 75 minutes
    const timeoutSec = Math.round(timeoutMs / 1000);
    expect(timeoutSec).toBe(4500);
  });

  it("should compute default timeout correctly", () => {
    // Default from trigger-server: 75 * 60 * 1000
    const defaultTimeout = 75 * 60 * 1000;
    expect(defaultTimeout).toBe(4500000);
    expect(Math.round(defaultTimeout / 1000 / 60)).toBe(75);
  });

  it("should build active runs list from Map entries", () => {
    const runs = new Map<number, MockRunEntry>();
    runs.set(1, {
      pid: 12345,
      startedAt: Date.now() - 10000,
      reason: "schedule",
      issue: "",
      alive: true,
    });
    runs.set(2, {
      pid: 12346,
      startedAt: Date.now() - 5000,
      reason: "issues",
      issue: "42",
      alive: true,
    });

    const now = Date.now();
    const activeRuns = Array.from(runs.entries()).map(([id, r]) => ({
      id,
      pid: r.pid,
      reason: r.reason,
      issue: r.issue || undefined,
      ageSec: Math.round((now - r.startedAt) / 1000),
    }));

    expect(activeRuns).toHaveLength(2);
    expect(activeRuns[0].id).toBe(1);
    expect(activeRuns[0].pid).toBe(12345);
    expect(activeRuns[0].reason).toBe("schedule");
    expect(activeRuns[0].issue).toBeUndefined(); // empty string becomes undefined
    expect(activeRuns[1].issue).toBe("42");
  });
});

// ── Streaming response metadata ──────────────────────────────────────────────

describe("Streaming response metadata", () => {
  it("should generate correct header line with reason only", () => {
    const id = 1;
    const reason = "schedule";
    const issue = "";
    const concurrent = 1;
    const max = 3;
    const header = `[trigger] Run #${id} started (reason=${reason}${issue ? `, issue=#${issue}` : ""}, concurrent=${concurrent}/${max})\n`;
    expect(header).toBe("[trigger] Run #1 started (reason=schedule, concurrent=1/3)\n");
  });

  it("should generate correct header line with reason and issue", () => {
    const id = 5;
    const reason = "issues";
    const issue = "42";
    const concurrent = 2;
    const max = 3;
    const header = `[trigger] Run #${id} started (reason=${reason}${issue ? `, issue=#${issue}` : ""}, concurrent=${concurrent}/${max})\n`;
    expect(header).toBe("[trigger] Run #5 started (reason=issues, issue=#42, concurrent=2/3)\n");
  });

  it("should generate correct footer line", () => {
    const id = 1;
    const exitCode = 0;
    const elapsed = 120;
    const remaining = 0;
    const max = 3;
    const footer = `\n[trigger] Run #${id} finished (exit=${exitCode}, duration=${elapsed}s, remaining=${remaining}/${max})\n`;
    expect(footer).toContain("finished");
    expect(footer).toContain("exit=0");
    expect(footer).toContain("duration=120s");
  });

  it("should compute correct CWD from TARGET_SCRIPT path", () => {
    // Replica of CWD logic from trigger-server.ts (lines 179-181)
    function computeCwd(targetScript: string, repoRoot?: string): string {
      return repoRoot || targetScript.substring(0, targetScript.lastIndexOf("/")) || ".";
    }

    expect(computeCwd("/home/sprite/spawn/scripts/run.sh")).toBe(
      "/home/sprite/spawn/scripts"
    );
    expect(computeCwd("/home/sprite/spawn/scripts/run.sh", "/home/sprite/spawn")).toBe(
      "/home/sprite/spawn"
    );
    expect(computeCwd("run.sh")).toBe(".");
    expect(computeCwd("")).toBe(".");
  });
});

// ── Environment variable parsing ─────────────────────────────────────────────

describe("Environment variable parsing", () => {
  it("should parse MAX_CONCURRENT from string", () => {
    expect(parseInt("3", 10)).toBe(3);
    expect(parseInt("1", 10)).toBe(1);
    expect(parseInt("10", 10)).toBe(10);
  });

  it("should default MAX_CONCURRENT to 1 when not set", () => {
    const value = undefined;
    expect(parseInt(value ?? "1", 10)).toBe(1);
  });

  it("should parse RUN_TIMEOUT_MS from string", () => {
    expect(parseInt("4500000", 10)).toBe(4500000);
  });

  it("should default RUN_TIMEOUT_MS to 75 minutes when not set", () => {
    const value = undefined;
    const defaultMs = String(75 * 60 * 1000);
    expect(parseInt(value ?? defaultMs, 10)).toBe(4500000);
  });

  it("should handle NaN for invalid MAX_CONCURRENT", () => {
    const result = parseInt("not-a-number", 10);
    expect(Number.isNaN(result)).toBe(true);
  });
});

// ── Route matching logic ─────────────────────────────────────────────────────

describe("Route matching logic", () => {
  // Replicate the routing conditions from trigger-server.ts (lines 305-401)
  function matchRoute(method: string, pathname: string): string {
    if (method === "GET" && pathname === "/health") return "health";
    if (method === "POST" && pathname === "/trigger") return "trigger";
    return "not_found";
  }

  it("should match GET /health", () => {
    expect(matchRoute("GET", "/health")).toBe("health");
  });

  it("should match POST /trigger", () => {
    expect(matchRoute("POST", "/trigger")).toBe("trigger");
  });

  it("should not match POST /health", () => {
    expect(matchRoute("POST", "/health")).toBe("not_found");
  });

  it("should not match GET /trigger", () => {
    expect(matchRoute("GET", "/trigger")).toBe("not_found");
  });

  it("should not match GET /", () => {
    expect(matchRoute("GET", "/")).toBe("not_found");
  });

  it("should not match PUT /trigger", () => {
    expect(matchRoute("PUT", "/trigger")).toBe("not_found");
  });

  it("should not match DELETE /trigger", () => {
    expect(matchRoute("DELETE", "/trigger")).toBe("not_found");
  });

  it("should not match GET /health/", () => {
    // Trailing slash should not match
    expect(matchRoute("GET", "/health/")).toBe("not_found");
  });

  it("should not match POST /trigger/extra", () => {
    expect(matchRoute("POST", "/trigger/extra")).toBe("not_found");
  });

  it("should not match PATCH /trigger", () => {
    expect(matchRoute("PATCH", "/trigger")).toBe("not_found");
  });
});

// ── Full request validation flow ─────────────────────────────────────────────

describe("Full trigger request validation flow", () => {
  // Simulates the full validation chain from trigger-server.ts (lines 325-397)
  function validateTriggerRequest(opts: {
    auth: string;
    secret: string;
    reason?: string;
    issue?: string;
    shuttingDown?: boolean;
    currentRuns: Map<number, MockRunEntry>;
    maxConcurrent: number;
  }): { status: number; error?: string } {
    if (opts.shuttingDown) return { status: 503, error: "server is shutting down" };
    if (!isAuthed(opts.auth, opts.secret)) return { status: 401, error: "unauthorized" };

    // Capacity check (after reap)
    if (opts.currentRuns.size >= opts.maxConcurrent) {
      return { status: 429, error: "max concurrent runs reached" };
    }

    const reason = opts.reason ?? "manual";
    if (!VALID_REASONS.has(reason)) return { status: 400, error: "invalid reason" };

    const issue = opts.issue ?? "";
    if (issue && !/^\d+$/.test(issue)) {
      return { status: 400, error: "issue must be a positive integer" };
    }

    if (hasDuplicateIssue(opts.currentRuns, issue)) {
      return { status: 409, error: "run for this issue already in progress" };
    }

    return { status: 200 };
  }

  const SECRET = "test-secret";
  const AUTH = `Bearer ${SECRET}`;

  it("should return 503 when shutting down (checked before auth)", () => {
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      shuttingDown: true,
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(503);
  });

  it("should return 401 before checking other validations", () => {
    const result = validateTriggerRequest({
      auth: "Bearer wrong",
      secret: SECRET,
      reason: "invalid_reason", // would be 400 if auth passed
      shuttingDown: false,
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(401);
  });

  it("should return 429 before checking reason", () => {
    const runs = new Map<number, MockRunEntry>();
    runs.set(1, {
      pid: 1001, startedAt: Date.now(), reason: "manual", issue: "", alive: true,
    });
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "invalid", // would be 400 if capacity wasn't full
      currentRuns: runs,
      maxConcurrent: 1,
    });
    expect(result.status).toBe(429);
  });

  it("should return 400 for invalid reason before checking issue", () => {
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "evil",
      issue: "not-a-number", // would be 400 if reason was valid
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid reason");
  });

  it("should return 400 for invalid issue before checking dedup", () => {
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "issues",
      issue: "abc",
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(400);
    expect(result.error).toBe("issue must be a positive integer");
  });

  it("should return 409 for duplicate issue", () => {
    const runs = new Map<number, MockRunEntry>();
    runs.set(1, {
      pid: 1001, startedAt: Date.now(), reason: "issues", issue: "42", alive: true,
    });
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "issues",
      issue: "42",
      currentRuns: runs,
      maxConcurrent: 3,
    });
    expect(result.status).toBe(409);
  });

  it("should return 200 for valid request with all checks passing", () => {
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "schedule",
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(200);
  });

  it("should return 200 for valid request with issue", () => {
    const result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "issues",
      issue: "123",
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(200);
  });

  it("should validate in correct order: shutdown > auth > capacity > reason > issue > dedup", () => {
    // This test verifies the priority ordering of error checks
    // by providing inputs that would fail multiple checks

    // Shutdown takes priority over auth failure
    let result = validateTriggerRequest({
      auth: "Bearer wrong",
      secret: SECRET,
      shuttingDown: true,
      currentRuns: new Map(),
      maxConcurrent: 3,
    });
    expect(result.status).toBe(503);

    // Auth takes priority over capacity
    const fullRuns = new Map<number, MockRunEntry>();
    fullRuns.set(1, {
      pid: 1001, startedAt: Date.now(), reason: "manual", issue: "", alive: true,
    });
    result = validateTriggerRequest({
      auth: "Bearer wrong",
      secret: SECRET,
      currentRuns: fullRuns,
      maxConcurrent: 1,
    });
    expect(result.status).toBe(401);

    // Capacity takes priority over reason validation
    result = validateTriggerRequest({
      auth: AUTH,
      secret: SECRET,
      reason: "invalid",
      currentRuns: fullRuns,
      maxConcurrent: 1,
    });
    expect(result.status).toBe(429);
  });
});

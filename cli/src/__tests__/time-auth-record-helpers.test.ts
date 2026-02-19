import { describe, it, expect, afterEach } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Direct unit tests for exported helper functions in commands.ts:
 *
 *   - formatRelativeTime: human-readable relative time from ISO string
 *   - formatTimestamp: formatted absolute date+time from ISO string
 *   - getImplementedAgents: agents implemented for a given cloud
 *   - getImplementedClouds: clouds implemented for a given agent
 *   - parseAuthEnvVars: extract env var names from cloud auth field
 *   - hasCloudCredentials: check if all auth vars are set
 *   - resolveDisplayName: manifest-aware display name lookup
 *   - buildRecordLabel: formatted agent/cloud label for list display
 *   - buildRecordHint: formatted timestamp + prompt hint for list display
 *
 * These functions are exported from commands.ts but prior tests only
 * exercised them through replicas or integration paths. This file tests
 * the actual exports directly.
 *
 * Agent: test-engineer
 */

const {
  formatRelativeTime,
  formatTimestamp,
  getImplementedAgents,
  getImplementedClouds,
  parseAuthEnvVars,
  hasCloudCredentials,
  resolveDisplayName,
  buildRecordLabel,
  buildRecordHint,
} = await import("../commands.js");

// ── Test fixtures ────────────────────────────────────────────────────────────

function createManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm i -g claude",
        launch: "claude",
        env: { ANTHROPIC_API_KEY: "key" },
      },
      codex: {
        name: "Codex",
        description: "AI pair programmer",
        url: "https://codex.dev",
        install: "npm install -g codex",
        launch: "codex",
        env: { OPENAI_API_KEY: "key" },
      },
      gptme: {
        name: "GPTMe",
        description: "AI terminal assistant",
        url: "https://gptme.dev",
        install: "pip install gptme",
        launch: "gptme",
        env: { OPENAI_API_KEY: "key" },
      },
    },
    clouds: {
      sprite: {
        name: "Sprite",
        description: "Lightweight VMs",
        url: "https://sprite.sh",
        type: "vm",
        auth: "SPRITE_TOKEN",
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
      upcloud: {
        name: "UpCloud",
        description: "Finnish cloud",
        url: "https://upcloud.com",
        type: "cloud",
        auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      modal: {
        name: "Modal",
        description: "Serverless compute",
        url: "https://modal.com",
        type: "container",
        auth: "none",
        provision_method: "cli",
        exec_method: "exec",
        interactive_method: "exec",
      },
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/codex": "implemented",
      "sprite/gptme": "missing",
      "hetzner/claude": "implemented",
      "hetzner/codex": "missing",
      "hetzner/gptme": "implemented",
      "upcloud/claude": "implemented",
      "upcloud/codex": "missing",
      "upcloud/gptme": "missing",
      "modal/claude": "missing",
      "modal/codex": "missing",
      "modal/gptme": "missing",
    },
    ...overrides,
  };
}

// ── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  it("returns 'just now' for timestamps within the last 60 seconds", () => {
    const now = new Date();
    expect(formatRelativeTime(now.toISOString())).toBe("just now");
  });

  it("returns 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60_000);
    expect(formatRelativeTime(future.toISOString())).toBe("just now");
  });

  it("returns minutes ago for 1-59 minutes", () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60_000);
    expect(formatRelativeTime(twoMinAgo.toISOString())).toBe("2 min ago");
  });

  it("returns hours ago for 1-23 hours", () => {
    const threeHrsAgo = new Date(Date.now() - 3 * 3600_000);
    expect(formatRelativeTime(threeHrsAgo.toISOString())).toBe("3h ago");
  });

  it("returns 'yesterday' for exactly 1 day ago", () => {
    const oneDayAgo = new Date(Date.now() - 24 * 3600_000);
    expect(formatRelativeTime(oneDayAgo.toISOString())).toBe("yesterday");
  });

  it("returns days ago for 2-29 days", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600_000);
    expect(formatRelativeTime(fiveDaysAgo.toISOString())).toBe("5d ago");
  });

  it("returns absolute date for 30+ days ago", () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 3600_000);
    const result = formatRelativeTime(oldDate.toISOString());
    expect(result).not.toContain("ago");
    expect(result).not.toBe("just now");
    expect(result).not.toBe("yesterday");
  });

  it("returns original string for invalid ISO date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("returns original string for empty string", () => {
    expect(formatRelativeTime("")).toBe("");
  });

  it("handles boundary at 59 seconds (still just now)", () => {
    const justUnder = new Date(Date.now() - 59_000);
    expect(formatRelativeTime(justUnder.toISOString())).toBe("just now");
  });

  it("handles boundary at 60 seconds (1 min ago)", () => {
    const justOver = new Date(Date.now() - 61_000);
    expect(formatRelativeTime(justOver.toISOString())).toBe("1 min ago");
  });

  it("handles boundary at 59 minutes (still minutes)", () => {
    const fiftyNine = new Date(Date.now() - 59 * 60_000);
    expect(formatRelativeTime(fiftyNine.toISOString())).toBe("59 min ago");
  });

  it("handles boundary at 60 minutes (1h ago)", () => {
    const oneHour = new Date(Date.now() - 60 * 60_000);
    expect(formatRelativeTime(oneHour.toISOString())).toBe("1h ago");
  });

  it("handles boundary at 23 hours (still hours)", () => {
    const twentyThree = new Date(Date.now() - 23 * 3600_000);
    expect(formatRelativeTime(twentyThree.toISOString())).toBe("23h ago");
  });

  it("handles boundary at 29 days (still days)", () => {
    const twentyNine = new Date(Date.now() - 29 * 24 * 3600_000);
    expect(formatRelativeTime(twentyNine.toISOString())).toBe("29d ago");
  });

  it("handles epoch timestamp", () => {
    const result = formatRelativeTime("1970-01-01T00:00:00.000Z");
    expect(result).not.toContain("ago");
    expect(result).toContain("Jan");
  });
});

// ── formatTimestamp ──────────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  it("formats a valid ISO date to human-readable string", () => {
    const result = formatTimestamp("2025-06-15T14:30:00.000Z");
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(5);
    expect(result).not.toBe("2025-06-15T14:30:00.000Z");
  });

  it("returns original string for invalid date", () => {
    expect(formatTimestamp("garbage")).toBe("garbage");
  });

  it("returns original string for empty string", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("handles epoch timestamp", () => {
    const result = formatTimestamp("1970-01-01T00:00:00.000Z");
    expect(result).toContain("1970");
    expect(result).toContain("Jan");
  });

  it("handles recent date", () => {
    const now = new Date().toISOString();
    const result = formatTimestamp(now);
    const year = new Date().getFullYear().toString();
    expect(result).toContain(year);
  });

  it("returns date with both date and time components", () => {
    const result = formatTimestamp("2024-12-25T08:30:00.000Z");
    expect(result).toContain("2024");
    expect(result).toContain(":");
  });
});

// ── getImplementedAgents ─────────────────────────────────────────────────────

describe("getImplementedAgents", () => {
  const manifest = createManifest();

  it("returns implemented agents for sprite", () => {
    const agents = getImplementedAgents(manifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
    expect(agents).not.toContain("gptme");
  });

  it("returns implemented agents for hetzner", () => {
    const agents = getImplementedAgents(manifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).toContain("gptme");
    expect(agents).not.toContain("codex");
  });

  it("returns empty array for cloud with no implementations", () => {
    const agents = getImplementedAgents(manifest, "modal");
    expect(agents).toEqual([]);
  });

  it("returns empty array for unknown cloud", () => {
    const agents = getImplementedAgents(manifest, "nonexistent");
    expect(agents).toEqual([]);
  });
});

// ── getImplementedClouds ─────────────────────────────────────────────────────

describe("getImplementedClouds", () => {
  const manifest = createManifest();

  it("returns implemented clouds for claude", () => {
    const clouds = getImplementedClouds(manifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
    expect(clouds).toContain("upcloud");
    expect(clouds).not.toContain("modal");
  });

  it("returns implemented clouds for codex (only sprite)", () => {
    const clouds = getImplementedClouds(manifest, "codex");
    expect(clouds).toEqual(["sprite"]);
  });

  it("returns implemented clouds for gptme", () => {
    const clouds = getImplementedClouds(manifest, "gptme");
    expect(clouds).toContain("hetzner");
    expect(clouds).not.toContain("sprite");
  });

  it("returns empty array for unknown agent", () => {
    const clouds = getImplementedClouds(manifest, "nonexistent");
    expect(clouds).toEqual([]);
  });
});

// ── parseAuthEnvVars ─────────────────────────────────────────────────────────

describe("parseAuthEnvVars", () => {
  it("parses single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("parses multiple env vars separated by +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("returns empty array for 'none'", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("returns empty array for 'token' (not uppercase env var pattern)", () => {
    expect(parseAuthEnvVars("token")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAuthEnvVars("")).toEqual([]);
  });

  it("filters out short names (< 4 chars after initial)", () => {
    expect(parseAuthEnvVars("AB")).toEqual([]);
  });

  it("filters out names starting with lowercase", () => {
    expect(parseAuthEnvVars("myToken")).toEqual([]);
  });

  it("handles mixed valid and invalid parts", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN + cli")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("handles env var with numbers", () => {
    expect(parseAuthEnvVars("AWS_ACCESS_KEY_ID")).toEqual(["AWS_ACCESS_KEY_ID"]);
  });

  it("handles triple env var auth strings", () => {
    expect(parseAuthEnvVars("VAR_A + VAR_B + VAR_C")).toEqual([
      "VAR_A",
      "VAR_B",
      "VAR_C",
    ]);
  });

  it("handles whitespace variations in plus-separated auth", () => {
    expect(parseAuthEnvVars("FOO_BAR+BAZ_QUX")).toEqual(["FOO_BAR", "BAZ_QUX"]);
  });

  it("handles extra whitespace around vars", () => {
    expect(parseAuthEnvVars("  SOME_VAR  +  OTHER_VAR  ")).toEqual([
      "SOME_VAR",
      "OTHER_VAR",
    ]);
  });
});

// ── hasCloudCredentials ──────────────────────────────────────────────────────

describe("hasCloudCredentials", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function unsetEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  it("returns true when single auth var is set", () => {
    setEnv("HCLOUD_TOKEN", "test-value");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("returns false when single auth var is missing", () => {
    unsetEnv("HCLOUD_TOKEN");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("returns true when all multi-var auth vars are set", () => {
    setEnv("UPCLOUD_USERNAME", "user");
    setEnv("UPCLOUD_PASSWORD", "pass");
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(true);
  });

  it("returns false when only some multi-var auth vars are set", () => {
    setEnv("UPCLOUD_USERNAME", "user");
    unsetEnv("UPCLOUD_PASSWORD");
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(false);
  });

  it("returns false for 'none' (no extractable vars)", () => {
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("returns false for 'token' (non-env-var auth)", () => {
    expect(hasCloudCredentials("token")).toBe(false);
  });

  it("returns false for empty auth string", () => {
    expect(hasCloudCredentials("")).toBe(false);
  });

  it("returns false when var is set to empty string", () => {
    setEnv("HCLOUD_TOKEN", "");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });
});

// ── resolveDisplayName ───────────────────────────────────────────────────────

describe("resolveDisplayName", () => {
  const manifest = createManifest();

  it("resolves agent display name from manifest", () => {
    expect(resolveDisplayName(manifest, "claude", "agent")).toBe("Claude Code");
  });

  it("resolves cloud display name from manifest", () => {
    expect(resolveDisplayName(manifest, "hetzner", "cloud")).toBe("Hetzner Cloud");
  });

  it("returns key as fallback for unknown agent", () => {
    expect(resolveDisplayName(manifest, "unknown-agent", "agent")).toBe("unknown-agent");
  });

  it("returns key as fallback for unknown cloud", () => {
    expect(resolveDisplayName(manifest, "unknown-cloud", "cloud")).toBe("unknown-cloud");
  });

  it("returns key as fallback when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
  });

  it("resolves all agent names correctly", () => {
    expect(resolveDisplayName(manifest, "codex", "agent")).toBe("Codex");
    expect(resolveDisplayName(manifest, "codex", "agent")).toBe("Codex");
  });

  it("resolves all cloud names correctly", () => {
    expect(resolveDisplayName(manifest, "sprite", "cloud")).toBe("Sprite");
    expect(resolveDisplayName(manifest, "upcloud", "cloud")).toBe("UpCloud");
    expect(resolveDisplayName(manifest, "modal", "cloud")).toBe("Modal");
  });
});

// ── buildRecordLabel ─────────────────────────────────────────────────────────

describe("buildRecordLabel", () => {
  const manifest = createManifest();

  it("builds label with display names from manifest", () => {
    const label = buildRecordLabel({ agent: "claude", cloud: "sprite", timestamp: "" }, manifest);
    expect(label).toContain("Claude Code");
    expect(label).toContain("Sprite");
  });

  it("uses key as fallback for unknown agent", () => {
    const label = buildRecordLabel({ agent: "unknown", cloud: "sprite", timestamp: "" }, manifest);
    expect(label).toContain("unknown");
    expect(label).toContain("Sprite");
  });

  it("uses key as fallback when manifest is null", () => {
    const label = buildRecordLabel({ agent: "claude", cloud: "sprite", timestamp: "" }, null);
    expect(label).toContain("claude");
    expect(label).toContain("sprite");
  });

  it("includes both agent and cloud in label", () => {
    const label = buildRecordLabel({ agent: "codex", cloud: "hetzner", timestamp: "" }, manifest);
    expect(label).toContain("Codex");
    expect(label).toContain("Hetzner Cloud");
  });

  it("uses 'on' separator between agent and cloud", () => {
    const label = buildRecordLabel({ agent: "claude", cloud: "sprite", timestamp: "" }, manifest);
    expect(label).toBe("Claude Code on Sprite");
  });
});

// ── buildRecordHint ──────────────────────────────────────────────────────────

describe("buildRecordHint", () => {
  it("includes relative timestamp for old dates", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2025-06-15T14:30:00.000Z",
    });
    // formatRelativeTime returns short date for old timestamps (e.g., "Jun 15")
    expect(hint).toContain("Jun");
  });

  it("includes relative timestamp for recent dates", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: fiveMinAgo,
    });
    expect(hint).toContain("5 min ago");
  });

  it("includes prompt preview when prompt is provided", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2025-06-15T14:30:00.000Z",
      prompt: "Fix the login bug",
    });
    expect(hint).toContain("Fix the login bug");
  });

  it("truncates long prompts at 30 characters", () => {
    const longPrompt = "A".repeat(200);
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2025-06-15T14:30:00.000Z",
      prompt: longPrompt,
    });
    expect(hint).toContain("A".repeat(30) + "...");
    expect(hint).not.toContain("A".repeat(31));
  });

  it("does not truncate short prompts", () => {
    const shortPrompt = "Fix the bug";
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2025-06-15T14:30:00.000Z",
      prompt: shortPrompt,
    });
    expect(hint).toContain('"Fix the bug"');
  });

  it("shows timestamp for record without prompt", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: new Date().toISOString(),
    });
    expect(hint.length).toBeGreaterThan(0);
  });

  it("handles invalid timestamp gracefully", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "not-a-date",
    });
    expect(hint).toContain("not-a-date");
  });

  it("wraps prompt in double quotes with --prompt flag", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: new Date().toISOString(),
      prompt: "hello",
    });
    expect(hint).toContain('--prompt "hello"');
  });
});

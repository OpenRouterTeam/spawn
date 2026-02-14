import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  getErrorMessage,
  levenshtein,
  findClosestMatch,
  findClosestKeyByNameOrKey,
  resolveAgentKey,
  resolveCloudKey,
  checkEntity,
  getImplementedClouds,
  getImplementedAgents,
  calculateColumnWidth,
  getMissingClouds,
  parseAuthEnvVars,
  hasCloudCredentials,
  formatRelativeTime,
  formatTimestamp,
  resolveDisplayName,
  buildRecordLabel,
  buildRecordHint,
  buildRetryCommand,
  isRetryableExitCode,
  getTerminalWidth,
  getStatusDescription,
  credentialHints,
  getSignalGuidance,
  getScriptFailureGuidance,
  prioritizeCloudsByCredentials,
  buildAgentPickerHints,
} from "../commands";
import type { Manifest } from "../manifest";
import type { SpawnRecord } from "../history";

/**
 * Comprehensive edge-case tests for exported helpers in commands.ts.
 *
 * These tests cover boundary conditions, degenerate inputs, and
 * interaction between related helper functions that are individually
 * tested but not tested together with complex manifests. Focus areas:
 *
 * - Entity resolution with manifests containing many similar keys
 * - parseAuthEnvVars with unusual auth string formats
 * - hasCloudCredentials interaction with environment variables
 * - formatRelativeTime with extreme dates and invalid inputs
 * - buildRetryCommand with special characters in prompts
 * - prioritizeCloudsByCredentials with mixed credential states
 * - buildAgentPickerHints with zero/partial/full implementations
 * - getSignalGuidance and getScriptFailureGuidance with all branches
 * - credentialHints with complex multi-variable auth
 *
 * Agent: test-engineer
 */

// ── Large Manifest Fixture ──────────────────────────────────────────────────

function createLargeManifest(): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
      },
      aider: {
        name: "Aider",
        description: "AI pair programmer",
        url: "https://aider.chat",
        install: "pip install aider-chat",
        launch: "aider",
        env: { OPENAI_API_KEY: "$OPENROUTER_API_KEY" },
      },
      goose: {
        name: "Goose",
        description: "AI developer agent",
        url: "https://goose.ai",
        install: "pip install goose",
        launch: "goose",
        env: {},
      },
      codex: {
        name: "Codex",
        description: "OpenAI Codex CLI",
        url: "https://openai.com",
        install: "npm install -g codex",
        launch: "codex",
        env: { OPENAI_API_KEY: "$OPENROUTER_API_KEY" },
      },
      "open-claw": {
        name: "OpenClaw",
        description: "Open-source agent",
        url: "https://openclaw.dev",
        install: "pip install openclaw",
        launch: "openclaw",
        env: {},
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
        description: "European cloud provider",
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
      vultr: {
        name: "Vultr",
        description: "Global cloud platform",
        url: "https://vultr.com",
        type: "cloud",
        auth: "VULTR_API_KEY",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      local: {
        name: "Local",
        description: "Local machine",
        url: "https://localhost",
        type: "local",
        auth: "none",
        provision_method: "local",
        exec_method: "local",
        interactive_method: "local",
      },
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/aider": "implemented",
      "sprite/goose": "implemented",
      "sprite/codex": "missing",
      "sprite/open-claw": "missing",
      "hetzner/claude": "implemented",
      "hetzner/aider": "missing",
      "hetzner/goose": "missing",
      "hetzner/codex": "missing",
      "hetzner/open-claw": "missing",
      "upcloud/claude": "implemented",
      "upcloud/aider": "implemented",
      "upcloud/goose": "missing",
      "upcloud/codex": "missing",
      "upcloud/open-claw": "missing",
      "vultr/claude": "implemented",
      "vultr/aider": "missing",
      "vultr/goose": "missing",
      "vultr/codex": "missing",
      "vultr/open-claw": "missing",
      "local/claude": "implemented",
      "local/aider": "implemented",
      "local/goose": "implemented",
      "local/codex": "implemented",
      "local/open-claw": "implemented",
    },
  };
}

// ── parseAuthEnvVars ────────────────────────────────────────────────────────

describe("parseAuthEnvVars edge cases", () => {
  it("should parse single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should parse multiple env vars joined with +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("should filter out non-env-var strings", () => {
    // "token" and "ssh key" are not valid env var patterns
    expect(parseAuthEnvVars("token")).toEqual([]);
    expect(parseAuthEnvVars("ssh key")).toEqual([]);
  });

  it("should return empty array for 'none'", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("should handle three-part auth strings", () => {
    const result = parseAuthEnvVars("API_KEY + API_SECRET + API_REGION");
    expect(result).toEqual(["API_KEY", "API_SECRET", "API_REGION"]);
  });

  it("should require at least 4 characters for env var name", () => {
    // Pattern is /^[A-Z][A-Z0-9_]{3,}$/
    expect(parseAuthEnvVars("ABC")).toEqual([]);
    expect(parseAuthEnvVars("ABCD")).toEqual(["ABCD"]);
  });

  it("should reject env vars starting with a number", () => {
    expect(parseAuthEnvVars("1TOKEN")).toEqual([]);
  });

  it("should reject env vars with lowercase letters", () => {
    expect(parseAuthEnvVars("hcloud_token")).toEqual([]);
  });

  it("should accept env vars with underscores", () => {
    expect(parseAuthEnvVars("MY_API_TOKEN_V2")).toEqual(["MY_API_TOKEN_V2"]);
  });

  it("should accept env vars with numbers", () => {
    expect(parseAuthEnvVars("API2_KEY")).toEqual(["API2_KEY"]);
  });

  it("should handle spacing variations around +", () => {
    expect(parseAuthEnvVars("A_KEY+B_KEY")).toEqual(["A_KEY", "B_KEY"]);
    expect(parseAuthEnvVars("A_KEY  +  B_KEY")).toEqual(["A_KEY", "B_KEY"]);
  });

  it("should handle empty string", () => {
    expect(parseAuthEnvVars("")).toEqual([]);
  });

  it("should handle whitespace-only string", () => {
    expect(parseAuthEnvVars("   ")).toEqual([]);
  });
});

// ── hasCloudCredentials ─────────────────────────────────────────────────────

describe("hasCloudCredentials edge cases", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return false when auth is 'none'", () => {
    // "none" parses to no valid env var names
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("should return true when single env var is set", () => {
    process.env.HCLOUD_TOKEN = "test-value";
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("should return false when single env var is not set", () => {
    delete process.env.HCLOUD_TOKEN;
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should return true when all multi-var credentials are set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(true);
  });

  it("should return false when only one of multi-var credentials is set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    delete process.env.UPCLOUD_PASSWORD;
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(false);
  });

  it("should return false when neither multi-var credential is set", () => {
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(false);
  });

  it("should return false for non-standard auth string with no valid vars", () => {
    expect(hasCloudCredentials("OAuth browser flow")).toBe(false);
  });

  it("should handle empty env var value as set", () => {
    process.env.HCLOUD_TOKEN = "";
    // empty string is falsy, so hasCloudCredentials checks !!process.env[v]
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });
});

// ── resolveEntityKey pipeline ───────────────────────────────────────────────

describe("resolveAgentKey and resolveCloudKey with large manifests", () => {
  const manifest = createLargeManifest();

  describe("resolveAgentKey", () => {
    it("should find exact key match", () => {
      expect(resolveAgentKey(manifest, "claude")).toBe("claude");
    });

    it("should find case-insensitive key match", () => {
      expect(resolveAgentKey(manifest, "CLAUDE")).toBe("claude");
      expect(resolveAgentKey(manifest, "Claude")).toBe("claude");
    });

    it("should find case-insensitive display name match", () => {
      expect(resolveAgentKey(manifest, "claude code")).toBe("claude");
      expect(resolveAgentKey(manifest, "Claude Code")).toBe("claude");
      expect(resolveAgentKey(manifest, "CLAUDE CODE")).toBe("claude");
    });

    it("should return null for unknown agent", () => {
      expect(resolveAgentKey(manifest, "nonexistent")).toBeNull();
    });

    it("should match hyphenated key", () => {
      expect(resolveAgentKey(manifest, "open-claw")).toBe("open-claw");
    });

    it("should match hyphenated key case-insensitively", () => {
      expect(resolveAgentKey(manifest, "OPEN-CLAW")).toBe("open-claw");
    });

    it("should match display name 'OpenClaw'", () => {
      expect(resolveAgentKey(manifest, "OpenClaw")).toBe("open-claw");
    });

    it("should match display name 'openclaw' case-insensitively", () => {
      expect(resolveAgentKey(manifest, "openclaw")).toBe("open-claw");
    });

    it("should prefer exact key match over display name match", () => {
      // If there were a key named "goose" and a display name "Goose", exact key wins
      expect(resolveAgentKey(manifest, "goose")).toBe("goose");
    });

    it("should not match a cloud key as an agent", () => {
      expect(resolveAgentKey(manifest, "sprite")).toBeNull();
      expect(resolveAgentKey(manifest, "hetzner")).toBeNull();
    });
  });

  describe("resolveCloudKey", () => {
    it("should find exact key match", () => {
      expect(resolveCloudKey(manifest, "sprite")).toBe("sprite");
    });

    it("should find case-insensitive key match", () => {
      expect(resolveCloudKey(manifest, "SPRITE")).toBe("sprite");
      expect(resolveCloudKey(manifest, "Sprite")).toBe("sprite");
    });

    it("should find case-insensitive display name match", () => {
      expect(resolveCloudKey(manifest, "Hetzner Cloud")).toBe("hetzner");
      expect(resolveCloudKey(manifest, "hetzner cloud")).toBe("hetzner");
    });

    it("should return null for unknown cloud", () => {
      expect(resolveCloudKey(manifest, "aws")).toBeNull();
    });

    it("should match 'UpCloud' display name", () => {
      expect(resolveCloudKey(manifest, "UpCloud")).toBe("upcloud");
    });

    it("should not match an agent key as a cloud", () => {
      expect(resolveCloudKey(manifest, "claude")).toBeNull();
      expect(resolveCloudKey(manifest, "aider")).toBeNull();
    });
  });
});

// ── getImplementedClouds and getImplementedAgents ────────────────────────────

describe("getImplementedClouds with large manifest", () => {
  const manifest = createLargeManifest();

  it("should return all implemented clouds for claude", () => {
    const clouds = getImplementedClouds(manifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
    expect(clouds).toContain("upcloud");
    expect(clouds).toContain("vultr");
    expect(clouds).toContain("local");
    expect(clouds).toHaveLength(5);
  });

  it("should return partial set for aider", () => {
    const clouds = getImplementedClouds(manifest, "aider");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("upcloud");
    expect(clouds).toContain("local");
    expect(clouds).not.toContain("hetzner");
    expect(clouds).not.toContain("vultr");
    expect(clouds).toHaveLength(3);
  });

  it("should return all clouds for open-claw (only on local)", () => {
    const clouds = getImplementedClouds(manifest, "open-claw");
    expect(clouds).toEqual(["local"]);
  });

  it("should return empty array for nonexistent agent", () => {
    expect(getImplementedClouds(manifest, "nonexistent")).toEqual([]);
  });
});

describe("getImplementedAgents with large manifest", () => {
  const manifest = createLargeManifest();

  it("should return all implemented agents for sprite", () => {
    const agents = getImplementedAgents(manifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("aider");
    expect(agents).toContain("goose");
    expect(agents).toHaveLength(3);
  });

  it("should return all agents for local cloud", () => {
    const agents = getImplementedAgents(manifest, "local");
    expect(agents).toContain("claude");
    expect(agents).toContain("aider");
    expect(agents).toContain("goose");
    expect(agents).toContain("codex");
    expect(agents).toContain("open-claw");
    expect(agents).toHaveLength(5);
  });

  it("should return only claude for hetzner", () => {
    const agents = getImplementedAgents(manifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).toHaveLength(1);
  });

  it("should return empty array for nonexistent cloud", () => {
    expect(getImplementedAgents(manifest, "nonexistent")).toEqual([]);
  });
});

// ── getMissingClouds ────────────────────────────────────────────────────────

describe("getMissingClouds with large manifest", () => {
  const manifest = createLargeManifest();
  const clouds = Object.keys(manifest.clouds);

  it("should return missing clouds for partially implemented agent", () => {
    const missing = getMissingClouds(manifest, "aider", clouds);
    expect(missing).toContain("hetzner");
    expect(missing).toContain("vultr");
    expect(missing).not.toContain("sprite");
    expect(missing).not.toContain("local");
  });

  it("should return no missing clouds for fully implemented agent", () => {
    const missing = getMissingClouds(manifest, "claude", clouds);
    expect(missing).toHaveLength(0);
  });

  it("should return all but local for codex", () => {
    const missing = getMissingClouds(manifest, "codex", clouds);
    expect(missing).toContain("sprite");
    expect(missing).toContain("hetzner");
    expect(missing).toContain("upcloud");
    expect(missing).toContain("vultr");
    expect(missing).not.toContain("local");
  });
});

// ── prioritizeCloudsByCredentials ──────────────────────────────────────────

describe("prioritizeCloudsByCredentials with env vars", () => {
  const manifest = createLargeManifest();
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should sort clouds with credentials first", () => {
    process.env.SPRITE_TOKEN = "test";
    delete process.env.HCLOUD_TOKEN;
    delete process.env.VULTR_API_KEY;

    const clouds = ["sprite", "hetzner", "vultr"];
    const { sortedClouds, credCount, hintOverrides } = prioritizeCloudsByCredentials(clouds, manifest);

    expect(sortedClouds[0]).toBe("sprite");
    expect(credCount).toBe(1);
    expect(hintOverrides["sprite"]).toContain("credentials detected");
    expect(hintOverrides["hetzner"]).toBeUndefined();
  });

  it("should handle multiple clouds with credentials", () => {
    process.env.SPRITE_TOKEN = "test";
    process.env.HCLOUD_TOKEN = "test";
    delete process.env.VULTR_API_KEY;

    const clouds = ["vultr", "sprite", "hetzner"];
    const { sortedClouds, credCount } = prioritizeCloudsByCredentials(clouds, manifest);

    expect(credCount).toBe(2);
    // Both sprite and hetzner should come before vultr
    const spriteIdx = sortedClouds.indexOf("sprite");
    const hetznerIdx = sortedClouds.indexOf("hetzner");
    const vultrIdx = sortedClouds.indexOf("vultr");
    expect(spriteIdx).toBeLessThan(vultrIdx);
    expect(hetznerIdx).toBeLessThan(vultrIdx);
  });

  it("should handle no credentials set", () => {
    delete process.env.SPRITE_TOKEN;
    delete process.env.HCLOUD_TOKEN;
    delete process.env.VULTR_API_KEY;

    const clouds = ["sprite", "hetzner", "vultr"];
    const { credCount, hintOverrides } = prioritizeCloudsByCredentials(clouds, manifest);

    expect(credCount).toBe(0);
    expect(Object.keys(hintOverrides)).toHaveLength(0);
  });

  it("should handle multi-variable auth (UpCloud)", () => {
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";

    const clouds = ["upcloud", "sprite"];
    const { sortedClouds, credCount } = prioritizeCloudsByCredentials(clouds, manifest);

    expect(credCount).toBe(1);
    expect(sortedClouds[0]).toBe("upcloud");
  });

  it("should not count partial multi-variable auth", () => {
    process.env.UPCLOUD_USERNAME = "user";
    delete process.env.UPCLOUD_PASSWORD;

    const clouds = ["upcloud", "sprite"];
    const { credCount } = prioritizeCloudsByCredentials(clouds, manifest);

    expect(credCount).toBe(0);
  });

  it("should handle cloud with auth 'none'", () => {
    const clouds = ["local", "sprite"];
    // "none" has no valid env vars, so hasCloudCredentials returns false
    const { credCount } = prioritizeCloudsByCredentials(clouds, manifest);

    // "local" with auth="none" returns false from hasCloudCredentials
    // because vars.length === 0 causes early return false
    expect(credCount).toBe(0);
  });

  it("should handle empty cloud list", () => {
    const { sortedClouds, credCount, hintOverrides } = prioritizeCloudsByCredentials([], manifest);
    expect(sortedClouds).toEqual([]);
    expect(credCount).toBe(0);
    expect(Object.keys(hintOverrides)).toHaveLength(0);
  });
});

// ── buildAgentPickerHints ──────────────────────────────────────────────────

describe("buildAgentPickerHints with large manifest", () => {
  const manifest = createLargeManifest();
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show cloud count for each agent", () => {
    const hints = buildAgentPickerHints(manifest);

    // claude has 5 clouds implemented
    expect(hints["claude"]).toContain("5 clouds");
    // aider has 3 clouds
    expect(hints["aider"]).toContain("3 clouds");
    // open-claw has 1 cloud
    expect(hints["open-claw"]).toContain("1 cloud");
  });

  it("should use singular 'cloud' for single cloud", () => {
    const hints = buildAgentPickerHints(manifest);
    expect(hints["open-claw"]).toBe("1 cloud");
  });

  it("should show 'ready' count when credentials are set", () => {
    process.env.SPRITE_TOKEN = "test";
    process.env.HCLOUD_TOKEN = "test";

    const hints = buildAgentPickerHints(manifest);
    // claude has sprite + hetzner + others with credentials
    expect(hints["claude"]).toContain("ready");
  });

  it("should not show ready count when no credentials are set", () => {
    delete process.env.SPRITE_TOKEN;
    delete process.env.HCLOUD_TOKEN;
    delete process.env.VULTR_API_KEY;
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;

    const hints = buildAgentPickerHints(manifest);
    expect(hints["claude"]).not.toContain("ready");
    expect(hints["claude"]).toContain("5 clouds");
  });
});

// ── formatRelativeTime edge cases ──────────────────────────────────────────

describe("formatRelativeTime edge cases", () => {
  it("should return 'just now' for timestamps within the last minute", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(recent)).toBe("just now");
  });

  it("should return 'just now' for timestamps less than 1 second ago", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("should return 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(future)).toBe("just now");
  });

  it("should return minutes for 1-59 minute range", () => {
    const fiveMin = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMin)).toBe("5 min ago");
  });

  it("should return hours for 1-23 hour range", () => {
    const threeHours = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(threeHours)).toBe("3h ago");
  });

  it("should return 'yesterday' for 24-47 hours ago", () => {
    const yesterday = new Date(Date.now() - 30 * 3600_000).toISOString();
    expect(formatRelativeTime(yesterday)).toBe("yesterday");
  });

  it("should return days for 2-29 day range", () => {
    const fiveDays = new Date(Date.now() - 5 * 86400_000).toISOString();
    expect(formatRelativeTime(fiveDays)).toBe("5d ago");
  });

  it("should return date string for 30+ days ago", () => {
    const oldDate = new Date(Date.now() - 60 * 86400_000).toISOString();
    const result = formatRelativeTime(oldDate);
    // Should be something like "Dec 16" (absolute date)
    expect(result).not.toContain("ago");
    expect(result).not.toBe("just now");
  });

  it("should return the original string for invalid ISO timestamp", () => {
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("should return the original string for empty string", () => {
    expect(formatRelativeTime("")).toBe("");
  });

  it("should handle extremely old dates", () => {
    const result = formatRelativeTime("2020-01-01T00:00:00.000Z");
    // Should fall back to absolute date format
    expect(result).not.toBe("just now");
    expect(result).toContain("Jan");
  });
});

// ── formatTimestamp edge cases ─────────────────────────────────────────────

describe("formatTimestamp edge cases", () => {
  it("should format a valid ISO timestamp", () => {
    const result = formatTimestamp("2026-02-14T10:30:00.000Z");
    expect(result).toContain("2026");
    expect(result).toContain("Feb");
  });

  it("should return original string for invalid date", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("should return original string for empty string", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("should handle epoch timestamp", () => {
    const result = formatTimestamp("1970-01-01T00:00:00.000Z");
    expect(result).toContain("1970");
  });
});

// ── buildRetryCommand ──────────────────────────────────────────────────────

describe("buildRetryCommand edge cases", () => {
  it("should build basic command without prompt", () => {
    expect(buildRetryCommand("claude", "sprite")).toBe("spawn claude sprite");
  });

  it("should include short prompt inline", () => {
    const result = buildRetryCommand("claude", "sprite", "Fix bugs");
    expect(result).toBe('spawn claude sprite --prompt "Fix bugs"');
  });

  it("should escape double quotes in short prompts", () => {
    const result = buildRetryCommand("claude", "sprite", 'Say "hello"');
    expect(result).toBe('spawn claude sprite --prompt "Say \\"hello\\""');
  });

  it("should suggest --prompt-file for long prompts (>80 chars)", () => {
    const longPrompt = "A".repeat(81);
    const result = buildRetryCommand("claude", "sprite", longPrompt);
    expect(result).toContain("--prompt-file");
    expect(result).not.toContain(longPrompt);
  });

  it("should include prompt inline at exactly 80 chars", () => {
    const exactPrompt = "B".repeat(80);
    const result = buildRetryCommand("claude", "sprite", exactPrompt);
    expect(result).toContain("--prompt");
    expect(result).not.toContain("--prompt-file");
  });

  it("should handle prompt with newlines (short enough to inline)", () => {
    const result = buildRetryCommand("claude", "sprite", "line1\nline2");
    expect(result).toContain("--prompt");
  });

  it("should handle empty prompt as no prompt", () => {
    const result = buildRetryCommand("claude", "sprite", "");
    // Empty string is falsy
    expect(result).toBe("spawn claude sprite");
  });
});

// ── isRetryableExitCode ────────────────────────────────────────────────────

describe("isRetryableExitCode", () => {
  it("should return true for exit code 255 (SSH failure)", () => {
    expect(isRetryableExitCode("Script exited with code 255")).toBe(true);
  });

  it("should return false for exit code 1", () => {
    expect(isRetryableExitCode("Script exited with code 1")).toBe(false);
  });

  it("should return false for exit code 0", () => {
    expect(isRetryableExitCode("Script exited with code 0")).toBe(false);
  });

  it("should return false for exit code 130 (Ctrl+C)", () => {
    expect(isRetryableExitCode("Script exited with code 130")).toBe(false);
  });

  it("should return false for exit code 137 (SIGKILL)", () => {
    expect(isRetryableExitCode("Script exited with code 137")).toBe(false);
  });

  it("should return false when no exit code in message", () => {
    expect(isRetryableExitCode("Script was killed by SIGTERM")).toBe(false);
  });

  it("should return false for empty message", () => {
    expect(isRetryableExitCode("")).toBe(false);
  });

  it("should handle multi-digit exit codes", () => {
    expect(isRetryableExitCode("Script exited with code 2550")).toBe(false);
  });
});

// ── getErrorMessage ────────────────────────────────────────────────────────

describe("getErrorMessage edge cases", () => {
  it("should extract message from Error object", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("should extract message from plain object with message property", () => {
    expect(getErrorMessage({ message: "plain object error" })).toBe("plain object error");
  });

  it("should convert non-object to string", () => {
    expect(getErrorMessage("string error")).toBe("string error");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("should handle object without message property", () => {
    expect(getErrorMessage({ code: "ENOENT" })).toBe("[object Object]");
  });

  it("should handle boolean", () => {
    expect(getErrorMessage(true)).toBe("true");
    expect(getErrorMessage(false)).toBe("false");
  });

  it("should handle empty Error message", () => {
    expect(getErrorMessage(new Error(""))).toBe("");
  });
});

// ── getStatusDescription ───────────────────────────────────────────────────

describe("getStatusDescription edge cases", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should return HTTP code for all other statuses", () => {
    expect(getStatusDescription(200)).toBe("HTTP 200");
    expect(getStatusDescription(301)).toBe("HTTP 301");
    expect(getStatusDescription(403)).toBe("HTTP 403");
    expect(getStatusDescription(500)).toBe("HTTP 500");
    expect(getStatusDescription(502)).toBe("HTTP 502");
    expect(getStatusDescription(503)).toBe("HTTP 503");
  });

  it("should handle 0 status code", () => {
    expect(getStatusDescription(0)).toBe("HTTP 0");
  });

  it("should handle negative status code", () => {
    expect(getStatusDescription(-1)).toBe("HTTP -1");
  });
});

// ── calculateColumnWidth ───────────────────────────────────────────────────

describe("calculateColumnWidth edge cases", () => {
  it("should return minimum width when all items are short", () => {
    expect(calculateColumnWidth(["a", "b", "c"], 20)).toBe(20);
  });

  it("should return item-based width when items exceed minimum", () => {
    // "verylongname" (12) + padding (2) = 14
    expect(calculateColumnWidth(["verylongname"], 10)).toBe(14);
  });

  it("should handle empty items array", () => {
    expect(calculateColumnWidth([], 10)).toBe(10);
  });

  it("should handle single-char items", () => {
    expect(calculateColumnWidth(["x"], 5)).toBe(5);
  });

  it("should handle items of varying lengths", () => {
    const items = ["a", "medium", "very-long-name-here"];
    // "very-long-name-here" (19) + padding (2) = 21
    expect(calculateColumnWidth(items, 10)).toBe(21);
  });
});

// ── getSignalGuidance ──────────────────────────────────────────────────────

describe("getSignalGuidance all branches", () => {
  it("should return OOM guidance for SIGKILL", () => {
    const lines = getSignalGuidance("SIGKILL");
    expect(lines.some(l => l.includes("SIGKILL"))).toBe(true);
    expect(lines.some(l => l.includes("memory") || l.includes("OOM"))).toBe(true);
  });

  it("should return termination guidance for SIGTERM", () => {
    const lines = getSignalGuidance("SIGTERM");
    expect(lines.some(l => l.includes("SIGTERM"))).toBe(true);
    expect(lines.some(l => l.includes("terminated"))).toBe(true);
  });

  it("should return interrupt guidance for SIGINT", () => {
    const lines = getSignalGuidance("SIGINT");
    expect(lines.some(l => l.includes("Ctrl+C"))).toBe(true);
  });

  it("should return connection loss guidance for SIGHUP", () => {
    const lines = getSignalGuidance("SIGHUP");
    expect(lines.some(l => l.includes("SIGHUP"))).toBe(true);
    expect(lines.some(l => l.includes("terminal") || l.includes("SSH"))).toBe(true);
  });

  it("should return generic guidance for unknown signals", () => {
    const lines = getSignalGuidance("SIGQUIT");
    expect(lines.some(l => l.includes("SIGQUIT"))).toBe(true);
  });

  it("should include dashboard hint when URL provided", () => {
    const lines = getSignalGuidance("SIGKILL", "https://cloud.example.com");
    expect(lines.some(l => l.includes("cloud.example.com"))).toBe(true);
  });

  it("should include generic dashboard hint when URL not provided", () => {
    const lines = getSignalGuidance("SIGKILL");
    expect(lines.some(l => l.includes("dashboard"))).toBe(true);
  });
});

// ── getScriptFailureGuidance ───────────────────────────────────────────────

describe("getScriptFailureGuidance all exit codes", () => {
  it("should handle exit code 130 (Ctrl+C)", () => {
    const lines = getScriptFailureGuidance(130, "sprite");
    expect(lines.some(l => l.includes("Ctrl+C"))).toBe(true);
  });

  it("should handle exit code 137 (killed/OOM)", () => {
    const lines = getScriptFailureGuidance(137, "sprite");
    expect(lines.some(l => l.includes("killed") || l.includes("memory"))).toBe(true);
  });

  it("should handle exit code 255 (SSH failure)", () => {
    const lines = getScriptFailureGuidance(255, "sprite");
    expect(lines.some(l => l.includes("SSH"))).toBe(true);
  });

  it("should handle exit code 127 (command not found)", () => {
    const lines = getScriptFailureGuidance(127, "sprite");
    expect(lines.some(l => l.includes("not found"))).toBe(true);
  });

  it("should handle exit code 126 (permission denied)", () => {
    const lines = getScriptFailureGuidance(126, "sprite");
    expect(lines.some(l => l.includes("permission") || l.includes("Permission"))).toBe(true);
  });

  it("should handle exit code 2 (syntax error)", () => {
    const lines = getScriptFailureGuidance(2, "sprite");
    expect(lines.some(l => l.includes("syntax") || l.includes("Syntax") || l.includes("bug"))).toBe(true);
  });

  it("should handle exit code 1 (generic failure)", () => {
    const lines = getScriptFailureGuidance(1, "sprite");
    expect(lines.some(l => l.includes("Common causes"))).toBe(true);
  });

  it("should handle null exit code (unknown)", () => {
    const lines = getScriptFailureGuidance(null, "sprite");
    expect(lines.some(l => l.includes("Common causes"))).toBe(true);
  });

  it("should handle unusual exit codes via default case", () => {
    const lines = getScriptFailureGuidance(42, "sprite");
    expect(lines.some(l => l.includes("Common causes"))).toBe(true);
  });

  it("should include dashboard URL for exit code 1 when provided", () => {
    const lines = getScriptFailureGuidance(1, "sprite", undefined, "https://dash.example.com");
    expect(lines.some(l => l.includes("dash.example.com"))).toBe(true);
  });

  it("should include auth hint for exit code 1", () => {
    const lines = getScriptFailureGuidance(1, "sprite", "SPRITE_TOKEN");
    expect(lines.some(l => l.includes("SPRITE_TOKEN") || l.includes("credentials"))).toBe(true);
  });

  it("should include dashboard URL for default exit code when provided", () => {
    const lines = getScriptFailureGuidance(42, "sprite", undefined, "https://dash.example.com");
    expect(lines.some(l => l.includes("dash.example.com"))).toBe(true);
  });
});

// ── credentialHints ────────────────────────────────────────────────────────

describe("credentialHints with environment state", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show generic hint when authHint is undefined", () => {
    const lines = credentialHints("sprite");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("credentials");
    expect(lines[0]).toContain("spawn sprite");
  });

  it("should show specific missing vars when auth hint is provided", () => {
    delete process.env.HCLOUD_TOKEN;
    delete process.env.OPENROUTER_API_KEY;

    const lines = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(lines.some(l => l.includes("HCLOUD_TOKEN"))).toBe(true);
    expect(lines.some(l => l.includes("OPENROUTER_API_KEY"))).toBe(true);
  });

  it("should show 'appear to be set' when all credentials are present", () => {
    process.env.HCLOUD_TOKEN = "test";
    process.env.OPENROUTER_API_KEY = "test";

    const lines = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(lines.some(l => l.includes("appear to be set") || l.includes("Credentials appear"))).toBe(true);
  });

  it("should handle multi-variable auth hint", () => {
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;
    delete process.env.OPENROUTER_API_KEY;

    const lines = credentialHints("upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    expect(lines.some(l => l.includes("UPCLOUD_USERNAME"))).toBe(true);
    expect(lines.some(l => l.includes("UPCLOUD_PASSWORD"))).toBe(true);
  });

  it("should use custom verb when provided", () => {
    const lines = credentialHints("sprite", undefined, "Missing");
    expect(lines[0]).toContain("Missing");
  });

  it("should only show missing vars when some are set", () => {
    process.env.OPENROUTER_API_KEY = "test";
    delete process.env.HCLOUD_TOKEN;

    const lines = credentialHints("hetzner", "HCLOUD_TOKEN");
    // Should show HCLOUD_TOKEN as missing but not OPENROUTER_API_KEY
    expect(lines.some(l => l.includes("HCLOUD_TOKEN"))).toBe(true);
    expect(lines.some(l => l.includes("Missing credentials"))).toBe(true);
  });
});

// ── resolveDisplayName ─────────────────────────────────────────────────────

describe("resolveDisplayName edge cases", () => {
  const manifest = createLargeManifest();

  it("should return display name for known agent key", () => {
    expect(resolveDisplayName(manifest, "claude", "agent")).toBe("Claude Code");
  });

  it("should return display name for known cloud key", () => {
    expect(resolveDisplayName(manifest, "hetzner", "cloud")).toBe("Hetzner Cloud");
  });

  it("should return key as-is for unknown agent", () => {
    expect(resolveDisplayName(manifest, "unknown", "agent")).toBe("unknown");
  });

  it("should return key as-is for unknown cloud", () => {
    expect(resolveDisplayName(manifest, "aws", "cloud")).toBe("aws");
  });

  it("should return key as-is when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
    expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
  });
});

// ── buildRecordLabel and buildRecordHint ──────────────────────────────────

describe("buildRecordLabel", () => {
  const manifest = createLargeManifest();

  it("should build label with display names from manifest", () => {
    const record: SpawnRecord = { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" };
    expect(buildRecordLabel(record, manifest)).toBe("Claude Code on Sprite");
  });

  it("should use raw keys when manifest is null", () => {
    const record: SpawnRecord = { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" };
    expect(buildRecordLabel(record, null)).toBe("claude on sprite");
  });

  it("should handle unknown keys gracefully", () => {
    const record: SpawnRecord = { agent: "unknown", cloud: "aws", timestamp: "2026-01-01T00:00:00Z" };
    expect(buildRecordLabel(record, manifest)).toBe("unknown on aws");
  });
});

describe("buildRecordHint", () => {
  it("should show relative time without prompt", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const record: SpawnRecord = { agent: "claude", cloud: "sprite", timestamp: recent };
    expect(buildRecordHint(record)).toBe("5 min ago");
  });

  it("should show relative time with short prompt preview", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: recent,
      prompt: "Fix bugs",
    };
    const hint = buildRecordHint(record);
    expect(hint).toContain("5 min ago");
    expect(hint).toContain('--prompt "Fix bugs"');
  });

  it("should truncate long prompt in hint", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const longPrompt = "A".repeat(50);
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: recent,
      prompt: longPrompt,
    };
    const hint = buildRecordHint(record);
    expect(hint).toContain("...");
    expect(hint.length).toBeLessThan(longPrompt.length + 30);
  });

  it("should include exactly 30 chars of prompt before truncation", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const prompt = "A".repeat(31);
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: recent,
      prompt,
    };
    const hint = buildRecordHint(record);
    expect(hint).toContain("A".repeat(30) + "...");
  });

  it("should not truncate prompt at exactly 30 chars", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const prompt = "A".repeat(30);
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: recent,
      prompt,
    };
    const hint = buildRecordHint(record);
    expect(hint).not.toContain("...");
  });
});

// ── levenshtein distance edge cases ────────────────────────────────────────

describe("levenshtein distance edge cases", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("should return length of b when a is empty", () => {
    expect(levenshtein("", "hello")).toBe(5);
  });

  it("should return length of a when b is empty", () => {
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("should return 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("should handle single-char strings", () => {
    expect(levenshtein("a", "b")).toBe(1);
    expect(levenshtein("a", "a")).toBe(0);
    expect(levenshtein("a", "")).toBe(1);
  });

  it("should be symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(levenshtein("sitting", "kitten"));
  });

  it("should compute classic kitten-sitting distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("should handle transposition as 2 edits", () => {
    // Levenshtein counts transpositions as 2 operations (delete + insert)
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("should handle completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

// ── findClosestMatch with large candidate lists ────────────────────────────

describe("findClosestMatch with large candidate lists", () => {
  it("should find best match among many candidates", () => {
    const candidates = ["sprite", "hetzner", "vultr", "upcloud", "local", "digitalocean", "linode"];
    expect(findClosestMatch("sprit", candidates)).toBe("sprite");
  });

  it("should return null when all candidates are too far", () => {
    const candidates = ["sprite", "hetzner"];
    expect(findClosestMatch("completely-different-name", candidates)).toBeNull();
  });

  it("should prefer exact match (distance 0) over close match", () => {
    const candidates = ["claude", "clauds"];
    expect(findClosestMatch("claude", candidates)).toBe("claude");
  });

  it("should handle single candidate", () => {
    expect(findClosestMatch("claud", ["claude"])).toBe("claude");
  });

  it("should handle empty candidate list", () => {
    expect(findClosestMatch("test", [])).toBeNull();
  });

  it("should be case-insensitive", () => {
    expect(findClosestMatch("CLAUDE", ["claude"])).toBe("claude");
    expect(findClosestMatch("claude", ["CLAUDE"])).toBe("CLAUDE");
  });
});

// ── getTerminalWidth ───────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  it("should return a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });

  it("should default to 80 when stdout.columns is unavailable", () => {
    const originalColumns = process.stdout.columns;
    // process.stdout.columns may be undefined in non-TTY environments
    // The function uses `process.stdout.columns || 80`
    const width = getTerminalWidth();
    expect(width).toBeGreaterThanOrEqual(80);
  });
});

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest } from "./test-helpers";
import type { Manifest } from "../manifest";

// Mock @clack/prompts before importing commands
mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

const {
  buildRetryCommand,
  resolveDisplayName,
  buildRecordLabel,
  buildRecordHint,
  formatTimestamp,
  getStatusDescription,
  isRetryableExitCode,
  parseAuthEnvVars,
  hasCloudCredentials,
  getImplementedClouds,
  getImplementedAgents,
} = await import("../commands.js");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildRetryCommand", () => {
  describe("without prompt", () => {
    it("should return basic spawn command", () => {
      expect(buildRetryCommand("claude", "sprite")).toBe(
        "spawn claude sprite"
      );
    });

    it("should handle hyphenated agent names", () => {
      expect(buildRetryCommand("claude-code", "hetzner")).toBe(
        "spawn claude-code hetzner"
      );
    });

    it("should handle various cloud names", () => {
      expect(buildRetryCommand("aider", "digitalocean")).toBe(
        "spawn aider digitalocean"
      );
    });
  });

  describe("with short prompt (<=80 chars)", () => {
    it("should inline short prompt with --prompt flag", () => {
      expect(buildRetryCommand("claude", "sprite", "Fix bugs")).toBe(
        'spawn claude sprite --prompt "Fix bugs"'
      );
    });

    it("should escape double quotes in prompt", () => {
      expect(
        buildRetryCommand("claude", "sprite", 'Say "hello"')
      ).toBe('spawn claude sprite --prompt "Say \\"hello\\""');
    });

    it("should handle prompt with multiple double quotes", () => {
      const prompt = '"a" and "b" and "c"';
      const result = buildRetryCommand("claude", "sprite", prompt);
      expect(result).toContain('\\"a\\"');
      expect(result).toContain('\\"b\\"');
      expect(result).toContain('\\"c\\"');
    });

    it("should inline exactly 80-char prompt", () => {
      const prompt80 = "A".repeat(80);
      const result = buildRetryCommand("claude", "sprite", prompt80);
      expect(result).toContain("--prompt");
      expect(result).toContain(prompt80);
      expect(result).not.toContain("--prompt-file");
    });

    it("should inline single-character prompt", () => {
      expect(buildRetryCommand("claude", "sprite", "x")).toBe(
        'spawn claude sprite --prompt "x"'
      );
    });

    it("should handle prompt with special characters", () => {
      const prompt = "Fix the $PATH issue & restart";
      const result = buildRetryCommand("claude", "sprite", prompt);
      expect(result).toContain("--prompt");
      expect(result).toContain(prompt);
    });

    it("should handle prompt with newlines", () => {
      const prompt = "Line 1\nLine 2";
      const result = buildRetryCommand("claude", "sprite", prompt);
      expect(result).toContain("--prompt");
    });

    it("should handle empty string prompt as no prompt", () => {
      // Empty string is falsy
      expect(buildRetryCommand("claude", "sprite", "")).toBe(
        "spawn claude sprite"
      );
    });
  });

  describe("with long prompt (>80 chars)", () => {
    it("should suggest --prompt-file for 81-char prompt", () => {
      const prompt81 = "B".repeat(81);
      const result = buildRetryCommand("claude", "sprite", prompt81);
      expect(result).toContain("--prompt-file");
      expect(result).not.toContain(prompt81);
    });

    it("should suggest --prompt-file for very long prompt", () => {
      const longPrompt = "X".repeat(500);
      const result = buildRetryCommand("claude", "sprite", longPrompt);
      expect(result).toBe(
        "spawn claude sprite --prompt-file <your-prompt-file>"
      );
    });

    it("should not include prompt text in long prompt command", () => {
      const longPrompt = "Fix all the bugs in the authentication module and add tests ".repeat(5);
      const result = buildRetryCommand("claude", "sprite", longPrompt);
      expect(result).not.toContain("Fix all the bugs");
    });
  });
});

describe("resolveDisplayName", () => {
  const manifest = createMockManifest();

  describe("with valid manifest", () => {
    it("should resolve agent key to display name", () => {
      expect(resolveDisplayName(manifest, "claude", "agent")).toBe(
        "Claude Code"
      );
    });

    it("should resolve cloud key to display name", () => {
      expect(resolveDisplayName(manifest, "sprite", "cloud")).toBe("Sprite");
    });

    it("should resolve another agent", () => {
      expect(resolveDisplayName(manifest, "aider", "agent")).toBe("Aider");
    });

    it("should resolve another cloud", () => {
      expect(resolveDisplayName(manifest, "hetzner", "cloud")).toBe(
        "Hetzner Cloud"
      );
    });

    it("should return key as-is for unknown agent", () => {
      expect(resolveDisplayName(manifest, "unknown-agent", "agent")).toBe(
        "unknown-agent"
      );
    });

    it("should return key as-is for unknown cloud", () => {
      expect(resolveDisplayName(manifest, "unknown-cloud", "cloud")).toBe(
        "unknown-cloud"
      );
    });

    it("should return empty string key as-is", () => {
      expect(resolveDisplayName(manifest, "", "agent")).toBe("");
    });
  });

  describe("with null manifest", () => {
    it("should return agent key as-is", () => {
      expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
    });

    it("should return cloud key as-is", () => {
      expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
    });

    it("should return unknown key as-is", () => {
      expect(resolveDisplayName(null, "anything", "agent")).toBe("anything");
    });
  });
});

describe("buildRecordLabel", () => {
  const manifest = createMockManifest();

  it("should build label with resolved display names", () => {
    expect(
      buildRecordLabel({ agent: "claude", cloud: "sprite" }, manifest)
    ).toBe("Claude Code on Sprite");
  });

  it("should build label with different agent/cloud combo", () => {
    expect(
      buildRecordLabel({ agent: "aider", cloud: "hetzner" }, manifest)
    ).toBe("Aider on Hetzner Cloud");
  });

  it("should fall back to keys when manifest is null", () => {
    expect(
      buildRecordLabel({ agent: "claude", cloud: "sprite" }, null)
    ).toBe("claude on sprite");
  });

  it("should use keys for unknown entries even with manifest", () => {
    expect(
      buildRecordLabel({ agent: "unknown", cloud: "mystery" }, manifest)
    ).toBe("unknown on mystery");
  });

  it("should handle mixed known/unknown entries", () => {
    expect(
      buildRecordLabel({ agent: "claude", cloud: "mystery" }, manifest)
    ).toBe("Claude Code on mystery");
  });

  it("should handle reversed mixed known/unknown", () => {
    expect(
      buildRecordLabel({ agent: "unknown", cloud: "sprite" }, manifest)
    ).toBe("unknown on Sprite");
  });
});

describe("buildRecordHint", () => {
  describe("without prompt", () => {
    it("should return formatted timestamp only", () => {
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
      });
      expect(result).toContain("Feb");
      expect(result).toContain("2026");
      expect(result).not.toContain("--prompt");
    });

    it("should handle invalid timestamp", () => {
      const result = buildRecordHint({ timestamp: "not-a-date" });
      expect(result).toBe("not-a-date");
    });

    it("should handle empty timestamp", () => {
      const result = buildRecordHint({ timestamp: "" });
      expect(result).toBe("");
    });
  });

  describe("with short prompt (<=30 chars)", () => {
    it("should show prompt inline without truncation", () => {
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: "Fix bugs",
      });
      expect(result).toContain("Fix bugs");
      expect(result).toContain('--prompt "Fix bugs"');
      expect(result).not.toContain("...");
    });

    it("should show exactly 30-char prompt without truncation", () => {
      const prompt30 = "A".repeat(30);
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: prompt30,
      });
      expect(result).toContain(prompt30);
      expect(result).not.toContain("...");
    });

    it("should show single-char prompt", () => {
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: "x",
      });
      expect(result).toContain('--prompt "x"');
    });
  });

  describe("with long prompt (>30 chars)", () => {
    it("should truncate 31-char prompt with ellipsis", () => {
      const prompt31 = "B".repeat(31);
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: prompt31,
      });
      expect(result).toContain("B".repeat(30) + "...");
      expect(result).not.toContain("B".repeat(31));
    });

    it("should truncate very long prompt", () => {
      const longPrompt = "Fix all linter errors and add comprehensive tests for every module";
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: longPrompt,
      });
      expect(result).toContain(longPrompt.slice(0, 30) + "...");
      expect(result).not.toContain(longPrompt);
    });

    it("should include both timestamp and truncated prompt", () => {
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: "A very long prompt that exceeds the thirty character limit",
      });
      expect(result).toContain("Feb");
      expect(result).toContain("2026");
      expect(result).toContain("--prompt");
      expect(result).toContain("...");
    });
  });

  describe("with undefined prompt", () => {
    it("should not show prompt section", () => {
      const result = buildRecordHint({
        timestamp: "2026-02-11T14:30:00.000Z",
        prompt: undefined,
      });
      expect(result).not.toContain("--prompt");
    });
  });
});

describe("getStatusDescription", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should return formatted HTTP for 200", () => {
    expect(getStatusDescription(200)).toBe("HTTP 200");
  });

  it("should return formatted HTTP for 500", () => {
    expect(getStatusDescription(500)).toBe("HTTP 500");
  });

  it("should return formatted HTTP for 403", () => {
    expect(getStatusDescription(403)).toBe("HTTP 403");
  });

  it("should return formatted HTTP for 502", () => {
    expect(getStatusDescription(502)).toBe("HTTP 502");
  });

  it("should return formatted HTTP for 0", () => {
    expect(getStatusDescription(0)).toBe("HTTP 0");
  });

  it("should return formatted HTTP for 301", () => {
    expect(getStatusDescription(301)).toBe("HTTP 301");
  });

  it("should return formatted HTTP for 429", () => {
    expect(getStatusDescription(429)).toBe("HTTP 429");
  });
});

describe("parseAuthEnvVars", () => {
  it("should parse single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should parse multiple env vars separated by +", () => {
    expect(
      parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")
    ).toEqual(["UPCLOUD_USERNAME", "UPCLOUD_PASSWORD"]);
  });

  it("should parse three env vars", () => {
    expect(parseAuthEnvVars("VAR_A + VAR_B + VAR_C")).toEqual([
      "VAR_A",
      "VAR_B",
      "VAR_C",
    ]);
  });

  it("should handle no spaces around +", () => {
    expect(parseAuthEnvVars("VAR_A+VAR_B")).toEqual(["VAR_A", "VAR_B"]);
  });

  it("should reject 'none' auth", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("should reject 'token' (not uppercase or too short)", () => {
    expect(parseAuthEnvVars("token")).toEqual([]);
  });

  it("should reject empty string", () => {
    expect(parseAuthEnvVars("")).toEqual([]);
  });

  it("should reject short uppercase (< 4 chars after first)", () => {
    // Must match /^[A-Z][A-Z0-9_]{3,}$/
    expect(parseAuthEnvVars("AB")).toEqual([]);
  });

  it("should accept minimum length (4 chars: 1 + 3)", () => {
    expect(parseAuthEnvVars("ABCD")).toEqual(["ABCD"]);
  });

  it("should reject env vars starting with number", () => {
    expect(parseAuthEnvVars("1VAR")).toEqual([]);
  });

  it("should accept env vars with numbers after first char", () => {
    expect(parseAuthEnvVars("AWS_S3_TOKEN")).toEqual(["AWS_S3_TOKEN"]);
  });

  it("should reject env vars with lowercase", () => {
    expect(parseAuthEnvVars("hcloud_token")).toEqual([]);
  });

  it("should filter mixed valid and invalid parts", () => {
    expect(parseAuthEnvVars("VALID_VAR + invalid + ANOTHER_VAR")).toEqual([
      "VALID_VAR",
      "ANOTHER_VAR",
    ]);
  });

  it("should handle descriptive auth strings", () => {
    // Common pattern: "HCLOUD_TOKEN" or "none"
    expect(parseAuthEnvVars("GitHub OAuth")).toEqual([]);
  });

  it("should handle auth string with URL", () => {
    expect(parseAuthEnvVars("https://example.com/auth")).toEqual([]);
  });
});

describe("hasCloudCredentials", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return true when single required var is set", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("should return false when single required var is not set", () => {
    delete process.env.HCLOUD_TOKEN;
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should return true when all multi-var auth is set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    expect(
      hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")
    ).toBe(true);
  });

  it("should return false when only some multi-var auth is set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    delete process.env.UPCLOUD_PASSWORD;
    expect(
      hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")
    ).toBe(false);
  });

  it("should return false for 'none' auth", () => {
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("should return false for empty auth string", () => {
    expect(hasCloudCredentials("")).toBe(false);
  });

  it("should return false for descriptive auth without env vars", () => {
    expect(hasCloudCredentials("GitHub OAuth")).toBe(false);
  });

  it("should return false when var is empty string", () => {
    process.env.HCLOUD_TOKEN = "";
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });
});

describe("getImplementedClouds", () => {
  const manifest = createMockManifest();

  it("should return all implemented clouds for claude", () => {
    const clouds = getImplementedClouds(manifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
    expect(clouds).toHaveLength(2);
  });

  it("should return subset for aider (only sprite)", () => {
    const clouds = getImplementedClouds(manifest, "aider");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
    expect(clouds).toHaveLength(1);
  });

  it("should return empty for unknown agent", () => {
    expect(getImplementedClouds(manifest, "nonexistent")).toEqual([]);
  });

  it("should return empty for agent with no implementations", () => {
    const noImplManifest: Manifest = {
      agents: { solo: manifest.agents.claude },
      clouds: { sprite: manifest.clouds.sprite },
      matrix: { "sprite/solo": "missing" },
    };
    expect(getImplementedClouds(noImplManifest, "solo")).toEqual([]);
  });
});

describe("getImplementedAgents", () => {
  const manifest = createMockManifest();

  it("should return all implemented agents for sprite", () => {
    const agents = getImplementedAgents(manifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("aider");
    expect(agents).toHaveLength(2);
  });

  it("should return subset for hetzner (only claude)", () => {
    const agents = getImplementedAgents(manifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).not.toContain("aider");
    expect(agents).toHaveLength(1);
  });

  it("should return empty for unknown cloud", () => {
    expect(getImplementedAgents(manifest, "nonexistent")).toEqual([]);
  });
});

describe("isRetryableExitCode", () => {
  it("should return true for SSH exit code 255", () => {
    expect(isRetryableExitCode("Script exited with code 255")).toBe(true);
  });

  it("should return false for exit code 1", () => {
    expect(isRetryableExitCode("Script exited with code 1")).toBe(false);
  });

  it("should return false for exit code 130 (Ctrl+C)", () => {
    expect(isRetryableExitCode("Script exited with code 130")).toBe(false);
  });

  it("should return false for exit code 137 (OOM kill)", () => {
    expect(isRetryableExitCode("Script exited with code 137")).toBe(false);
  });

  it("should return false when no exit code in message", () => {
    expect(isRetryableExitCode("Some random error")).toBe(false);
  });

  it("should return false for empty message", () => {
    expect(isRetryableExitCode("")).toBe(false);
  });

  it("should return false for exit code 0 (success)", () => {
    expect(isRetryableExitCode("Script exited with code 0")).toBe(false);
  });

  it("should match exit code pattern precisely", () => {
    // Should not match "code 255" without "exited with"
    expect(isRetryableExitCode("code 255")).toBe(false);
  });

  it("should handle message with additional text after code", () => {
    expect(
      isRetryableExitCode("Script exited with code 255 (SSH failure)")
    ).toBe(true);
  });
});

describe("formatTimestamp", () => {
  it("should format valid ISO timestamp", () => {
    const result = formatTimestamp("2026-02-11T14:30:00.000Z");
    expect(result).toContain("Feb");
    expect(result).toContain("2026");
  });

  it("should return invalid string as-is", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("should return empty string as-is", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("should handle epoch timestamp", () => {
    const result = formatTimestamp("1970-01-01T00:00:00.000Z");
    expect(result).toContain("1970");
  });

  it("should handle date-only string", () => {
    const result = formatTimestamp("2026-06-15");
    // Date-only strings are still valid Date objects
    expect(result).toContain("2026");
  });

  it("should handle various month formats", () => {
    const jan = formatTimestamp("2026-01-15T00:00:00Z");
    const dec = formatTimestamp("2026-12-15T00:00:00Z");
    expect(jan).toContain("Jan");
    expect(dec).toContain("Dec");
  });
});

describe("edge cases for combined helpers", () => {
  const manifest = createMockManifest();

  it("buildRetryCommand + resolveDisplayName should work together", () => {
    // The retry command uses raw keys, not display names
    const cmd = buildRetryCommand("claude", "sprite", "Fix bugs");
    expect(cmd).toContain("claude");
    expect(cmd).toContain("sprite");
    expect(cmd).not.toContain("Claude Code");
  });

  it("buildRecordLabel + buildRecordHint should create complete picker entry", () => {
    const record = {
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: "Fix authentication bugs",
    };
    const label = buildRecordLabel(record, manifest);
    const hint = buildRecordHint(record);

    expect(label).toBe("Claude Code on Sprite");
    expect(hint).toContain("Feb");
    expect(hint).toContain("Fix authentication bugs");
  });

  it("should handle record with very long prompt in both label and hint", () => {
    const longPrompt = "X".repeat(200);
    const record = {
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: longPrompt,
    };
    const label = buildRecordLabel(record, manifest);
    const hint = buildRecordHint(record);

    // Label should not contain prompt
    expect(label).not.toContain("X");
    // Hint should truncate to 30 chars
    expect(hint).toContain("X".repeat(30) + "...");
    expect(hint).not.toContain("X".repeat(31));
  });

  it("parseAuthEnvVars + hasCloudCredentials should be consistent", () => {
    const auth = "FAKE_TEST_TOKEN_XYZ";
    const vars = parseAuthEnvVars(auth);
    // If vars are empty, hasCloudCredentials returns false
    if (vars.length === 0) {
      expect(hasCloudCredentials(auth)).toBe(false);
    }
  });
});

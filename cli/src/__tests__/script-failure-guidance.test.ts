import { describe, it, expect } from "bun:test";
import { getScriptFailureGuidance, getSignalGuidance, getStatusDescription, buildRetryCommand } from "../commands";

/**
 * Tests for getScriptFailureGuidance() in commands.ts.
 *
 * This function maps exit codes from failed spawn scripts to user-facing
 * guidance strings. It was recently modified (PRs #450, #449) but has
 * zero direct test coverage.
 *
 * Agent: test-engineer
 */

describe("getScriptFailureGuidance", () => {
  // ── Exit code 127: command not found ──────────────────────────────────────

  describe("exit code 127 (command not found)", () => {
    it("should return guidance about missing commands", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      expect(lines[0]).toContain("command was not found");
    });

    it("should list required tools: bash, curl, ssh, jq", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("bash");
      expect(joined).toContain("curl");
      expect(joined).toContain("ssh");
      expect(joined).toContain("jq");
    });

    it("should reference the cloud name for CLI tools", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn hetzner");
    });

    it("should embed a different cloud name when provided", () => {
      const lines = getScriptFailureGuidance(127, "vultr");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn vultr");
      expect(joined).not.toContain("spawn hetzner");
    });

    it("should return exactly 3 guidance lines", () => {
      const lines = getScriptFailureGuidance(127, "sprite");
      expect(lines).toHaveLength(3);
    });
  });

  // ── Exit code 126: permission denied ──────────────────────────────────────

  describe("exit code 126 (permission denied)", () => {
    it("should mention permission denied", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("permission denied");
    });

    it("should mention command could not be executed", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("could not be executed");
    });

    it("should suggest possible causes", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("execute permissions");
      expect(joined).toContain("root/sudo");
    });

    it("should include a link to report the issue", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("github.com");
      expect(joined).toContain("issues");
    });

    it("should return exactly 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      expect(lines).toHaveLength(4);
    });
  });

  // ── Exit code 1: generic failure ──────────────────────────────────────────

  describe("exit code 1 (generic failure)", () => {
    it("should start with Common causes", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should mention credentials", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      const joined = lines.join("\n");
      expect(joined).toContain("credentials");
    });

    it("should reference the cloud name for setup", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn digital-ocean");
    });

    it("should mention API error causes", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("API error");
      expect(joined).toContain("quota");
    });

    it("should mention server provisioning failure", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("provisioning failed");
    });

    it("should return at least 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ── Default case: unknown/other exit codes ────────────────────────────────

  describe("default case (unknown exit codes)", () => {
    it("should start with Common causes for unknown exit code", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should mention credentials for unknown exit code", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("credentials");
    });

    it("should mention rate limit or quota", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("rate limit");
      expect(joined).toContain("quota");
    });

    it("should mention missing local dependencies", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("SSH");
      expect(joined).toContain("curl");
      expect(joined).toContain("jq");
    });

    it("should reference the cloud name for setup instructions", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn linode");
    });

    it("should return at least 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ── null exit code (no exit code extracted) ───────────────────────────────

  describe("null exit code", () => {
    it("should fall through to default case", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should mention credentials", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("credentials");
    });

    it("should reference the cloud name", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn sprite");
    });

    it("should return at least 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ── Exit code 130: user interrupt (Ctrl+C) ────────────────────────────────

  describe("exit code 130 (user interrupt)", () => {
    it("should mention Ctrl+C", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("Ctrl+C");
    });

    it("should mention script was interrupted", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("interrupted");
    });

    it("should warn server may still be running", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("may still be running");
    });

    it("should suggest checking cloud provider dashboard", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("cloud provider dashboard");
    });

    it("should return exactly 3 guidance lines", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      expect(lines).toHaveLength(3);
    });
  });

  // ── Exit code 137: killed (OOM / timeout) ─────────────────────────────────

  describe("exit code 137 (killed)", () => {
    it("should mention script was killed", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("killed");
    });

    it("should mention timeout or out of memory", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("timeout");
      expect(joined).toContain("out of memory");
    });

    it("should suggest trying a larger instance", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("larger instance size");
    });

    it("should suggest checking cloud provider dashboard", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("cloud provider dashboard");
    });

    it("should return exactly 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      expect(lines).toHaveLength(4);
    });
  });

  // ── Exit code 255: SSH connection failed ───────────────────────────────────

  describe("exit code 255 (SSH failure)", () => {
    it("should mention SSH connection failed", () => {
      const lines = getScriptFailureGuidance(255, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("SSH connection failed");
    });

    it("should mention server still booting", () => {
      const lines = getScriptFailureGuidance(255, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("still booting");
    });

    it("should mention firewall blocking SSH", () => {
      const lines = getScriptFailureGuidance(255, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("Firewall");
      expect(joined).toContain("SSH");
    });

    it("should mention server termination", () => {
      const lines = getScriptFailureGuidance(255, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("terminated");
    });

    it("should return exactly 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(255, "sprite");
      expect(lines).toHaveLength(4);
    });
  });

  // ── Exit code 2: shell syntax error ────────────────────────────────────────

  describe("exit code 2 (shell syntax error)", () => {
    it("should mention shell syntax or argument error", () => {
      const lines = getScriptFailureGuidance(2, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("Shell syntax or argument error");
    });

    it("should suggest this is likely a bug in the script", () => {
      const lines = getScriptFailureGuidance(2, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("bug in the script");
    });

    it("should include a link to report the issue", () => {
      const lines = getScriptFailureGuidance(2, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("github.com");
      expect(joined).toContain("issues");
    });

    it("should return exactly 2 guidance lines", () => {
      const lines = getScriptFailureGuidance(2, "sprite");
      expect(lines).toHaveLength(2);
    });
  });

  // ── Auth hint parameter ──────────────────────────────────────────────────

  describe("auth hint parameter", () => {
    it("should show specific env var name and setup hint for exit code 1 when authHint is provided", () => {
      const savedOR = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        const lines = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
        const joined = lines.join("\n");
        expect(joined).toContain("HCLOUD_TOKEN");
        expect(joined).toContain("OPENROUTER_API_KEY");
        expect(joined).toContain("spawn hetzner");
        expect(joined).toContain("setup");
      } finally {
        if (savedOR !== undefined) process.env.OPENROUTER_API_KEY = savedOR;
      }
    });

    it("should show generic setup hint for exit code 1 when no authHint", () => {
      const lines = getScriptFailureGuidance(1, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn hetzner");
      expect(joined).not.toContain("HCLOUD_TOKEN");
    });

    it("should show specific env var name and setup hint for default case when authHint is provided", () => {
      const savedOR = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        const lines = getScriptFailureGuidance(42, "digitalocean", "DO_API_TOKEN");
        const joined = lines.join("\n");
        expect(joined).toContain("DO_API_TOKEN");
        expect(joined).toContain("OPENROUTER_API_KEY");
        expect(joined).toContain("spawn digitalocean");
        expect(joined).toContain("setup");
      } finally {
        if (savedOR !== undefined) process.env.OPENROUTER_API_KEY = savedOR;
      }
    });

    it("should show generic setup hint for default case when no authHint", () => {
      const lines = getScriptFailureGuidance(42, "digitalocean");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn digitalocean");
      expect(joined).not.toContain("DO_API_TOKEN");
    });

    it("should handle multi-credential auth hint", () => {
      const lines = getScriptFailureGuidance(1, "contabo", "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET");
      const joined = lines.join("\n");
      // Each credential var should be listed individually
      expect(joined).toContain("CONTABO_CLIENT_ID");
      expect(joined).toContain("CONTABO_CLIENT_SECRET");
    });

    it("should not affect non-credential exit codes (130, 137, etc.)", () => {
      const lines130 = getScriptFailureGuidance(130, "hetzner", "HCLOUD_TOKEN");
      const joined130 = lines130.join("\n");
      expect(joined130).not.toContain("HCLOUD_TOKEN");
      expect(joined130).toContain("Ctrl+C");

      const lines255 = getScriptFailureGuidance(255, "hetzner", "HCLOUD_TOKEN");
      const joined255 = lines255.join("\n");
      expect(joined255).not.toContain("HCLOUD_TOKEN");
      expect(joined255).toContain("SSH");
    });

    it("should include setup instruction line for exit code 1 with authHint", () => {
      const lines = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
      expect(lines.length).toBeGreaterThanOrEqual(5);
      const joined = lines.join("\n");
      expect(joined).toContain("spawn hetzner");
      expect(joined).toContain("setup");
    });

    it("should include setup instruction line for default case with authHint", () => {
      const lines = getScriptFailureGuidance(42, "hetzner", "HCLOUD_TOKEN");
      expect(lines.length).toBeGreaterThanOrEqual(5);
      const joined = lines.join("\n");
      expect(joined).toContain("spawn hetzner");
      expect(joined).toContain("setup");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle exit code 0 as default case", () => {
      const lines = getScriptFailureGuidance(0, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle negative exit code as default case", () => {
      const lines = getScriptFailureGuidance(-1, "hetzner");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle empty cloud name", () => {
      const lines = getScriptFailureGuidance(127, "");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn ");
    });

    it("should handle cloud name with special characters", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn digital-ocean");
    });
  });

  // ── Return type and structure ─────────────────────────────────────────────

  describe("return type and structure", () => {
    it("should always return an array of strings", () => {
      const codes: (number | null)[] = [0, 1, 2, 126, 127, 130, 137, 255, null];
      for (const code of codes) {
        const lines = getScriptFailureGuidance(code, "sprite");
        expect(Array.isArray(lines)).toBe(true);
        for (const line of lines) {
          expect(typeof line).toBe("string");
        }
      }
    });

    it("should never return an empty array", () => {
      const codes: (number | null)[] = [0, 1, 2, 126, 127, 130, 255, null, -1];
      for (const code of codes) {
        const lines = getScriptFailureGuidance(code, "sprite");
        expect(lines.length).toBeGreaterThan(0);
      }
    });

    it("should produce different output for each handled exit code", () => {
      const result130 = getScriptFailureGuidance(130, "sprite");
      const result137 = getScriptFailureGuidance(137, "sprite");
      const result255 = getScriptFailureGuidance(255, "sprite");
      const result127 = getScriptFailureGuidance(127, "sprite");
      const result126 = getScriptFailureGuidance(126, "sprite");
      const result2 = getScriptFailureGuidance(2, "sprite");
      const result1 = getScriptFailureGuidance(1, "sprite");
      const resultDefault = getScriptFailureGuidance(42, "sprite");

      const all = [result130, result137, result255, result127, result126, result2, result1, resultDefault];
      // Every handled exit code should produce unique output
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          expect(all[i].join("\n")).not.toBe(all[j].join("\n"));
        }
      }
    });
  });
});

describe("getSignalGuidance", () => {
  describe("SIGKILL", () => {
    it("should mention OOM killer", () => {
      const lines = getSignalGuidance("SIGKILL");
      const joined = lines.join("\n");
      expect(joined).toContain("SIGKILL");
      expect(joined).toContain("Out of memory");
    });

    it("should suggest a larger instance size", () => {
      const lines = getSignalGuidance("SIGKILL");
      const joined = lines.join("\n");
      expect(joined).toContain("larger instance size");
    });

    it("should suggest checking cloud provider dashboard", () => {
      const lines = getSignalGuidance("SIGKILL");
      const joined = lines.join("\n");
      expect(joined).toContain("cloud provider dashboard");
    });
  });

  describe("SIGTERM", () => {
    it("should mention process was terminated", () => {
      const lines = getSignalGuidance("SIGTERM");
      const joined = lines.join("\n");
      expect(joined).toContain("terminated");
      expect(joined).toContain("SIGTERM");
    });

    it("should mention server shutdown or billing", () => {
      const lines = getSignalGuidance("SIGTERM");
      const joined = lines.join("\n");
      expect(joined).toContain("shutdown");
    });
  });

  describe("SIGINT", () => {
    it("should mention Ctrl+C", () => {
      const lines = getSignalGuidance("SIGINT");
      const joined = lines.join("\n");
      expect(joined).toContain("Ctrl+C");
    });

    it("should warn about orphaned servers", () => {
      const lines = getSignalGuidance("SIGINT");
      const joined = lines.join("\n");
      expect(joined).toContain("cloud provider dashboard");
    });
  });

  describe("SIGHUP", () => {
    it("should mention terminal disconnection", () => {
      const lines = getSignalGuidance("SIGHUP");
      const joined = lines.join("\n");
      expect(joined).toContain("terminal connection");
      expect(joined).toContain("SIGHUP");
    });

    it("should suggest tmux/screen", () => {
      const lines = getSignalGuidance("SIGHUP");
      const joined = lines.join("\n");
      expect(joined).toContain("tmux");
    });
  });

  describe("unknown signal", () => {
    it("should show the signal name for unknown signals", () => {
      const lines = getSignalGuidance("SIGUSR1");
      const joined = lines.join("\n");
      expect(joined).toContain("SIGUSR1");
    });

    it("should always return a non-empty array", () => {
      const lines = getSignalGuidance("SIGFOO");
      expect(lines.length).toBeGreaterThan(0);
    });
  });

  describe("return type", () => {
    it("should always return string arrays", () => {
      const signals = ["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGUSR1"];
      for (const sig of signals) {
        const lines = getSignalGuidance(sig);
        expect(Array.isArray(lines)).toBe(true);
        for (const line of lines) {
          expect(typeof line).toBe("string");
        }
      }
    });

    it("should produce different output for each handled signal", () => {
      const sigkill = getSignalGuidance("SIGKILL").join("\n");
      const sigterm = getSignalGuidance("SIGTERM").join("\n");
      const sigint = getSignalGuidance("SIGINT").join("\n");
      const sighup = getSignalGuidance("SIGHUP").join("\n");
      expect(sigkill).not.toBe(sigterm);
      expect(sigterm).not.toBe(sigint);
      expect(sigint).not.toBe(sighup);
    });
  });
});

describe("buildRetryCommand", () => {
  it("should return simple command without prompt", () => {
    expect(buildRetryCommand("claude", "sprite")).toBe("spawn claude sprite");
  });

  it("should include --prompt when prompt is provided", () => {
    expect(buildRetryCommand("claude", "sprite", "Fix all bugs")).toBe(
      'spawn claude sprite --prompt "Fix all bugs"'
    );
  });

  it("should suggest --prompt-file for long prompts instead of truncating", () => {
    const longPrompt = "A".repeat(100);
    const result = buildRetryCommand("claude", "sprite", longPrompt);
    expect(result).toBe("spawn claude sprite --prompt-file <your-prompt-file>");
    expect(result).not.toContain("A"); // no truncated prompt content
  });

  it("should include full prompt at exactly 80 characters", () => {
    const exactPrompt = "B".repeat(80);
    const result = buildRetryCommand("aider", "hetzner", exactPrompt);
    expect(result).toBe(`spawn aider hetzner --prompt "${exactPrompt}"`);
    expect(result).not.toContain("prompt-file");
  });

  it("should suggest --prompt-file for prompts over 80 characters", () => {
    const longPrompt = "C".repeat(81);
    const result = buildRetryCommand("aider", "hetzner", longPrompt);
    expect(result).toBe("spawn aider hetzner --prompt-file <your-prompt-file>");
  });

  it("should escape double quotes in prompt", () => {
    const result = buildRetryCommand("claude", "sprite", 'Fix "all" bugs');
    expect(result).toBe('spawn claude sprite --prompt "Fix \\"all\\" bugs"');
  });

  it("should return simple command when prompt is undefined", () => {
    expect(buildRetryCommand("aider", "vultr", undefined)).toBe("spawn aider vultr");
  });

  it("should return simple command when prompt is empty string", () => {
    expect(buildRetryCommand("aider", "vultr", "")).toBe("spawn aider vultr");
  });
});

describe("dashboard URL in guidance", () => {
  describe("getScriptFailureGuidance with dashboardUrl", () => {
    it("should include dashboard URL for exit code 1 when provided", () => {
      const lines = getScriptFailureGuidance(1, "hetzner", undefined, "https://console.hetzner.cloud/");
      const joined = lines.join("\n");
      expect(joined).toContain("https://console.hetzner.cloud/");
      expect(joined).toContain("dashboard");
    });

    it("should include dashboard URL for exit code 130 when provided", () => {
      const lines = getScriptFailureGuidance(130, "sprite", undefined, "https://sprite.sh");
      const joined = lines.join("\n");
      expect(joined).toContain("https://sprite.sh");
      expect(joined).toContain("dashboard");
    });

    it("should include dashboard URL for exit code 137 when provided", () => {
      const lines = getScriptFailureGuidance(137, "vultr", undefined, "https://my.vultr.com/");
      const joined = lines.join("\n");
      expect(joined).toContain("https://my.vultr.com/");
    });

    it("should include dashboard URL for default exit code when provided", () => {
      const lines = getScriptFailureGuidance(42, "digitalocean", undefined, "https://cloud.digitalocean.com/");
      const joined = lines.join("\n");
      expect(joined).toContain("https://cloud.digitalocean.com/");
    });

    it("should fall back to generic message when no dashboardUrl", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("cloud provider dashboard");
      expect(joined).not.toContain("https://");
    });

    it("should not add dashboard URL for exit codes 127, 126, 255, 2", () => {
      for (const code of [127, 126, 255, 2]) {
        const lines = getScriptFailureGuidance(code, "hetzner", undefined, "https://console.hetzner.cloud/");
        const joined = lines.join("\n");
        expect(joined).not.toContain("https://console.hetzner.cloud/");
      }
    });
  });

  describe("getSignalGuidance with dashboardUrl", () => {
    it("should include dashboard URL for SIGKILL when provided", () => {
      const lines = getSignalGuidance("SIGKILL", "https://console.hetzner.cloud/");
      const joined = lines.join("\n");
      expect(joined).toContain("https://console.hetzner.cloud/");
      expect(joined).toContain("dashboard");
    });

    it("should include dashboard URL for SIGTERM when provided", () => {
      const lines = getSignalGuidance("SIGTERM", "https://my.vultr.com/");
      const joined = lines.join("\n");
      expect(joined).toContain("https://my.vultr.com/");
    });

    it("should include dashboard URL for SIGINT when provided", () => {
      const lines = getSignalGuidance("SIGINT", "https://cloud.digitalocean.com/");
      const joined = lines.join("\n");
      expect(joined).toContain("https://cloud.digitalocean.com/");
    });

    it("should fall back to generic message when no dashboardUrl", () => {
      const lines = getSignalGuidance("SIGKILL");
      const joined = lines.join("\n");
      expect(joined).toContain("cloud provider dashboard");
      expect(joined).not.toContain("https://");
    });

    it("should not add dashboard URL for SIGHUP", () => {
      const lines = getSignalGuidance("SIGHUP", "https://example.com");
      const joined = lines.join("\n");
      expect(joined).not.toContain("https://example.com");
    });
  });
});

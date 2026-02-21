import { describe, it, expect, beforeEach } from "bun:test";

// Import modules under test — these are pure functions, no side effects
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  jsonEscape,
  validateServerName,
  validateRegionName,
  validateModelId,
  toKebabCase,
} from "../../../fly/lib/ui";

import { sanitizeFlyToken } from "../../../fly/lib/fly";

import { generateEnvConfig, resolveAgent, agents } from "../../../fly/lib/agents";

// ─── ui.ts tests ─────────────────────────────────────────────────────────────

describe("fly/lib/ui", () => {
  describe("jsonEscape", () => {
    it("escapes simple strings", () => {
      expect(jsonEscape("hello")).toBe('"hello"');
    });
    it("escapes quotes", () => {
      expect(jsonEscape('say "hi"')).toBe('"say \\"hi\\""');
    });
    it("escapes backslashes", () => {
      expect(jsonEscape("a\\b")).toBe('"a\\\\b"');
    });
    it("escapes newlines", () => {
      expect(jsonEscape("a\nb")).toBe('"a\\nb"');
    });
    it("handles empty string", () => {
      expect(jsonEscape("")).toBe('""');
    });
  });

  describe("validateServerName", () => {
    it("accepts valid names", () => {
      expect(validateServerName("my-server")).toBe(true);
      expect(validateServerName("dev-box-01")).toBe(true);
      expect(validateServerName("abc")).toBe(true);
    });
    it("rejects too short", () => {
      expect(validateServerName("ab")).toBe(false);
    });
    it("rejects too long", () => {
      expect(validateServerName("a".repeat(64))).toBe(false);
    });
    it("rejects leading dash", () => {
      expect(validateServerName("-abc")).toBe(false);
    });
    it("rejects trailing dash", () => {
      expect(validateServerName("abc-")).toBe(false);
    });
    it("rejects special characters", () => {
      expect(validateServerName("my_server")).toBe(false);
      expect(validateServerName("my.server")).toBe(false);
      expect(validateServerName("my server")).toBe(false);
    });
  });

  describe("validateRegionName", () => {
    it("accepts valid regions", () => {
      expect(validateRegionName("iad")).toBe(true);
      expect(validateRegionName("us-east-1")).toBe(true);
      expect(validateRegionName("eu_west_2")).toBe(true);
    });
    it("rejects empty", () => {
      expect(validateRegionName("")).toBe(false);
    });
    it("rejects special chars", () => {
      expect(validateRegionName("us east")).toBe(false);
    });
  });

  describe("validateModelId", () => {
    it("accepts valid model IDs", () => {
      expect(validateModelId("anthropic/claude-3.5-sonnet")).toBe(true);
      expect(validateModelId("openai/gpt-4-turbo")).toBe(true);
      expect(validateModelId("openrouter/auto")).toBe(true);
    });
    it("accepts empty (optional)", () => {
      expect(validateModelId("")).toBe(true);
    });
    it("rejects shell metacharacters", () => {
      expect(validateModelId("model;rm -rf /")).toBe(false);
      expect(validateModelId("model$(whoami)")).toBe(false);
    });
  });

  describe("toKebabCase", () => {
    it("converts display names", () => {
      expect(toKebabCase("My Dev Box")).toBe("my-dev-box");
      expect(toKebabCase("Claude 2024!")).toBe("claude-2024");
    });
    it("deduplicates dashes", () => {
      expect(toKebabCase("a--b")).toBe("a-b");
    });
    it("handles empty string", () => {
      expect(toKebabCase("")).toBe("");
    });
  });
});

// ─── fly.ts tests ────────────────────────────────────────────────────────────

describe("fly/lib/fly", () => {
  describe("sanitizeFlyToken", () => {
    it("passes through plain tokens", () => {
      expect(sanitizeFlyToken("FlyV1 abc123")).toBe("FlyV1 abc123");
    });
    it("extracts FlyV1 from noisy input", () => {
      expect(sanitizeFlyToken("some-name FlyV1 abc123")).toBe("FlyV1 abc123");
    });
    it("wraps fm2_ tokens with FlyV1", () => {
      expect(sanitizeFlyToken("fm2_abc123")).toBe("FlyV1 fm2_abc123");
    });
    it("wraps fm2_ tokens with prefix text", () => {
      expect(sanitizeFlyToken("deploy token fm2_abc123 extra")).toBe(
        "FlyV1 fm2_abc123",
      );
    });
    it("wraps m2. tokens with FlyV1", () => {
      expect(sanitizeFlyToken("m2.abc")).toBe("FlyV1 m2.abc");
    });
    it("trims whitespace", () => {
      expect(sanitizeFlyToken("  bearer-token  ")).toBe("bearer-token");
    });
    it("strips newlines", () => {
      expect(sanitizeFlyToken("token\n\r")).toBe("token");
    });
  });
});

// ─── agents.ts tests ─────────────────────────────────────────────────────────

describe("fly/lib/agents", () => {
  describe("generateEnvConfig", () => {
    it("generates export lines", () => {
      const result = generateEnvConfig(["OPENROUTER_API_KEY=sk-test", "FOO=bar"]);
      expect(result).toContain("export IS_SANDBOX='1'");
      expect(result).toContain("export OPENROUTER_API_KEY='sk-test'");
      expect(result).toContain("export FOO='bar'");
    });

    it("escapes single quotes in values", () => {
      const result = generateEnvConfig(["FOO=it's"]);
      expect(result).toContain("export FOO='it'\\''s'");
    });

    it("rejects invalid env var names", () => {
      const result = generateEnvConfig(["invalid-name=val"]);
      expect(result).not.toContain("invalid-name");
    });

    it("allows empty values", () => {
      const result = generateEnvConfig(["ANTHROPIC_API_KEY="]);
      expect(result).toContain("export ANTHROPIC_API_KEY=''");
    });
  });

  describe("resolveAgent", () => {
    it("resolves known agents by name", () => {
      expect(resolveAgent("claude").name).toBe("Claude Code");
      expect(resolveAgent("codex").name).toBe("Codex CLI");
      expect(resolveAgent("openclaw").name).toBe("OpenClaw");
      expect(resolveAgent("opencode").name).toBe("OpenCode");
      expect(resolveAgent("kilocode").name).toBe("Kilo Code");
      expect(resolveAgent("zeroclaw").name).toBe("ZeroClaw");
    });

    it("is case-insensitive", () => {
      expect(resolveAgent("Claude").name).toBe("Claude Code");
      expect(resolveAgent("CODEX").name).toBe("Codex CLI");
    });

    it("throws for unknown agents", () => {
      expect(() => resolveAgent("nonexistent")).toThrow("Unknown agent");
    });
  });

  describe("agent configs", () => {
    it("all agents have required fields", () => {
      for (const [key, agent] of Object.entries(agents)) {
        expect(agent.name).toBeTruthy();
        expect(typeof agent.install).toBe("function");
        expect(typeof agent.envVars).toBe("function");
        expect(typeof agent.launchCmd).toBe("function");
      }
    });

    it("claude envVars include OpenRouter config", () => {
      const vars = agents.claude.envVars("sk-test");
      expect(vars).toContain("OPENROUTER_API_KEY=sk-test");
      expect(vars).toContain("ANTHROPIC_BASE_URL=https://openrouter.ai/api");
      expect(vars).toContain("ANTHROPIC_AUTH_TOKEN=sk-test");
    });

    it("openclaw has model prompt enabled", () => {
      expect(agents.openclaw.modelPrompt).toBe(true);
      expect(agents.openclaw.modelDefault).toBe("openrouter/auto");
    });

    it("openclaw has 2048MB memory", () => {
      expect(agents.openclaw.vmMemory).toBe(2048);
    });

    it("kilocode envVars include provider type", () => {
      const vars = agents.kilocode.envVars("sk-test");
      expect(vars).toContain("KILO_PROVIDER_TYPE=openrouter");
      expect(vars).toContain("KILO_OPEN_ROUTER_API_KEY=sk-test");
    });

    it("zeroclaw envVars include provider", () => {
      const vars = agents.zeroclaw.envVars("sk-test");
      expect(vars).toContain("ZEROCLAW_PROVIDER=openrouter");
    });

    it("claude launch command sources .spawnrc", () => {
      expect(agents.claude.launchCmd()).toContain("source ~/.spawnrc");
      expect(agents.claude.launchCmd()).toContain("claude");
    });

    it("codex launch command launches codex", () => {
      expect(agents.codex.launchCmd()).toContain("codex");
    });

    it("openclaw launch command launches openclaw tui", () => {
      expect(agents.openclaw.launchCmd()).toContain("openclaw tui");
    });

    it("zeroclaw launch command sources cargo env", () => {
      expect(agents.zeroclaw.launchCmd()).toContain("source ~/.cargo/env");
      expect(agents.zeroclaw.launchCmd()).toContain("zeroclaw agent");
    });
  });
});

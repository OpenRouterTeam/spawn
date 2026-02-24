import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { credentialHints } from "../commands";

/**
 * Tests for credentialHints() env-var-aware credential status.
 *
 * credentialHints now checks which required env vars are actually set
 * and gives specific feedback about which are missing vs present.
 *
 * Agent: ux-engineer
 */

describe("credentialHints", () => {
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
    // Clear saved env for next test
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  describe("when no authHint is provided", () => {
    it("returns generic setup hint", () => {
      const hints = credentialHints("sprite");
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("credentials");
      expect(hints[0]).toContain("spawn sprite");
    });

    it("uses custom verb", () => {
      const hints = credentialHints("sprite", undefined, "Missing");
      expect(hints[0]).toContain("Missing");
    });
  });

  describe("when all required env vars are missing", () => {
    beforeEach(() => {
      unsetEnv("HCLOUD_TOKEN");
      unsetEnv("OPENROUTER_API_KEY");
    });

    it("shows each missing var individually", () => {
      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");
      expect(joined).toContain("Missing credentials");
      expect(joined).toContain("HCLOUD_TOKEN");
      expect(joined).toContain("not set");
      expect(joined).toContain("OPENROUTER_API_KEY");
      expect(joined).toContain("spawn hetzner");
      expect(joined).toContain("setup instructions");
    });

    it("lists all missing vars for multi-credential clouds", () => {
      unsetEnv("UPCLOUD_USERNAME");
      unsetEnv("UPCLOUD_PASSWORD");
      const hints = credentialHints("upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
      const joined = hints.join("\n");
      expect(joined).toContain("UPCLOUD_USERNAME");
      expect(joined).toContain("UPCLOUD_PASSWORD");
      expect(joined).toContain("OPENROUTER_API_KEY");
    });
  });

  describe("when all required env vars are set", () => {
    it("reports credentials appear set and suggests they may be invalid", () => {
      setEnv("HCLOUD_TOKEN", "test-token");
      setEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");
      expect(joined).toContain("Credentials appear to be set");
      expect(joined).toContain("invalid or expired");
      expect(joined).toContain("spawn hetzner");
    });

    it("lists the env var names when all are set", () => {
      setEnv("HCLOUD_TOKEN", "test-token");
      setEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");
      expect(joined).toContain("HCLOUD_TOKEN");
      expect(joined).toContain("OPENROUTER_API_KEY");
    });
  });

  describe("when some env vars are set and some missing", () => {
    it("shows only the missing vars", () => {
      setEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
      unsetEnv("HCLOUD_TOKEN");
      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");
      expect(joined).toContain("Missing credentials");
      expect(joined).toContain("HCLOUD_TOKEN");
      expect(joined).toContain("not set");
      // OPENROUTER_API_KEY is set, so it should NOT appear as missing
      expect(joined).not.toContain("OPENROUTER_API_KEY -- not set");
    });

    it("shows only OPENROUTER_API_KEY when cloud auth is set", () => {
      setEnv("HCLOUD_TOKEN", "test-token");
      unsetEnv("OPENROUTER_API_KEY");
      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");
      expect(joined).toContain("Missing credentials");
      expect(joined).toContain("OPENROUTER_API_KEY");
      expect(joined).toContain("not set");
      expect(joined).not.toContain("HCLOUD_TOKEN -- not set");
    });

    it("handles partial multi-credential setup", () => {
      setEnv("UPCLOUD_USERNAME", "user");
      unsetEnv("UPCLOUD_PASSWORD");
      setEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
      const hints = credentialHints("upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
      const joined = hints.join("\n");
      expect(joined).toContain("UPCLOUD_PASSWORD");
      expect(joined).toContain("not set");
      // Set vars should not appear as missing
      expect(joined).not.toContain("UPCLOUD_USERNAME -- not set");
      expect(joined).not.toContain("OPENROUTER_API_KEY -- not set");
    });
  });

  describe("integration with getScriptFailureGuidance", () => {
    it("always includes setup instructions regardless of env state", () => {
      const hints = credentialHints("digitalocean", "DO_API_TOKEN");
      const joined = hints.join("\n");
      expect(joined).toContain("setup instructions");
    });

    it("always returns at least one line", () => {
      const hints = credentialHints("sprite");
      expect(hints.length).toBeGreaterThanOrEqual(1);
    });

    it("returns more lines when authHint is provided", () => {
      const withHint = credentialHints("hetzner", "HCLOUD_TOKEN");
      const withoutHint = credentialHints("hetzner");
      expect(withHint.length).toBeGreaterThan(withoutHint.length);
    });
  });
});

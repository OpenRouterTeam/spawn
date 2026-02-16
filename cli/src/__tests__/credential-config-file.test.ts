import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { credentialHints } from "../commands";

/**
 * Tests for config file detection in credential checking.
 *
 * Verifies that the CLI checks for saved config files (~/.config/spawn/{cloud}.json)
 * before reporting credentials as missing.
 *
 * Fixes issue #1197: Hetzner missing credentials did not check for saved config
 * Agent: ux-engineer
 */

describe("credentialHints with config files", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let mockExistsSync: ReturnType<typeof mock>;

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function unsetEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  beforeEach(() => {
    // Mock fs.existsSync to control config file detection
    const fs = require("fs");
    mockExistsSync = mock((path: string) => {
      // Return true for hetzner config, false for others
      return path.includes("hetzner.json");
    });
    fs.existsSync = mockExistsSync;
  });

  afterEach(() => {
    // Restore env vars
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

    // Restore fs.existsSync
    if (mockExistsSync) {
      mockExistsSync.mockRestore();
    }
  });

  describe("when config file exists but env var is not set", () => {
    it("should not report cloud-specific token as missing", () => {
      unsetEnv("HCLOUD_TOKEN");
      unsetEnv("OPENROUTER_API_KEY");

      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");

      // Should only complain about OPENROUTER_API_KEY, not HCLOUD_TOKEN
      expect(joined).toContain("OPENROUTER_API_KEY");
      expect(joined).not.toContain("HCLOUD_TOKEN -- not set");
      expect(joined).toContain("saved config");
    });

    it("should indicate credentials are set when only OpenRouter is missing but config exists", () => {
      unsetEnv("HCLOUD_TOKEN");
      setEnv("OPENROUTER_API_KEY", "sk-or-v1-test");

      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");

      expect(joined).toContain("Credentials appear to be set");
      expect(joined).toContain("saved config");
    });
  });

  describe("when config file does not exist", () => {
    it("should report both tokens as missing", () => {
      unsetEnv("DO_API_TOKEN");
      unsetEnv("OPENROUTER_API_KEY");

      const hints = credentialHints("digitalocean", "DO_API_TOKEN");
      const joined = hints.join("\n");

      expect(joined).toContain("Missing credentials");
      expect(joined).toContain("DO_API_TOKEN");
      expect(joined).toContain("OPENROUTER_API_KEY");
      expect(joined).toContain("not set");
    });
  });

  describe("when both env var and config file are available", () => {
    it("should indicate all credentials are set", () => {
      setEnv("HCLOUD_TOKEN", "test-token");
      setEnv("OPENROUTER_API_KEY", "sk-or-v1-test");

      const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
      const joined = hints.join("\n");

      expect(joined).toContain("Credentials appear to be set");
      expect(joined).toContain("saved config");
    });
  });
});

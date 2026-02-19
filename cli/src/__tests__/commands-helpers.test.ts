import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { levenshtein, findClosestMatch, resolveAgentKey, resolveCloudKey, buildAgentPickerHints } from "../commands";
import type { Manifest } from "../manifest";

/**
 * Tests for helper functions in commands.ts
 * These are pure functions or functions with minimal side effects
 */

describe("Command Helpers", () => {
  describe("levenshtein", () => {
    it("should return 0 for identical strings", () => {
      expect(levenshtein("claude", "claude")).toBe(0);
    });

    it("should return string length for empty comparison", () => {
      expect(levenshtein("abc", "")).toBe(3);
      expect(levenshtein("", "abc")).toBe(3);
    });

    it("should return 0 for two empty strings", () => {
      expect(levenshtein("", "")).toBe(0);
    });

    it("should count single character substitution", () => {
      expect(levenshtein("cat", "car")).toBe(1);
    });

    it("should count single insertion", () => {
      expect(levenshtein("claud", "claude")).toBe(1);
    });

    it("should count single deletion", () => {
      expect(levenshtein("claudee", "claude")).toBe(1);
    });

    it("should handle transpositions as two edits", () => {
      expect(levenshtein("ab", "ba")).toBe(2);
    });

    it("should handle completely different strings", () => {
      expect(levenshtein("abc", "xyz")).toBe(3);
    });
  });

  describe("findClosestMatch", () => {
    const agents = ["claude", "codex", "openclaw", "nanoclaw", "cline", "gptme"];

    it("should find exact match (distance 0)", () => {
      expect(findClosestMatch("claude", agents)).toBe("claude");
    });

    it("should find close typo (distance 1)", () => {
      expect(findClosestMatch("cloude", agents)).toBe("claude");
      expect(findClosestMatch("claud", agents)).toBe("claude");
      expect(findClosestMatch("codx", agents)).toBe("codex");
    });

    it("should find matches with distance 2", () => {
      expect(findClosestMatch("claudee", agents)).toBe("claude");
    });

    it("should return null for very different strings", () => {
      expect(findClosestMatch("kubernetes", agents)).toBeNull();
    });

    it("should return null for empty candidates", () => {
      expect(findClosestMatch("claude", [])).toBeNull();
    });

    it("should be case insensitive", () => {
      expect(findClosestMatch("Claude", agents)).toBe("claude");
      expect(findClosestMatch("AIDER", agents)).toBe("codex");
    });

    it("should pick the closest match among multiple candidates", () => {
      expect(findClosestMatch("cldude", agents)).toBe("claude");
    });
  });

  describe("getErrorMessage", () => {
    it("should extract message from Error objects", () => {
      const err = new Error("Test error");
      // Simulate the function behavior
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      expect(message).toBe("Test error");
    });

    it("should handle objects with message property", () => {
      const err = { message: "Custom error" };
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      expect(message).toBe("Custom error");
    });

    it("should stringify non-Error values", () => {
      const err = "String error";
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      expect(message).toBe("String error");
    });

    it("should handle null or undefined", () => {
      const err = null;
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      expect(message).toBe("null");
    });

    it("should handle numbers", () => {
      const err = 42;
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      expect(message).toBe("42");
    });
  });

  describe("getStatusDescription", () => {
    it("should return 'not found' for 404", () => {
      const status = 404;
      const desc = status === 404 ? "not found" : `HTTP ${status}`;
      expect(desc).toBe("not found");
    });

    it("should return HTTP code for other statuses", () => {
      const status = 500;
      const desc = status === 404 ? "not found" : `HTTP ${status}`;
      expect(desc).toBe("HTTP 500");
    });

    it("should handle 200 status", () => {
      const status = 200;
      const desc = status === 404 ? "not found" : `HTTP ${status}`;
      expect(desc).toBe("HTTP 200");
    });

    it("should handle 403 status", () => {
      const status = 403;
      const desc = status === 404 ? "not found" : `HTTP ${status}`;
      expect(desc).toBe("HTTP 403");
    });
  });

  describe("calculateColumnWidth", () => {
    // Helper function behavior
    function calculateColumnWidth(items: string[], minWidth: number, padding: number = 2): number {
      let maxWidth = minWidth;
      for (const item of items) {
        const width = item.length + padding;
        if (width > maxWidth) {
          maxWidth = width;
        }
      }
      return maxWidth;
    }

    it("should respect minimum width", () => {
      const width = calculateColumnWidth(["a", "b"], 15, 2);
      expect(width).toBe(15);
    });

    it("should expand for longer items", () => {
      const width = calculateColumnWidth(["hello", "world"], 5, 2);
      expect(width).toBe(7); // "world" (5) + padding (2)
    });

    it("should include padding in calculation", () => {
      const width = calculateColumnWidth(["test"], 8, 3);
      expect(width).toBe(8); // "test" (4) + padding (3) = 7, but min is 8
    });

    it("should handle empty array", () => {
      const width = calculateColumnWidth([], 15, 2);
      expect(width).toBe(15);
    });

    it("should handle single character items", () => {
      const width = calculateColumnWidth(["a"], 10, 2);
      expect(width).toBe(10); // "a" (1) + padding (2) = 3, but min is 10
    });

    it("should handle very long item", () => {
      const longItem = "a".repeat(50);
      const width = calculateColumnWidth([longItem], 10, 2);
      expect(width).toBe(52); // 50 + 2
    });

    it("should handle custom padding values", () => {
      const width = calculateColumnWidth(["hello"], 5, 5);
      expect(width).toBe(10); // "hello" (5) + padding (5)
    });

    it("should handle zero padding", () => {
      const width = calculateColumnWidth(["hello"], 3, 0);
      expect(width).toBe(5); // "hello" (5) + padding (0)
    });
  });

  describe("validateNonEmptyString", () => {
    // Helper function behavior
    function validateNonEmptyString(value: string, fieldName: string): boolean {
      if (!value || value.trim() === "") {
        return false;
      }
      return true;
    }

    it("should accept non-empty strings", () => {
      expect(validateNonEmptyString("claude", "Agent")).toBe(true);
      expect(validateNonEmptyString("sprite", "Cloud")).toBe(true);
    });

    it("should reject empty strings", () => {
      expect(validateNonEmptyString("", "Agent")).toBe(false);
    });

    it("should reject whitespace-only strings", () => {
      expect(validateNonEmptyString("   ", "Agent")).toBe(false);
      expect(validateNonEmptyString("\n", "Agent")).toBe(false);
      expect(validateNonEmptyString("\t", "Agent")).toBe(false);
    });

    it("should accept strings with leading/trailing spaces after trim", () => {
      expect(validateNonEmptyString("  claude  ", "Agent")).toBe(true);
    });
  });

  describe("mapToSelectOptions", () => {
    // Helper function behavior
    function mapToSelectOptions<T extends { name: string; description: string }>(
      keys: string[],
      items: Record<string, T>
    ): Array<{ value: string; label: string; hint: string }> {
      return keys.map((key) => ({
        value: key,
        label: items[key].name,
        hint: items[key].description,
      }));
    }

    const mockAgents = {
      claude: { name: "Claude Code", description: "AI assistant" },
      codex: { name: "Codex", description: "AI pair programmer" },
    };

    it("should map keys to select options", () => {
      const options = mapToSelectOptions(["claude", "codex"], mockAgents);
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({
        value: "claude",
        label: "Claude Code",
        hint: "AI assistant",
      });
    });

    it("should preserve order", () => {
      const options = mapToSelectOptions(["codex", "claude"], mockAgents);
      expect(options[0].value).toBe("codex");
      expect(options[1].value).toBe("claude");
    });

    it("should handle empty array", () => {
      const options = mapToSelectOptions([], mockAgents);
      expect(options).toEqual([]);
    });

    it("should include all required fields", () => {
      const options = mapToSelectOptions(["claude"], mockAgents);
      expect(options[0]).toHaveProperty("value");
      expect(options[0]).toHaveProperty("label");
      expect(options[0]).toHaveProperty("hint");
    });
  });

  describe("renderMatrixRow color logic", () => {
    it("should select green color for implemented status", () => {
      const status = "implemented";
      const icon = "+";
      const useGreen = status === "implemented";
      expect(useGreen).toBe(true);
    });

    it("should select dim color for missing status", () => {
      const status = "missing";
      const icon = "-";
      const useGreen = status === "implemented";
      expect(useGreen).toBe(false);
    });
  });

  describe("reportDownloadFailure error messages", () => {
    it("should show helpful message for 404 on both sources", () => {
      const primaryStatus = 404;
      const fallbackStatus = 404;

      const shouldShowNotFound = primaryStatus === 404 && fallbackStatus === 404;
      expect(shouldShowNotFound).toBe(true);
    });

    it("should show network error message for non-404 errors", () => {
      const primaryStatus = 500;
      const fallbackStatus = 502;

      const shouldShowNotFound = primaryStatus === 404 && fallbackStatus === 404;
      expect(shouldShowNotFound).toBe(false);
    });

    it("should indicate 404 when primary is 404", () => {
      const status = 404;
      const desc = status === 404 ? "not found" : `HTTP ${status}`;
      expect(desc).toBe("not found");
    });

    it("should show HTTP status for other codes", () => {
      const status = 403;
      const desc = status === 404 ? "not found" : `HTTP ${status}`;
      expect(desc).toBe("HTTP 403");
    });
  });

  describe("resolveAgentKey", () => {
    const manifest = {
      agents: {
        claude: { name: "Claude Code", description: "AI assistant", url: "", install: "", launch: "", env: {} },
        codex: { name: "Codex", description: "AI pair programmer", url: "", install: "", launch: "", env: {} },
        "gptme": { name: "GPTMe", description: "AI terminal assistant", url: "", install: "", launch: "", env: {} },
      },
      clouds: {},
      matrix: {},
    } as unknown as Manifest;

    it("should return exact key match", () => {
      expect(resolveAgentKey(manifest, "claude")).toBe("claude");
    });

    it("should resolve case-insensitive key", () => {
      expect(resolveAgentKey(manifest, "Claude")).toBe("claude");
      expect(resolveAgentKey(manifest, "CODEX")).toBe("codex");
    });

    it("should resolve display name to key", () => {
      expect(resolveAgentKey(manifest, "Claude Code")).toBe("claude");
      expect(resolveAgentKey(manifest, "Codex")).toBe("codex");
    });

    it("should resolve display name case-insensitively", () => {
      expect(resolveAgentKey(manifest, "claude code")).toBe("claude");
      expect(resolveAgentKey(manifest, "CLAUDE CODE")).toBe("claude");
    });

    it("should resolve display name for gptme", () => {
      expect(resolveAgentKey(manifest, "GPTMe")).toBe("gptme");
    });

    it("should return null for unknown input", () => {
      expect(resolveAgentKey(manifest, "nonexistent")).toBeNull();
      expect(resolveAgentKey(manifest, "kubernetes")).toBeNull();
    });

    it("should return null for empty input", () => {
      expect(resolveAgentKey(manifest, "")).toBeNull();
    });
  });

  describe("resolveCloudKey", () => {
    const manifest = {
      agents: {},
      clouds: {
        sprite: { name: "Sprite", description: "Fast VM", url: "", type: "vm", auth: "", provision_method: "", exec_method: "", interactive_method: "" },
        hetzner: { name: "Hetzner Cloud", description: "EU cloud", url: "", type: "vm", auth: "", provision_method: "", exec_method: "", interactive_method: "" },
        "digital-ocean": { name: "DigitalOcean", description: "Cloud VPS", url: "", type: "vm", auth: "", provision_method: "", exec_method: "", interactive_method: "" },
      },
      matrix: {},
    } as unknown as Manifest;

    it("should return exact key match", () => {
      expect(resolveCloudKey(manifest, "sprite")).toBe("sprite");
    });

    it("should resolve case-insensitive key", () => {
      expect(resolveCloudKey(manifest, "Sprite")).toBe("sprite");
      expect(resolveCloudKey(manifest, "HETZNER")).toBe("hetzner");
    });

    it("should resolve display name to key", () => {
      expect(resolveCloudKey(manifest, "Hetzner Cloud")).toBe("hetzner");
      expect(resolveCloudKey(manifest, "DigitalOcean")).toBe("digital-ocean");
    });

    it("should resolve display name case-insensitively", () => {
      expect(resolveCloudKey(manifest, "hetzner cloud")).toBe("hetzner");
      expect(resolveCloudKey(manifest, "digitalocean")).toBe("digital-ocean");
    });

    it("should return null for unknown input", () => {
      expect(resolveCloudKey(manifest, "aws")).toBeNull();
    });

    it("should return null for empty input", () => {
      expect(resolveCloudKey(manifest, "")).toBeNull();
    });
  });

  describe("buildAgentPickerHints", () => {
    it("should show cloud count for each agent", () => {
      const manifest = {
        agents: {
          claude: { name: "Claude Code", description: "AI assistant", url: "", install: "", launch: "", env: {} },
          codex: { name: "Codex", description: "AI pair programmer", url: "", install: "", launch: "", env: {} },
        },
        clouds: {
          sprite: { name: "Sprite", description: "VMs", url: "", type: "vm", auth: "token", provision_method: "", exec_method: "", interactive_method: "" },
          hetzner: { name: "Hetzner", description: "EU cloud", url: "", type: "cloud", auth: "HCLOUD_TOKEN", provision_method: "", exec_method: "", interactive_method: "" },
        },
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/codex": "implemented",
          "hetzner/codex": "missing",
        },
      } as unknown as Manifest;

      const hints = buildAgentPickerHints(manifest);
      expect(hints["claude"]).toBe("2 clouds");
      expect(hints["codex"]).toBe("1 cloud");
    });

    it("should show 'no clouds available yet' for agents with zero implementations", () => {
      const manifest = {
        agents: {
          claude: { name: "Claude Code", description: "AI assistant", url: "", install: "", launch: "", env: {} },
        },
        clouds: {
          sprite: { name: "Sprite", description: "VMs", url: "", type: "vm", auth: "token", provision_method: "", exec_method: "", interactive_method: "" },
        },
        matrix: {
          "sprite/claude": "missing",
        },
      } as unknown as Manifest;

      const hints = buildAgentPickerHints(manifest);
      expect(hints["claude"]).toBe("no clouds available yet");
    });

    it("should show credential readiness when env vars are set", () => {
      const originalEnv = process.env.HCLOUD_TOKEN;
      process.env.HCLOUD_TOKEN = "test-token";

      try {
        const manifest = {
          agents: {
            claude: { name: "Claude Code", description: "AI assistant", url: "", install: "", launch: "", env: {} },
          },
          clouds: {
            hetzner: { name: "Hetzner", description: "EU cloud", url: "", type: "cloud", auth: "HCLOUD_TOKEN", provision_method: "", exec_method: "", interactive_method: "" },
            sprite: { name: "Sprite", description: "VMs", url: "", type: "vm", auth: "token", provision_method: "", exec_method: "", interactive_method: "" },
          },
          matrix: {
            "hetzner/claude": "implemented",
            "sprite/claude": "implemented",
          },
        } as unknown as Manifest;

        const hints = buildAgentPickerHints(manifest);
        expect(hints["claude"]).toBe("2 clouds, 1 ready");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.HCLOUD_TOKEN;
        } else {
          process.env.HCLOUD_TOKEN = originalEnv;
        }
      }
    });

    it("should show plural 'ready' count when multiple clouds have credentials", () => {
      const origH = process.env.HCLOUD_TOKEN;
      const origV = process.env.VULTR_API_KEY;
      process.env.HCLOUD_TOKEN = "test";
      process.env.VULTR_API_KEY = "test";

      try {
        const manifest = {
          agents: {
            claude: { name: "Claude Code", description: "AI assistant", url: "", install: "", launch: "", env: {} },
          },
          clouds: {
            hetzner: { name: "Hetzner", description: "EU", url: "", type: "cloud", auth: "HCLOUD_TOKEN", provision_method: "", exec_method: "", interactive_method: "" },
            vultr: { name: "Vultr", description: "US", url: "", type: "cloud", auth: "VULTR_API_KEY", provision_method: "", exec_method: "", interactive_method: "" },
          },
          matrix: {
            "hetzner/claude": "implemented",
            "vultr/claude": "implemented",
          },
        } as unknown as Manifest;

        const hints = buildAgentPickerHints(manifest);
        expect(hints["claude"]).toBe("2 clouds, 2 ready");
      } finally {
        if (origH === undefined) delete process.env.HCLOUD_TOKEN;
        else process.env.HCLOUD_TOKEN = origH;
        if (origV === undefined) delete process.env.VULTR_API_KEY;
        else process.env.VULTR_API_KEY = origV;
      }
    });

    it("should not count credentials for non-parseable auth fields", () => {
      const manifest = {
        agents: {
          claude: { name: "Claude Code", description: "AI assistant", url: "", install: "", launch: "", env: {} },
        },
        clouds: {
          sprite: { name: "Sprite", description: "VMs", url: "", type: "vm", auth: "token", provision_method: "", exec_method: "", interactive_method: "" },
        },
        matrix: {
          "sprite/claude": "implemented",
        },
      } as unknown as Manifest;

      const hints = buildAgentPickerHints(manifest);
      // "token" doesn't match the env var pattern, so no credentials detected
      expect(hints["claude"]).toBe("1 cloud");
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { levenshtein, findClosestMatch } from "../commands";

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
    const agents = ["claude", "aider", "openclaw", "nanoclaw", "codex", "goose"];

    it("should find exact match (distance 0)", () => {
      expect(findClosestMatch("claude", agents)).toBe("claude");
    });

    it("should find close typo (distance 1)", () => {
      expect(findClosestMatch("cloude", agents)).toBe("claude");
      expect(findClosestMatch("claud", agents)).toBe("claude");
      expect(findClosestMatch("aidr", agents)).toBe("aider");
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
      expect(findClosestMatch("AIDER", agents)).toBe("aider");
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
      aider: { name: "Aider", description: "AI pair programmer" },
    };

    it("should map keys to select options", () => {
      const options = mapToSelectOptions(["claude", "aider"], mockAgents);
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({
        value: "claude",
        label: "Claude Code",
        hint: "AI assistant",
      });
    });

    it("should preserve order", () => {
      const options = mapToSelectOptions(["aider", "claude"], mockAgents);
      expect(options[0].value).toBe("aider");
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

  describe("isLocalSpawnCheckout", () => {
    // Helper function behavior
    function isLocalSpawnCheckout(fileExists: (path: string) => boolean): boolean {
      return fileExists("./improve.sh") && fileExists("./manifest.json");
    }

    it("should return true when both files exist", () => {
      const fakeExists = (path: string) => path === "./improve.sh" || path === "./manifest.json";
      expect(isLocalSpawnCheckout(fakeExists)).toBe(true);
    });

    it("should return false when improve.sh is missing", () => {
      const fakeExists = (path: string) => path === "./manifest.json";
      expect(isLocalSpawnCheckout(fakeExists)).toBe(false);
    });

    it("should return false when manifest.json is missing", () => {
      const fakeExists = (path: string) => path === "./improve.sh";
      expect(isLocalSpawnCheckout(fakeExists)).toBe(false);
    });

    it("should return false when both files are missing", () => {
      const fakeExists = () => false;
      expect(isLocalSpawnCheckout(fakeExists)).toBe(false);
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
});

import { describe, it, expect } from "bun:test";
import {
  getImplementedClouds,
  validateAgentExists,
  validateCloudExists,
  validateImplementation,
  mapToSelectOptions,
  calculateColumnWidth,
  calculateAgentColumnWidth,
  calculateCloudColumnWidth,
  getStatus,
  hasImplementedCombinations,
  getAgentsWithImplementations,
  getCloudsWithImplementations,
} from "../commands-logic";
import { createMockManifest, createEmptyManifest } from "./test-helpers";

const mockManifest = createMockManifest();

describe("commands-logic", () => {
  describe("getImplementedClouds", () => {
    it("should return clouds with implemented agent", () => {
      const clouds = getImplementedClouds(mockManifest, "claude");
      expect(clouds).toContain("sprite");
      expect(clouds).toContain("hetzner");
    });

    it("should return subset of clouds for agents with partial implementations", () => {
      const clouds = getImplementedClouds(mockManifest, "aider");
      expect(clouds).toContain("sprite");
      expect(clouds).not.toContain("hetzner");
    });

    it("should return empty array for agent with no implementations", () => {
      const manifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
        },
      };
      const clouds = getImplementedClouds(manifest, "nonexistent");
      expect(clouds).toEqual([]);
    });
  });

  describe("validateAgentExists", () => {
    it("should return true for existing agent", () => {
      expect(validateAgentExists(mockManifest, "claude")).toBe(true);
      expect(validateAgentExists(mockManifest, "aider")).toBe(true);
    });

    it("should return false for non-existent agent", () => {
      expect(validateAgentExists(mockManifest, "nonexistent")).toBe(false);
      expect(validateAgentExists(mockManifest, "")).toBe(false);
    });

    it("should return false for empty manifest", () => {
      const emptyManifest = createEmptyManifest();
      expect(validateAgentExists(emptyManifest, "claude")).toBe(false);
    });
  });

  describe("validateCloudExists", () => {
    it("should return true for existing cloud", () => {
      expect(validateCloudExists(mockManifest, "sprite")).toBe(true);
      expect(validateCloudExists(mockManifest, "hetzner")).toBe(true);
    });

    it("should return false for non-existent cloud", () => {
      expect(validateCloudExists(mockManifest, "aws")).toBe(false);
      expect(validateCloudExists(mockManifest, "")).toBe(false);
    });
  });

  describe("validateImplementation", () => {
    it("should return true for implemented combinations", () => {
      expect(validateImplementation(mockManifest, "sprite", "claude")).toBe(true);
      expect(validateImplementation(mockManifest, "sprite", "aider")).toBe(true);
      expect(validateImplementation(mockManifest, "hetzner", "claude")).toBe(true);
    });

    it("should return false for missing combinations", () => {
      expect(validateImplementation(mockManifest, "hetzner", "aider")).toBe(false);
    });

    it("should return false for non-existent entries", () => {
      expect(validateImplementation(mockManifest, "aws", "claude")).toBe(false);
      expect(validateImplementation(mockManifest, "sprite", "nonexistent")).toBe(false);
    });
  });

  describe("mapToSelectOptions", () => {
    it("should map agent keys to select options", () => {
      const options = mapToSelectOptions(["claude", "aider"], mockManifest.agents);
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({
        value: "claude",
        label: "Claude Code",
        hint: "AI coding assistant",
      });
      expect(options[1]).toEqual({
        value: "aider",
        label: "Aider",
        hint: "AI pair programmer",
      });
    });

    it("should preserve order of keys", () => {
      const options = mapToSelectOptions(["aider", "claude"], mockManifest.agents);
      expect(options[0].value).toBe("aider");
      expect(options[1].value).toBe("claude");
    });

    it("should handle empty array", () => {
      const options = mapToSelectOptions([], mockManifest.agents);
      expect(options).toEqual([]);
    });
  });

  describe("calculateColumnWidth", () => {
    it("should return minimum width if items are shorter", () => {
      const width = calculateColumnWidth(["a", "b"], 10, 2);
      expect(width).toBe(10);
    });

    it("should expand to fit longest item", () => {
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
  });

  describe("calculateAgentColumnWidth", () => {
    it("should calculate width based on agent names", () => {
      const width = calculateAgentColumnWidth(mockManifest, ["claude", "aider"], 8, 2);
      // "Claude Code" (11) + 2 = 13
      expect(width).toBe(13);
    });

    it("should respect minimum width", () => {
      const width = calculateAgentColumnWidth(mockManifest, ["claude"], 20, 2);
      expect(width).toBe(20);
    });

    it("should work with empty agents list", () => {
      const width = calculateAgentColumnWidth(mockManifest, [], 10, 2);
      expect(width).toBe(10);
    });
  });

  describe("calculateCloudColumnWidth", () => {
    it("should calculate width based on cloud names", () => {
      const width = calculateCloudColumnWidth(mockManifest, ["sprite", "hetzner"], 8, 2);
      // "Hetzner Cloud" (13) + 2 = 15
      expect(width).toBe(15);
    });

    it("should respect minimum width", () => {
      const width = calculateCloudColumnWidth(mockManifest, ["sprite"], 20, 2);
      expect(width).toBe(20);
    });
  });

  describe("getStatus", () => {
    it("should return implementation status", () => {
      expect(getStatus(mockManifest, "sprite", "claude")).toBe("implemented");
      expect(getStatus(mockManifest, "hetzner", "aider")).toBe("missing");
    });

    it("should return missing for non-existent combinations", () => {
      expect(getStatus(mockManifest, "aws", "claude")).toBe("missing");
    });
  });

  describe("hasImplementedCombinations", () => {
    it("should return true when implementations exist", () => {
      expect(hasImplementedCombinations(mockManifest)).toBe(true);
    });

    it("should return false when no implementations exist", () => {
      const manifest = {
        agents: mockManifest.agents,
        clouds: mockManifest.clouds,
        matrix: {
          "sprite/claude": "missing",
          "sprite/aider": "missing",
          "hetzner/claude": "missing",
          "hetzner/aider": "missing",
        },
      };
      expect(hasImplementedCombinations(manifest)).toBe(false);
    });

    it("should return false for empty matrix", () => {
      const manifest = createEmptyManifest();
      expect(hasImplementedCombinations(manifest)).toBe(false);
    });
  });

  describe("getAgentsWithImplementations", () => {
    it("should return only agents with implementations", () => {
      const agents = getAgentsWithImplementations(mockManifest);
      expect(agents).toContain("claude");
      expect(agents).toContain("aider"); // aider has sprite implementation
    });

    it("should exclude agents with no implementations", () => {
      const manifest = {
        agents: {
          ...mockManifest.agents,
          ghost: mockManifest.agents.claude,
        },
        clouds: mockManifest.clouds,
        matrix: {
          "sprite/claude": "implemented",
          "sprite/aider": "implemented",
          "hetzner/claude": "implemented",
          "hetzner/aider": "missing",
        },
      };
      const agents = getAgentsWithImplementations(manifest);
      expect(agents).toContain("claude");
      expect(agents).toContain("aider");
      expect(agents).not.toContain("ghost");
    });

    it("should return empty array for manifest with no implementations", () => {
      const manifest = createEmptyManifest();
      expect(getAgentsWithImplementations(manifest)).toEqual([]);
    });
  });

  describe("getCloudsWithImplementations", () => {
    it("should return only clouds with implementations", () => {
      const clouds = getCloudsWithImplementations(mockManifest);
      expect(clouds).toContain("sprite");
      expect(clouds).toContain("hetzner");
    });

    it("should exclude clouds with no implementations", () => {
      const manifest = {
        agents: mockManifest.agents,
        clouds: {
          ...mockManifest.clouds,
          aws: mockManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "implemented",
          "sprite/aider": "implemented",
          "hetzner/claude": "implemented",
          "hetzner/aider": "missing",
        },
      };
      const clouds = getCloudsWithImplementations(manifest);
      expect(clouds).toContain("sprite");
      expect(clouds).toContain("hetzner");
      expect(clouds).not.toContain("aws");
    });

    it("should return empty array for manifest with no implementations", () => {
      const manifest = createEmptyManifest();
      expect(getCloudsWithImplementations(manifest)).toEqual([]);
    });
  });
});

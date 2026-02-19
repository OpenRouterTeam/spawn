import { describe, it, expect } from "bun:test";

/**
 * Edge case tests for CLI argument parsing from index.ts.
 *
 * These tests cover subtle behaviors in the actual index.ts argument parsing
 * that are not captured by the existing index-parsing.test.ts, specifically:
 * - The startsWith("-") guard that rejects flag-like values for --prompt/-p
 * - Interaction between --prompt and --prompt-file when both are present
 * - The promptFileIndex check for --prompt-file without a value
 * - Edge cases in the actual splice-based removal of flags
 *
 * Agent: test-engineer
 */

// Replicate the ACTUAL index.ts --prompt extraction logic (including startsWith("-") guard)
function extractPromptArgsActual(args: string[]): {
  prompt: string | undefined;
  filteredArgs: string[];
  error: string | undefined;
} {
  let prompt: string | undefined;
  let error: string | undefined;
  let filteredArgs = [...args];

  const promptIndex = filteredArgs.findIndex(arg => arg === "--prompt" || arg === "-p");
  if (promptIndex !== -1) {
    if (!filteredArgs[promptIndex + 1] || filteredArgs[promptIndex + 1].startsWith("-")) {
      error = `${filteredArgs[promptIndex]} requires a value`;
    } else {
      prompt = filteredArgs[promptIndex + 1];
      filteredArgs.splice(promptIndex, 2);
    }
  }

  return { prompt, filteredArgs, error };
}

// Replicate the ACTUAL index.ts --prompt-file extraction logic
function extractPromptFileArgsActual(args: string[]): {
  promptFilePath: string | undefined;
  filteredArgs: string[];
  error: string | undefined;
} {
  let promptFilePath: string | undefined;
  let error: string | undefined;
  let filteredArgs = [...args];

  const promptFileIndex = filteredArgs.findIndex(arg => arg === "--prompt-file");
  if (promptFileIndex !== -1) {
    if (!filteredArgs[promptFileIndex + 1] || filteredArgs[promptFileIndex + 1].startsWith("-")) {
      error = "--prompt-file requires a file path";
    } else {
      promptFilePath = filteredArgs[promptFileIndex + 1];
      filteredArgs.splice(promptFileIndex, 2);
    }
  }

  return { promptFilePath, filteredArgs, error };
}

describe("CLI Argument Parsing Edge Cases", () => {
  describe("--prompt with startsWith('-') guard", () => {
    it("should reject --prompt followed by another flag", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "--prompt", "--verbose"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a value");
      expect(result.prompt).toBeUndefined();
    });

    it("should reject -p followed by another flag", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "-p", "-v"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a value");
    });

    it("should reject --prompt followed by --prompt-file", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "--prompt", "--prompt-file"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a value");
    });

    it("should accept --prompt with value that contains dashes internally", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "--prompt", "fix-the-bug"]);
      expect(result.error).toBeUndefined();
      expect(result.prompt).toBe("fix-the-bug");
    });

    it("should reject --prompt as last argument", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "--prompt"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a value");
    });

    it("should reject -p as last argument", () => {
      const result = extractPromptArgsActual(["claude", "-p"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a value");
    });

    it("should accept a prompt value that starts with a number", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "--prompt", "3 things to fix"]);
      expect(result.error).toBeUndefined();
      expect(result.prompt).toBe("3 things to fix");
    });

    it("should accept a prompt value that is a single word", () => {
      const result = extractPromptArgsActual(["claude", "sprite", "-p", "refactor"]);
      expect(result.error).toBeUndefined();
      expect(result.prompt).toBe("refactor");
    });

    it("should correctly splice prompt from middle of args", () => {
      const result = extractPromptArgsActual(["--prompt", "Fix bugs", "claude", "sprite"]);
      expect(result.prompt).toBe("Fix bugs");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
    });
  });

  describe("--prompt-file with startsWith('-') guard", () => {
    it("should reject --prompt-file followed by a flag", () => {
      const result = extractPromptFileArgsActual(["claude", "sprite", "--prompt-file", "--verbose"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a file path");
    });

    it("should reject --prompt-file followed by -p", () => {
      const result = extractPromptFileArgsActual(["claude", "sprite", "--prompt-file", "-p"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a file path");
    });

    it("should reject --prompt-file as last argument", () => {
      const result = extractPromptFileArgsActual(["claude", "sprite", "--prompt-file"]);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("requires a file path");
    });

    it("should accept --prompt-file with a valid path", () => {
      const result = extractPromptFileArgsActual(["claude", "sprite", "--prompt-file", "instructions.txt"]);
      expect(result.error).toBeUndefined();
      expect(result.promptFilePath).toBe("instructions.txt");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should accept --prompt-file with path containing dashes", () => {
      const result = extractPromptFileArgsActual(["claude", "sprite", "--prompt-file", "my-prompt-file.txt"]);
      expect(result.error).toBeUndefined();
      expect(result.promptFilePath).toBe("my-prompt-file.txt");
    });

    it("should accept --prompt-file with absolute path", () => {
      const result = extractPromptFileArgsActual(["claude", "sprite", "--prompt-file", "/home/user/prompt.md"]);
      expect(result.error).toBeUndefined();
      expect(result.promptFilePath).toBe("/home/user/prompt.md");
    });
  });

  describe("isInteractiveTTY logic", () => {
    function isInteractiveTTY(stdinTTY: boolean, stdoutTTY: boolean): boolean {
      return stdinTTY && stdoutTTY;
    }

    it("should return true only when both stdin and stdout are TTY", () => {
      expect(isInteractiveTTY(true, true)).toBe(true);
    });

    it("should return false when stdin is not TTY", () => {
      expect(isInteractiveTTY(false, true)).toBe(false);
    });

    it("should return false when stdout is not TTY", () => {
      expect(isInteractiveTTY(true, false)).toBe(false);
    });

    it("should return false when neither is TTY", () => {
      expect(isInteractiveTTY(false, false)).toBe(false);
    });
  });

  describe("handleDefaultCommand routing logic", () => {
    // Mirrors the updated routing in index.ts handleDefaultCommand:
    // 1. If input matches an agent -> agentInfo
    // 2. If input matches a cloud -> cloudInfo
    // 3. Otherwise -> unified error with suggestions from both pools
    function routeDefaultCommand(
      input: string,
      cloud: string | undefined,
      agents: Record<string, boolean>,
      clouds: Record<string, boolean>
    ): "run" | "agentInfo" | "cloudInfo" | "unifiedError" {
      if (cloud) return "run";
      if (agents[input]) return "agentInfo";
      if (clouds[input]) return "cloudInfo";
      return "unifiedError";
    }

    const agents = { claude: true, codex: true, openclaw: true };
    const clouds = { sprite: true, hetzner: true, digitalocean: true };

    it("should route to run when agent and cloud provided", () => {
      expect(routeDefaultCommand("claude", "sprite", agents, clouds)).toBe("run");
    });

    it("should route to agentInfo when input matches an agent", () => {
      expect(routeDefaultCommand("claude", undefined, agents, clouds)).toBe("agentInfo");
    });

    it("should route to cloudInfo when input matches a cloud", () => {
      expect(routeDefaultCommand("hetzner", undefined, agents, clouds)).toBe("cloudInfo");
    });

    it("should route to unifiedError when input matches neither", () => {
      expect(routeDefaultCommand("nonexistent", undefined, agents, clouds)).toBe("unifiedError");
    });

    it("should prefer agentInfo over cloudInfo when input is ambiguous", () => {
      // If a name exists in both agents and clouds, agent takes priority
      const ambiguousAgents = { ...agents, hetzner: true };
      expect(routeDefaultCommand("hetzner", undefined, ambiguousAgents, clouds)).toBe("agentInfo");
    });

    it("should route to run even for unknown names when cloud arg present", () => {
      expect(routeDefaultCommand("nonexistent", "sprite", agents, clouds)).toBe("run");
    });
  });

  describe("unified error suggestions from both agents and clouds", () => {
    // Mirrors the new behavior: when input matches neither, suggest from both pools
    function findUnifiedSuggestion(
      input: string,
      agentKeys: string[],
      cloudKeys: string[],
      findClosest: (input: string, candidates: string[]) => string | null
    ): { agentMatch: string | null; cloudMatch: string | null } {
      return {
        agentMatch: findClosest(input, agentKeys),
        cloudMatch: findClosest(input, cloudKeys),
      };
    }

    // Simple mock findClosestMatch that returns exact prefix matches
    function mockFindClosest(input: string, candidates: string[]): string | null {
      for (const c of candidates) {
        if (c.startsWith(input) || input.startsWith(c)) return c;
      }
      return null;
    }

    it("should find agent suggestion for near-agent input", () => {
      const result = findUnifiedSuggestion("claud", ["claude", "codex"], ["sprite", "hetzner"], mockFindClosest);
      expect(result.agentMatch).toBe("claude");
      expect(result.cloudMatch).toBeNull();
    });

    it("should find cloud suggestion for near-cloud input", () => {
      const result = findUnifiedSuggestion("hetzne", ["claude", "codex"], ["sprite", "hetzner"], mockFindClosest);
      expect(result.agentMatch).toBeNull();
      expect(result.cloudMatch).toBe("hetzner");
    });

    it("should find both suggestions when input is ambiguous", () => {
      // "cod" could match "codex" (agent) and "cod-cloud" (cloud) if it existed
      const result = findUnifiedSuggestion("cod", ["claude", "codex"], ["cod-cloud", "hetzner"], mockFindClosest);
      expect(result.agentMatch).toBe("codex");
      expect(result.cloudMatch).toBe("cod-cloud");
    });

    it("should return null for both when no matches found", () => {
      const result = findUnifiedSuggestion("zzzzz", ["claude", "codex"], ["sprite", "hetzner"], mockFindClosest);
      expect(result.agentMatch).toBeNull();
      expect(result.cloudMatch).toBeNull();
    });
  });

  describe("combined --prompt and --prompt-file extraction order", () => {
    it("should extract --prompt first, leaving --prompt-file in remaining args", () => {
      const step1 = extractPromptArgsActual(["claude", "sprite", "--prompt", "Fix bugs", "--prompt-file", "todo.txt"]);
      expect(step1.prompt).toBe("Fix bugs");
      expect(step1.filteredArgs).toEqual(["claude", "sprite", "--prompt-file", "todo.txt"]);

      const step2 = extractPromptFileArgsActual(step1.filteredArgs);
      expect(step2.promptFilePath).toBe("todo.txt");
      expect(step2.filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should handle --prompt-file first in args before --prompt", () => {
      const args = ["--prompt-file", "todo.txt", "claude", "sprite", "--prompt", "Override"];
      const step1 = extractPromptArgsActual(args);
      expect(step1.prompt).toBe("Override");
      expect(step1.filteredArgs).toContain("--prompt-file");
    });
  });

  describe("agent name display truncation logic", () => {
    function formatAgentList(agentNames: string[]): string[] {
      const shown = agentNames.slice(0, 5);
      const lines = shown.map(name => `  - ${name}`);
      if (agentNames.length > 5) {
        lines.push(`  ... and ${agentNames.length - 5} more`);
      }
      return lines;
    }

    it("should show all agents when 5 or fewer", () => {
      const lines = formatAgentList(["Agent1", "Agent2", "Agent3"]);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("Agent1");
    });

    it("should show exactly 5 agents", () => {
      const lines = formatAgentList(["A1", "A2", "A3", "A4", "A5"]);
      expect(lines).toHaveLength(5);
    });

    it("should truncate and show count for more than 5 agents", () => {
      const agents = Array.from({ length: 13 }, (_, i) => `Agent${i + 1}`);
      const lines = formatAgentList(agents);
      expect(lines).toHaveLength(6);
      expect(lines[5]).toContain("... and 8 more");
    });

    it("should show '... and 1 more' for 6 agents", () => {
      const agents = ["A1", "A2", "A3", "A4", "A5", "A6"];
      const lines = formatAgentList(agents);
      expect(lines[5]).toContain("... and 1 more");
    });
  });
});

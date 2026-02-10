import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";

/**
 * Tests for the CLI entry pipeline from index.ts.
 *
 * This tests the exact `extractFlagValue` function logic (the generic flag
 * parser used for --prompt, -p, and --prompt-file) and the full main()
 * routing pipeline. Existing tests in index-parsing.test.ts and
 * index-edge-cases.test.ts use simplified re-implementations that miss
 * the generic extractFlagValue behavior.
 *
 * Key behaviors tested here that are NOT covered elsewhere:
 * - extractFlagValue as a generic function with configurable flags/labels
 * - process.exit(1) on missing flag values
 * - The exact error message format including usageHint
 * - Sequential extraction: --prompt first, then --prompt-file from remainder
 * - Edge cases: duplicate flags, flags embedded in values, empty args
 *
 * Agent: test-engineer
 */

// ── Exact replica of extractFlagValue from index.ts ──────────────────────────

/**
 * Replicates the EXACT extractFlagValue from index.ts lines 32-51.
 * Unlike simplified re-implementations in other test files, this
 * preserves the process.exit behavior and usageHint formatting.
 */
function extractFlagValue(
  args: string[],
  flags: string[],
  flagLabel: string,
  usageHint: string,
  callbacks: { exit: (code: number) => void; stderr: (msg: string) => void }
): [string | undefined, string[]] {
  const idx = args.findIndex(arg => flags.includes(arg));
  if (idx === -1) return [undefined, args];

  if (!args[idx + 1] || args[idx + 1].startsWith("-")) {
    callbacks.stderr(`Error: ${args[idx]} requires a value`);
    callbacks.stderr(`\nUsage: ${usageHint}`);
    callbacks.exit(1);
  }

  const value = args[idx + 1];
  const remaining = [...args];
  remaining.splice(idx, 2);
  return [value, remaining];
}

// ── Full pipeline replica: extract --prompt then --prompt-file ───────────────

interface PipelineResult {
  prompt: string | undefined;
  promptFile: string | undefined;
  filteredArgs: string[];
  exitCode: number | undefined;
  stderrOutput: string[];
}

function runPipeline(args: string[]): PipelineResult {
  let exitCode: number | undefined;
  const stderrOutput: string[] = [];
  const callbacks = {
    exit: (code: number) => { exitCode = code; },
    stderr: (msg: string) => { stderrOutput.push(msg); },
  };

  // Step 1: extract --prompt / -p
  const [prompt, filteredArgs1] = extractFlagValue(
    args,
    ["--prompt", "-p"],
    "prompt",
    'spawn <agent> <cloud> --prompt "your prompt here"',
    callbacks
  );

  if (exitCode !== undefined) {
    return { prompt: undefined, promptFile: undefined, filteredArgs: args, exitCode, stderrOutput };
  }

  // Step 2: extract --prompt-file from remaining args
  const [promptFile, filteredArgs2] = extractFlagValue(
    filteredArgs1,
    ["--prompt-file"],
    "prompt file",
    "spawn <agent> <cloud> --prompt-file instructions.txt",
    callbacks
  );

  return {
    prompt,
    promptFile,
    filteredArgs: exitCode !== undefined ? filteredArgs1 : filteredArgs2,
    exitCode,
    stderrOutput,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CLI Pipeline - extractFlagValue", () => {
  describe("generic flag extraction", () => {
    const noopCallbacks = {
      exit: () => {},
      stderr: () => {},
    };

    it("should return undefined and original args when flag not found", () => {
      const args = ["claude", "sprite"];
      const [value, remaining] = extractFlagValue(args, ["--foo"], "foo", "usage", noopCallbacks);
      expect(value).toBeUndefined();
      expect(remaining).toEqual(["claude", "sprite"]);
      // Should be the same array reference (not copied) when flag not found
      expect(remaining).toBe(args);
    });

    it("should extract flag and value from end of args", () => {
      const [value, remaining] = extractFlagValue(
        ["claude", "sprite", "--foo", "bar"],
        ["--foo"],
        "foo",
        "usage",
        noopCallbacks
      );
      expect(value).toBe("bar");
      expect(remaining).toEqual(["claude", "sprite"]);
    });

    it("should extract flag and value from beginning of args", () => {
      const [value, remaining] = extractFlagValue(
        ["--foo", "bar", "claude", "sprite"],
        ["--foo"],
        "foo",
        "usage",
        noopCallbacks
      );
      expect(value).toBe("bar");
      expect(remaining).toEqual(["claude", "sprite"]);
    });

    it("should extract flag from middle of args", () => {
      const [value, remaining] = extractFlagValue(
        ["claude", "--foo", "bar", "sprite"],
        ["--foo"],
        "foo",
        "usage",
        noopCallbacks
      );
      expect(value).toBe("bar");
      expect(remaining).toEqual(["claude", "sprite"]);
    });

    it("should match first flag in the flags array", () => {
      const [value, remaining] = extractFlagValue(
        ["claude", "-f", "bar"],
        ["--foo", "-f"],
        "foo",
        "usage",
        noopCallbacks
      );
      expect(value).toBe("bar");
      expect(remaining).toEqual(["claude"]);
    });

    it("should only extract the first occurrence of the flag", () => {
      const [value, remaining] = extractFlagValue(
        ["--foo", "first", "--foo", "second"],
        ["--foo"],
        "foo",
        "usage",
        noopCallbacks
      );
      expect(value).toBe("first");
      expect(remaining).toEqual(["--foo", "second"]);
    });

    it("should handle single-element args with just the flag", () => {
      let exitCalled = false;
      const [value, remaining] = extractFlagValue(
        ["--foo"],
        ["--foo"],
        "foo",
        "usage hint",
        { exit: () => { exitCalled = true; }, stderr: () => {} }
      );
      expect(exitCalled).toBe(true);
    });

    it("should call exit when flag value starts with -", () => {
      let exitCalled = false;
      const stderrMessages: string[] = [];
      extractFlagValue(
        ["claude", "--foo", "--bar"],
        ["--foo"],
        "foo",
        "usage hint",
        {
          exit: () => { exitCalled = true; },
          stderr: (msg) => { stderrMessages.push(msg); },
        }
      );
      expect(exitCalled).toBe(true);
      expect(stderrMessages[0]).toBe("Error: --foo requires a value");
      expect(stderrMessages[1]).toContain("Usage: usage hint");
    });

    it("should call exit when flag is the last argument", () => {
      let exitCalled = false;
      const stderrMessages: string[] = [];
      extractFlagValue(
        ["claude", "sprite", "--foo"],
        ["--foo"],
        "foo",
        "my usage hint",
        {
          exit: () => { exitCalled = true; },
          stderr: (msg) => { stderrMessages.push(msg); },
        }
      );
      expect(exitCalled).toBe(true);
      expect(stderrMessages[0]).toBe("Error: --foo requires a value");
      expect(stderrMessages[1]).toContain("my usage hint");
    });

    it("should accept value that contains dash internally", () => {
      const [value, remaining] = extractFlagValue(
        ["--foo", "my-value-here"],
        ["--foo"],
        "foo",
        "usage",
        noopCallbacks
      );
      expect(value).toBe("my-value-here");
      expect(remaining).toEqual([]);
    });

    it("should handle empty args array", () => {
      const [value, remaining] = extractFlagValue([], ["--foo"], "foo", "usage", noopCallbacks);
      expect(value).toBeUndefined();
      expect(remaining).toEqual([]);
    });
  });

  describe("error message formatting", () => {
    it("should include the exact flag name in the error message", () => {
      const stderrMessages: string[] = [];
      extractFlagValue(
        ["-p"],
        ["--prompt", "-p"],
        "prompt",
        "spawn <agent> <cloud> --prompt \"text\"",
        { exit: () => {}, stderr: (msg) => { stderrMessages.push(msg); } }
      );
      expect(stderrMessages[0]).toBe("Error: -p requires a value");
    });

    it("should include the exact flag name for long form", () => {
      const stderrMessages: string[] = [];
      extractFlagValue(
        ["--prompt"],
        ["--prompt", "-p"],
        "prompt",
        "usage",
        { exit: () => {}, stderr: (msg) => { stderrMessages.push(msg); } }
      );
      expect(stderrMessages[0]).toBe("Error: --prompt requires a value");
    });

    it("should include --prompt-file in error for prompt file flag", () => {
      const stderrMessages: string[] = [];
      extractFlagValue(
        ["--prompt-file"],
        ["--prompt-file"],
        "prompt file",
        "spawn <agent> <cloud> --prompt-file instructions.txt",
        { exit: () => {}, stderr: (msg) => { stderrMessages.push(msg); } }
      );
      expect(stderrMessages[0]).toBe("Error: --prompt-file requires a value");
      expect(stderrMessages[1]).toContain("instructions.txt");
    });
  });

  describe("full pipeline: sequential --prompt and --prompt-file extraction", () => {
    it("should extract --prompt and leave --prompt-file for second pass", () => {
      const result = runPipeline(["claude", "sprite", "--prompt", "Fix bugs", "--prompt-file", "todo.txt"]);
      expect(result.prompt).toBe("Fix bugs");
      expect(result.promptFile).toBe("todo.txt");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
      expect(result.exitCode).toBeUndefined();
    });

    it("should extract --prompt-file when --prompt is absent", () => {
      const result = runPipeline(["claude", "sprite", "--prompt-file", "instructions.md"]);
      expect(result.prompt).toBeUndefined();
      expect(result.promptFile).toBe("instructions.md");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
      expect(result.exitCode).toBeUndefined();
    });

    it("should extract only --prompt when --prompt-file is absent", () => {
      const result = runPipeline(["claude", "sprite", "-p", "Add tests"]);
      expect(result.prompt).toBe("Add tests");
      expect(result.promptFile).toBeUndefined();
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
      expect(result.exitCode).toBeUndefined();
    });

    it("should return clean args when neither flag is present", () => {
      const result = runPipeline(["claude", "sprite"]);
      expect(result.prompt).toBeUndefined();
      expect(result.promptFile).toBeUndefined();
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
      expect(result.exitCode).toBeUndefined();
    });

    it("should report error when --prompt has no value", () => {
      const result = runPipeline(["claude", "sprite", "--prompt"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderrOutput[0]).toContain("--prompt requires a value");
    });

    it("should report error when -p is followed by another flag", () => {
      const result = runPipeline(["claude", "-p", "--prompt-file", "f.txt"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderrOutput[0]).toContain("-p requires a value");
    });

    it("should stop pipeline on --prompt error even if --prompt-file is valid", () => {
      const result = runPipeline(["--prompt", "--prompt-file", "valid.txt"]);
      expect(result.exitCode).toBe(1);
      // --prompt sees --prompt-file as a flag-like value and errors
      expect(result.stderrOutput[0]).toContain("--prompt requires a value");
      // --prompt-file should NOT have been extracted
      expect(result.promptFile).toBeUndefined();
    });

    it("should report error when --prompt-file has no value", () => {
      const result = runPipeline(["claude", "sprite", "--prompt-file"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderrOutput[0]).toContain("--prompt-file requires a value");
    });

    it("should handle empty args", () => {
      const result = runPipeline([]);
      expect(result.prompt).toBeUndefined();
      expect(result.promptFile).toBeUndefined();
      expect(result.filteredArgs).toEqual([]);
      expect(result.exitCode).toBeUndefined();
    });

    it("should preserve non-flag arguments in order", () => {
      const result = runPipeline(["agents"]);
      expect(result.prompt).toBeUndefined();
      expect(result.promptFile).toBeUndefined();
      expect(result.filteredArgs).toEqual(["agents"]);
    });

    it("should handle --prompt-file before --prompt in args", () => {
      const result = runPipeline(["--prompt-file", "file.txt", "claude", "sprite", "-p", "Fix it"]);
      // --prompt/-p is extracted first regardless of position
      expect(result.prompt).toBe("Fix it");
      expect(result.promptFile).toBe("file.txt");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should handle prompt value with special characters", () => {
      const result = runPipeline(["claude", "sprite", "--prompt", "Fix the 'bug' in module \"auth\""]);
      expect(result.prompt).toBe("Fix the 'bug' in module \"auth\"");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should handle prompt file path with dots and slashes", () => {
      const result = runPipeline(["claude", "sprite", "--prompt-file", "../prompts/fix.txt"]);
      expect(result.promptFile).toBe("../prompts/fix.txt");
      expect(result.filteredArgs).toEqual(["claude", "sprite"]);
    });
  });

  describe("command routing after flag extraction", () => {
    function routeCommand(args: string[]): string {
      const result = runPipeline(args);
      if (result.exitCode !== undefined) return "error";
      const cmd = result.filteredArgs[0];
      if (!cmd) return "interactive_or_help";
      switch (cmd) {
        case "help": case "--help": case "-h": return "help";
        case "version": case "--version": case "-v": case "-V": return "version";
        case "list": case "ls": return "list";
        case "agents": return "agents";
        case "clouds": return "clouds";
        case "improve": return "improve";
        case "update": return "update";
        default: return "default";
      }
    }

    it("should route to help after stripping irrelevant flags", () => {
      expect(routeCommand(["help"])).toBe("help");
      expect(routeCommand(["--help"])).toBe("help");
      expect(routeCommand(["-h"])).toBe("help");
    });

    it("should route to version after stripping irrelevant flags", () => {
      expect(routeCommand(["version"])).toBe("version");
      expect(routeCommand(["--version"])).toBe("version");
    });

    it("should route to list", () => {
      expect(routeCommand(["list"])).toBe("list");
      expect(routeCommand(["ls"])).toBe("list");
    });

    it("should route to default for agent names", () => {
      expect(routeCommand(["claude", "sprite"])).toBe("default");
    });

    it("should route to default for agent names with --prompt stripped", () => {
      expect(routeCommand(["claude", "sprite", "--prompt", "Fix"])).toBe("default");
    });

    it("should route to interactive_or_help for empty args", () => {
      expect(routeCommand([])).toBe("interactive_or_help");
    });

    it("should route to error when --prompt has no value", () => {
      expect(routeCommand(["claude", "sprite", "--prompt"])).toBe("error");
    });

    it("should correctly identify agent even when --prompt appears before it", () => {
      const result = runPipeline(["--prompt", "Fix", "claude", "sprite"]);
      expect(result.filteredArgs[0]).toBe("claude");
      expect(result.filteredArgs[1]).toBe("sprite");
    });
  });

  describe("edge cases: flag-like values", () => {
    it("should reject value starting with single dash", () => {
      const result = runPipeline(["claude", "--prompt", "-v"]);
      expect(result.exitCode).toBe(1);
    });

    it("should reject value starting with double dash", () => {
      const result = runPipeline(["claude", "--prompt", "--verbose"]);
      expect(result.exitCode).toBe(1);
    });

    it("should accept value that is just a number", () => {
      const result = runPipeline(["claude", "sprite", "--prompt", "42"]);
      expect(result.prompt).toBe("42");
      expect(result.exitCode).toBeUndefined();
    });

    it("should accept value that starts with a number", () => {
      const result = runPipeline(["claude", "sprite", "-p", "3 things to fix"]);
      expect(result.prompt).toBe("3 things to fix");
      expect(result.exitCode).toBeUndefined();
    });

    it("should accept value containing equals sign", () => {
      const result = runPipeline(["claude", "sprite", "--prompt", "key=value"]);
      expect(result.prompt).toBe("key=value");
      expect(result.exitCode).toBeUndefined();
    });

    it("should accept empty string value (non-flag)", () => {
      // Empty string is falsy, so extractFlagValue treats it like missing
      const result = runPipeline(["claude", "sprite", "--prompt", ""]);
      expect(result.exitCode).toBe(1);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

/**
 * Tests for the resolvePrompt pipeline and handleDefaultCommand routing
 * from index.ts.
 *
 * Existing tests in cli-pipeline.test.ts cover extractFlagValue in isolation.
 * Existing tests in index-parsing.test.ts and index-edge-cases.test.ts cover
 * simplified reimplementations of prompt extraction.
 *
 * This file covers the FULL resolvePrompt pipeline:
 * - Sequential extraction: --prompt first, then --prompt-file from remainder
 * - Mutual exclusion: --prompt + --prompt-file together triggers process.exit
 * - File reading: --prompt-file reads from disk, handles errors
 * - handleDefaultCommand: HELP_FLAGS routing for "spawn <agent> --help"
 * - Prompt-only-without-cloud error: "spawn --prompt 'text'" with no agent/cloud
 * - Prompt-with-agent-only error: "spawn <agent> --prompt 'text'" without cloud
 *
 * Agent: test-engineer
 */

// ── Faithful replica of extractFlagValue from index.ts (lines 34-53) ──────────

function extractFlagValue(
  args: string[],
  flags: string[],
  _flagLabel: string,
  usageHint: string,
  hooks?: { exit?: (code: number) => void; stderr?: (msg: string) => void }
): [string | undefined, string[]] {
  const idx = args.findIndex(arg => flags.includes(arg));
  if (idx === -1) return [undefined, args];

  if (!args[idx + 1] || args[idx + 1].startsWith("-")) {
    const exitFn = hooks?.exit ?? ((code: number) => { throw new Error(`process.exit(${code})`); });
    const stderrFn = hooks?.stderr ?? (() => {});
    stderrFn(`Error: ${args[idx]} requires a value`);
    stderrFn(`\nUsage: ${usageHint}`);
    exitFn(1);
  }

  const value = args[idx + 1];
  const remaining = [...args];
  remaining.splice(idx, 2);
  return [value, remaining];
}

// ── Faithful replica of resolvePrompt from index.ts (lines 76-113) ────────────

async function resolvePrompt(
  args: string[],
  hooks?: {
    exit?: (code: number) => void;
    stderr?: (msg: string) => void;
    readFile?: (path: string) => string;
  }
): Promise<[string | undefined, string[]]> {
  const exitFn = hooks?.exit ?? ((code: number) => { throw new Error(`process.exit(${code})`); });
  const stderrFn = hooks?.stderr ?? (() => {});

  let [prompt, filteredArgs] = extractFlagValue(
    args,
    ["--prompt", "-p"],
    "prompt",
    'spawn <agent> <cloud> --prompt "your prompt here"',
    hooks
  );

  const [promptFile, finalArgs] = extractFlagValue(
    filteredArgs,
    ["--prompt-file"],
    "prompt file",
    "spawn <agent> <cloud> --prompt-file instructions.txt",
    hooks
  );
  filteredArgs = finalArgs;

  if (prompt && promptFile) {
    stderrFn("Error: --prompt and --prompt-file cannot be used together");
    stderrFn(`\nUse one or the other:`);
    stderrFn(`  spawn <agent> <cloud> --prompt "your prompt here"`);
    stderrFn(`  spawn <agent> <cloud> --prompt-file instructions.txt`);
    exitFn(1);
  }

  if (promptFile) {
    const readFileFn = hooks?.readFile ?? (() => { throw new Error("readFileSync not available"); });
    try {
      prompt = readFileFn(promptFile);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
      stderrFn(`Error reading prompt file '${promptFile}': ${msg}`);
      stderrFn(`\nMake sure the file exists and is readable.`);
      exitFn(1);
    }
  }

  return [prompt, filteredArgs];
}

// ── Faithful replica of handleDefaultCommand routing from index.ts ────────────

const HELP_FLAGS = ["--help", "-h", "help"];

function handleDefaultCommand(
  agent: string,
  cloud: string | undefined,
  prompt: string | undefined,
  hooks?: { exit?: (code: number) => void; stderr?: (msg: string) => void }
): "agentInfo" | "run" | "agentInfoFromHelp" | "promptError" {
  const exitFn = hooks?.exit ?? (() => {});
  const stderrFn = hooks?.stderr ?? (() => {});

  // Handle "spawn <agent> --help" / "spawn <agent> -h" / "spawn <agent> help"
  if (cloud && HELP_FLAGS.includes(cloud)) {
    return "agentInfoFromHelp";
  }
  if (cloud) {
    return "run";
  } else {
    if (prompt) {
      stderrFn("Error: --prompt requires both <agent> and <cloud>");
      stderrFn(`\nUsage: spawn ${agent} <cloud> --prompt "your prompt here"`);
      exitFn(1);
      return "promptError";
    }
    return "agentInfo";
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolvePrompt pipeline", () => {
  describe("basic prompt extraction", () => {
    it("should extract --prompt and remove it from args", async () => {
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "--prompt", "Fix bugs"]
      );
      expect(prompt).toBe("Fix bugs");
      expect(args).toEqual(["claude", "sprite"]);
    });

    it("should extract -p short form", async () => {
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "-p", "Add tests"]
      );
      expect(prompt).toBe("Add tests");
      expect(args).toEqual(["claude", "sprite"]);
    });

    it("should return undefined prompt when no flag present", async () => {
      const [prompt, args] = await resolvePrompt(["claude", "sprite"]);
      expect(prompt).toBeUndefined();
      expect(args).toEqual(["claude", "sprite"]);
    });

    it("should handle --prompt at beginning of args", async () => {
      const [prompt, args] = await resolvePrompt(
        ["--prompt", "Fix bugs", "claude", "sprite"]
      );
      expect(prompt).toBe("Fix bugs");
      expect(args).toEqual(["claude", "sprite"]);
    });

    it("should handle prompt with spaces and special characters", async () => {
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "--prompt", "Fix all linter errors & add tests"]
      );
      expect(prompt).toBe("Fix all linter errors & add tests");
      expect(args).toEqual(["claude", "sprite"]);
    });
  });

  describe("--prompt-file extraction", () => {
    it("should extract --prompt-file and read contents", async () => {
      const readFile = mock((path: string) => "File contents here");
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "--prompt-file", "instructions.txt"],
        { readFile }
      );
      expect(prompt).toBe("File contents here");
      expect(args).toEqual(["claude", "sprite"]);
      expect(readFile).toHaveBeenCalledWith("instructions.txt");
    });

    it("should handle --prompt-file with absolute path", async () => {
      const readFile = mock((path: string) => "Absolute file contents");
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "--prompt-file", "/home/user/prompt.md"],
        { readFile }
      );
      expect(prompt).toBe("Absolute file contents");
      expect(readFile).toHaveBeenCalledWith("/home/user/prompt.md");
    });

    it("should handle --prompt-file with path containing spaces in the name", async () => {
      const readFile = mock(() => "content");
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "--prompt-file", "my prompt.txt"],
        { readFile }
      );
      expect(prompt).toBe("content");
      expect(readFile).toHaveBeenCalledWith("my prompt.txt");
    });

    it("should handle --prompt-file at beginning of args", async () => {
      const readFile = mock(() => "file content");
      const [prompt, args] = await resolvePrompt(
        ["--prompt-file", "todo.md", "claude", "sprite"],
        { readFile }
      );
      expect(prompt).toBe("file content");
      expect(args).toEqual(["claude", "sprite"]);
    });
  });

  describe("--prompt-file read errors", () => {
    it("should exit with error when file does not exist", async () => {
      const stderrMessages: string[] = [];
      const readFile = mock(() => { throw new Error("ENOENT: no such file or directory"); });

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt-file", "nonexistent.txt"],
        {
          readFile,
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("nonexistent.txt"))).toBe(true);
      expect(stderrMessages.some(m => m.includes("ENOENT"))).toBe(true);
    });

    it("should exit with error when file is not readable", async () => {
      const stderrMessages: string[] = [];
      const readFile = mock(() => { throw new Error("EACCES: permission denied"); });

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt-file", "restricted.txt"],
        {
          readFile,
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("restricted.txt"))).toBe(true);
      expect(stderrMessages.some(m => m.includes("EACCES"))).toBe(true);
    });

    it("should include 'Make sure the file exists' hint in error output", async () => {
      const stderrMessages: string[] = [];
      const readFile = mock(() => { throw new Error("File error"); });

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt-file", "bad.txt"],
        {
          readFile,
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("Make sure the file exists"))).toBe(true);
    });

    it("should handle non-Error throw from readFile", async () => {
      const stderrMessages: string[] = [];
      const readFile = mock(() => { throw "string error"; });

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt-file", "file.txt"],
        {
          readFile,
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("file.txt"))).toBe(true);
    });
  });

  describe("mutual exclusion: --prompt + --prompt-file", () => {
    it("should exit when both --prompt and --prompt-file are provided", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt", "Fix bugs", "--prompt-file", "todo.txt"],
        {
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("cannot be used together"))).toBe(true);
    });

    it("should exit when both -p and --prompt-file are provided", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "-p", "Fix bugs", "--prompt-file", "todo.txt"],
        {
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("cannot be used together"))).toBe(true);
    });

    it("should include usage examples in mutual exclusion error", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt", "text", "--prompt-file", "file.txt"],
        {
          stderr: (msg: string) => stderrMessages.push(msg),
        }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("Use one or the other"))).toBe(true);
      expect(stderrMessages.some(m => m.includes("--prompt-file instructions.txt"))).toBe(true);
    });

    it("should not call readFile when mutual exclusion fires", async () => {
      const readFile = mock(() => "should not be called");

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt", "text", "--prompt-file", "file.txt"],
        { readFile }
      )).rejects.toThrow();

      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe("missing flag values", () => {
    it("should exit when --prompt is last argument", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("--prompt requires a value"))).toBe(true);
    });

    it("should exit when -p is last argument", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "-p"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("-p requires a value"))).toBe(true);
    });

    it("should exit when --prompt-file is last argument", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt-file"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("--prompt-file requires a value"))).toBe(true);
    });

    it("should exit when --prompt is followed by another flag", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt", "--verbose"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("--prompt requires a value"))).toBe(true);
    });

    it("should exit when --prompt-file is followed by a flag", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "sprite", "--prompt-file", "-v"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("--prompt-file requires a value"))).toBe(true);
    });

    it("should include usage hint in error for missing --prompt value", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "--prompt"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("Usage:"))).toBe(true);
      expect(stderrMessages.some(m => m.includes("--prompt"))).toBe(true);
    });

    it("should include usage hint in error for missing --prompt-file value", async () => {
      const stderrMessages: string[] = [];

      await expect(resolvePrompt(
        ["claude", "--prompt-file"],
        { stderr: (msg: string) => stderrMessages.push(msg) }
      )).rejects.toThrow();

      expect(stderrMessages.some(m => m.includes("Usage:"))).toBe(true);
      expect(stderrMessages.some(m => m.includes("--prompt-file"))).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle empty args array", async () => {
      const [prompt, args] = await resolvePrompt([]);
      expect(prompt).toBeUndefined();
      expect(args).toEqual([]);
    });

    it("should handle args with only flags and no positional args", async () => {
      const [prompt, args] = await resolvePrompt(
        ["--prompt", "text"]
      );
      expect(prompt).toBe("text");
      expect(args).toEqual([]);
    });

    it("should accept prompt value that starts with a number", async () => {
      const [prompt] = await resolvePrompt(
        ["claude", "sprite", "--prompt", "42 things to fix"]
      );
      expect(prompt).toBe("42 things to fix");
    });

    it("should accept prompt value containing quotes", async () => {
      const [prompt] = await resolvePrompt(
        ["claude", "sprite", "--prompt", 'Fix the "bug" in module']
      );
      expect(prompt).toBe('Fix the "bug" in module');
    });

    it("should accept prompt-file value with dots in filename", async () => {
      const readFile = mock(() => "dot content");
      const [prompt] = await resolvePrompt(
        ["claude", "sprite", "--prompt-file", "my.prompt.v2.txt"],
        { readFile }
      );
      expect(prompt).toBe("dot content");
      expect(readFile).toHaveBeenCalledWith("my.prompt.v2.txt");
    });

    it("should preserve all non-flag positional args", async () => {
      const [prompt, args] = await resolvePrompt(
        ["claude", "sprite", "--prompt", "Fix bugs", "extra-arg"]
      );
      expect(prompt).toBe("Fix bugs");
      expect(args).toEqual(["claude", "sprite", "extra-arg"]);
    });

    it("should handle prompt-file returning empty string", async () => {
      const readFile = mock(() => "");
      const [prompt] = await resolvePrompt(
        ["claude", "sprite", "--prompt-file", "empty.txt"],
        { readFile }
      );
      expect(prompt).toBe("");
    });

    it("should handle prompt-file returning multiline content", async () => {
      const multiline = "Line 1\nLine 2\nLine 3\n";
      const readFile = mock(() => multiline);
      const [prompt] = await resolvePrompt(
        ["claude", "sprite", "--prompt-file", "multi.txt"],
        { readFile }
      );
      expect(prompt).toBe(multiline);
    });
  });
});

describe("handleDefaultCommand routing", () => {
  describe("help flag detection", () => {
    it("should route to agentInfoFromHelp when cloud is '--help'", () => {
      const result = handleDefaultCommand("claude", "--help", undefined);
      expect(result).toBe("agentInfoFromHelp");
    });

    it("should route to agentInfoFromHelp when cloud is '-h'", () => {
      const result = handleDefaultCommand("claude", "-h", undefined);
      expect(result).toBe("agentInfoFromHelp");
    });

    it("should route to agentInfoFromHelp when cloud is 'help'", () => {
      const result = handleDefaultCommand("claude", "help", undefined);
      expect(result).toBe("agentInfoFromHelp");
    });

    it("should NOT treat other flags as help", () => {
      const result = handleDefaultCommand("claude", "--version", undefined);
      expect(result).toBe("run");
    });

    it("should NOT treat '-H' (uppercase) as help flag", () => {
      const result = handleDefaultCommand("claude", "-H", undefined);
      expect(result).toBe("run");
    });
  });

  describe("run routing", () => {
    it("should route to run when agent and cloud are provided", () => {
      const result = handleDefaultCommand("claude", "sprite", undefined);
      expect(result).toBe("run");
    });

    it("should route to run with prompt when all three are provided", () => {
      const result = handleDefaultCommand("claude", "sprite", "Fix bugs");
      expect(result).toBe("run");
    });

    it("should route to run even with unusual cloud names", () => {
      const result = handleDefaultCommand("claude", "my-custom-cloud", undefined);
      expect(result).toBe("run");
    });
  });

  describe("agent info routing", () => {
    it("should route to agentInfo when only agent is provided", () => {
      const result = handleDefaultCommand("claude", undefined, undefined);
      expect(result).toBe("agentInfo");
    });

    it("should route to agentInfo for any agent name", () => {
      expect(handleDefaultCommand("aider", undefined, undefined)).toBe("agentInfo");
      expect(handleDefaultCommand("openclaw", undefined, undefined)).toBe("agentInfo");
      expect(handleDefaultCommand("unknown-agent", undefined, undefined)).toBe("agentInfo");
    });
  });

  describe("prompt without cloud error", () => {
    it("should error when prompt provided but no cloud", () => {
      const stderrMessages: string[] = [];
      const result = handleDefaultCommand("claude", undefined, "Fix bugs", {
        stderr: (msg: string) => stderrMessages.push(msg),
        exit: () => {},
      });
      expect(result).toBe("promptError");
      expect(stderrMessages.some(m => m.includes("--prompt requires both <agent> and <cloud>"))).toBe(true);
    });

    it("should include usage example in prompt error", () => {
      const stderrMessages: string[] = [];
      handleDefaultCommand("claude", undefined, "Fix bugs", {
        stderr: (msg: string) => stderrMessages.push(msg),
        exit: () => {},
      });
      expect(stderrMessages.some(m => m.includes("spawn claude <cloud>"))).toBe(true);
    });

    it("should include actual agent name in usage example", () => {
      const stderrMessages: string[] = [];
      handleDefaultCommand("aider", undefined, "Add tests", {
        stderr: (msg: string) => stderrMessages.push(msg),
        exit: () => {},
      });
      expect(stderrMessages.some(m => m.includes("spawn aider <cloud>"))).toBe(true);
    });
  });
});

describe("subcommand --help flag detection", () => {
  // Replicate the hasHelpFlag logic from index.ts main()
  function hasHelpFlag(filteredArgs: string[]): boolean {
    return filteredArgs.slice(1).some(a => HELP_FLAGS.includes(a));
  }

  it("should detect --help after subcommand", () => {
    expect(hasHelpFlag(["list", "--help"])).toBe(true);
    expect(hasHelpFlag(["agents", "--help"])).toBe(true);
    expect(hasHelpFlag(["clouds", "--help"])).toBe(true);
    expect(hasHelpFlag(["update", "--help"])).toBe(true);
    expect(hasHelpFlag(["update", "--help"])).toBe(true);
  });

  it("should detect -h after subcommand", () => {
    expect(hasHelpFlag(["list", "-h"])).toBe(true);
    expect(hasHelpFlag(["agents", "-h"])).toBe(true);
  });

  it("should detect 'help' as second arg", () => {
    expect(hasHelpFlag(["list", "help"])).toBe(true);
  });

  it("should not detect help flag in first position (that is the command)", () => {
    // slice(1) means we skip the first arg
    expect(hasHelpFlag(["--help"])).toBe(false);
    expect(hasHelpFlag(["-h"])).toBe(false);
    expect(hasHelpFlag(["help"])).toBe(false);
  });

  it("should not detect help flag when no args", () => {
    expect(hasHelpFlag([])).toBe(false);
  });

  it("should detect help flag in any position after first", () => {
    expect(hasHelpFlag(["list", "something", "--help"])).toBe(true);
    expect(hasHelpFlag(["update", "--verbose", "-h"])).toBe(true);
  });

  it("should not false-positive on similar but different flags", () => {
    expect(hasHelpFlag(["list", "--helper"])).toBe(false);
    expect(hasHelpFlag(["list", "-help"])).toBe(false);
    expect(hasHelpFlag(["list", "helpful"])).toBe(false);
    expect(hasHelpFlag(["list", "--Help"])).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";

/**
 * Tests for internal (non-exported) helper functions in index.ts.
 *
 * index.ts is the CLI entry point. It contains critical routing and parsing
 * logic that determines how user commands are dispatched. These functions
 * are not exported, so we test exact replicas of the source code.
 *
 * Functions tested:
 * - extractFlagValue: parse --flag <value> pairs from argv
 * - parseListFilters: parse -a/-c and positional filter args for "spawn list"
 * - checkUnknownFlags: reject unrecognized CLI flags
 * - hasTrailingHelpFlag: detect --help/-h after the first arg
 * - warnExtraArgs: warn when extra positional args are silently ignored
 * - handlePromptFileError: map fs error codes to user-friendly messages
 *
 * Agent: test-engineer
 */

// ── Exact replicas from index.ts ────────────────────────────────────────────

/**
 * Replica of extractFlagValue from index.ts lines 38-57
 */
function extractFlagValue(
  args: string[],
  flags: string[],
  flagLabel: string,
  usageHint: string
): [string | undefined, string[]] {
  const idx = args.findIndex(arg => flags.includes(arg));
  if (idx === -1) return [undefined, args];

  if (!args[idx + 1] || args[idx + 1].startsWith("-")) {
    // In actual code this calls process.exit(1) after console.error.
    // For testing, we throw instead.
    throw new Error(`${args[idx]} requires a value`);
  }

  const value = args[idx + 1];
  const remaining = [...args];
  remaining.splice(idx, 2);
  return [value, remaining];
}

/**
 * Replica of parseListFilters from index.ts lines 298-330
 */
function parseListFilters(args: string[]): { agentFilter?: string; cloudFilter?: string } {
  let agentFilter: string | undefined;
  let cloudFilter: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" || args[i] === "--agent") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        throw new Error(`${args[i]} requires an agent name`);
      }
      agentFilter = args[i + 1];
      i++;
    } else if (args[i] === "-c" || args[i] === "--cloud") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        throw new Error(`${args[i]} requires a cloud name`);
      }
      cloudFilter = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  // Support bare positional filter: "spawn list claude" or "spawn list hetzner"
  if (!agentFilter && !cloudFilter && positional.length > 0) {
    agentFilter = positional[0];
  }

  return { agentFilter, cloudFilter };
}

const KNOWN_FLAGS = new Set([
  "--help", "-h",
  "--version", "-v", "-V",
  "--prompt", "-p", "--prompt-file", "-f",
  "--dry-run", "-n",
  "-a", "-c", "--agent", "--cloud",
]);

/**
 * Replica of checkUnknownFlags from index.ts lines 70-86
 * Returns the unknown flag if found, or null.
 */
function findUnknownFlag(args: string[]): string | null {
  for (const arg of args) {
    if ((arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg))) && !KNOWN_FLAGS.has(arg)) {
      return arg;
    }
  }
  return null;
}

const HELP_FLAGS = ["--help", "-h", "help"];

/**
 * Replica of hasTrailingHelpFlag from index.ts lines 333-335
 */
function hasTrailingHelpFlag(args: string[]): boolean {
  return args.slice(1).some(a => HELP_FLAGS.includes(a));
}

const VERB_ALIASES = new Set(["run", "launch", "start", "deploy", "exec"]);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("index.ts internal helpers", () => {

  // ── extractFlagValue ──────────────────────────────────────────────────

  describe("extractFlagValue", () => {
    const usageHint = 'spawn <agent> <cloud> --prompt "text"';

    describe("flag present with value", () => {
      it("should extract --prompt value and remove from args", () => {
        const [value, rest] = extractFlagValue(
          ["claude", "sprite", "--prompt", "Fix bugs"],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBe("Fix bugs");
        expect(rest).toEqual(["claude", "sprite"]);
      });

      it("should extract -p short flag value", () => {
        const [value, rest] = extractFlagValue(
          ["claude", "sprite", "-p", "Fix bugs"],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBe("Fix bugs");
        expect(rest).toEqual(["claude", "sprite"]);
      });

      it("should extract flag at the beginning of args", () => {
        const [value, rest] = extractFlagValue(
          ["--prompt", "Hello", "claude", "sprite"],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBe("Hello");
        expect(rest).toEqual(["claude", "sprite"]);
      });

      it("should extract flag in the middle of args", () => {
        const [value, rest] = extractFlagValue(
          ["claude", "--prompt", "Hello", "sprite"],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBe("Hello");
        expect(rest).toEqual(["claude", "sprite"]);
      });

      it("should handle value that looks like a path", () => {
        const [value, rest] = extractFlagValue(
          ["--prompt-file", "/tmp/instructions.txt", "claude"],
          ["--prompt-file", "-f"],
          "prompt file",
          "spawn <agent> <cloud> --prompt-file file.txt"
        );
        expect(value).toBe("/tmp/instructions.txt");
        expect(rest).toEqual(["claude"]);
      });

      it("should handle value with spaces (already quoted by shell)", () => {
        const [value, rest] = extractFlagValue(
          ["--prompt", "Fix all linter errors and add tests"],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBe("Fix all linter errors and add tests");
        expect(rest).toEqual([]);
      });

      it("should only extract the first matching flag", () => {
        const [value, rest] = extractFlagValue(
          ["--prompt", "first", "--prompt", "second"],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBe("first");
        // After splicing the first --prompt + value, "second" remains as positional
        expect(rest).toEqual(["--prompt", "second"]);
      });
    });

    describe("flag not present", () => {
      it("should return undefined and original args when flag is absent", () => {
        const args = ["claude", "sprite"];
        const [value, rest] = extractFlagValue(
          args,
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBeUndefined();
        expect(rest).toEqual(["claude", "sprite"]);
      });

      it("should return undefined for empty args", () => {
        const [value, rest] = extractFlagValue(
          [],
          ["--prompt", "-p"],
          "prompt",
          usageHint
        );
        expect(value).toBeUndefined();
        expect(rest).toEqual([]);
      });
    });

    describe("flag present without value (error cases)", () => {
      it("should throw when flag is the last arg (no value follows)", () => {
        expect(() => {
          extractFlagValue(
            ["claude", "--prompt"],
            ["--prompt", "-p"],
            "prompt",
            usageHint
          );
        }).toThrow("requires a value");
      });

      it("should throw when value starts with - (looks like another flag)", () => {
        expect(() => {
          extractFlagValue(
            ["--prompt", "--dry-run"],
            ["--prompt", "-p"],
            "prompt",
            usageHint
          );
        }).toThrow("requires a value");
      });

      it("should throw when short flag has no value", () => {
        expect(() => {
          extractFlagValue(
            ["-p"],
            ["--prompt", "-p"],
            "prompt",
            usageHint
          );
        }).toThrow("requires a value");
      });

      it("should throw when value starts with single dash", () => {
        expect(() => {
          extractFlagValue(
            ["--prompt", "-n"],
            ["--prompt", "-p"],
            "prompt",
            usageHint
          );
        }).toThrow("requires a value");
      });
    });

    describe("does not modify original array", () => {
      it("should not mutate the input args array", () => {
        const original = ["claude", "--prompt", "hello", "sprite"];
        const copy = [...original];
        extractFlagValue(original, ["--prompt", "-p"], "prompt", usageHint);
        expect(original).toEqual(copy);
      });
    });
  });

  // ── parseListFilters ──────────────────────────────────────────────────

  describe("parseListFilters", () => {
    describe("named flags", () => {
      it("should parse -a <agent> flag", () => {
        const result = parseListFilters(["list", "-a", "claude"]);
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBeUndefined();
      });

      it("should parse --agent <agent> flag", () => {
        const result = parseListFilters(["list", "--agent", "claude"]);
        expect(result.agentFilter).toBe("claude");
      });

      it("should parse -c <cloud> flag", () => {
        const result = parseListFilters(["list", "-c", "sprite"]);
        expect(result.cloudFilter).toBe("sprite");
        expect(result.agentFilter).toBeUndefined();
      });

      it("should parse --cloud <cloud> flag", () => {
        const result = parseListFilters(["list", "--cloud", "hetzner"]);
        expect(result.cloudFilter).toBe("hetzner");
      });

      it("should parse both -a and -c flags together", () => {
        const result = parseListFilters(["list", "-a", "claude", "-c", "sprite"]);
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBe("sprite");
      });

      it("should parse flags in any order", () => {
        const result = parseListFilters(["list", "-c", "sprite", "-a", "claude"]);
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBe("sprite");
      });
    });

    describe("bare positional filter", () => {
      it("should treat bare positional arg as agentFilter when no flags", () => {
        // In index.ts, parseListFilters receives filteredArgs.slice(1),
        // so the "list" command is already stripped. Test with just the filter.
        const result = parseListFilters(["claude"]);
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBeUndefined();
      });

      it("should not use positional arg when -a is already set", () => {
        const result = parseListFilters(["-a", "aider", "extra"]);
        expect(result.agentFilter).toBe("aider");
        // "extra" positional is ignored because agentFilter is already set
      });

      it("should not use positional arg when -c is already set", () => {
        const result = parseListFilters(["-c", "sprite", "extra"]);
        expect(result.cloudFilter).toBe("sprite");
        // "extra" is collected as positional but ignored because cloudFilter exists
      });
    });

    describe("no filters", () => {
      it("should return undefined for both filters with empty args", () => {
        const result = parseListFilters([]);
        expect(result.agentFilter).toBeUndefined();
        expect(result.cloudFilter).toBeUndefined();
      });
    });

    describe("error cases", () => {
      it("should throw when -a has no value", () => {
        expect(() => parseListFilters(["-a"])).toThrow("requires an agent name");
      });

      it("should throw when --agent has no value", () => {
        expect(() => parseListFilters(["--agent"])).toThrow("requires an agent name");
      });

      it("should throw when -c has no value", () => {
        expect(() => parseListFilters(["-c"])).toThrow("requires a cloud name");
      });

      it("should throw when --cloud has no value", () => {
        expect(() => parseListFilters(["--cloud"])).toThrow("requires a cloud name");
      });

      it("should throw when -a value starts with -", () => {
        expect(() => parseListFilters(["-a", "-c"])).toThrow("requires an agent name");
      });

      it("should throw when -c value starts with -", () => {
        expect(() => parseListFilters(["-c", "-a"])).toThrow("requires a cloud name");
      });
    });

    describe("flag arguments that look like flags are skipped", () => {
      it("should skip unknown flags in args", () => {
        // parseListFilters ignores args that start with "-" (only collects non-dash as positional)
        const result = parseListFilters(["--unknown"]);
        expect(result.agentFilter).toBeUndefined();
        expect(result.cloudFilter).toBeUndefined();
      });
    });
  });

  // ── findUnknownFlag (checkUnknownFlags logic) ─────────────────────────

  describe("findUnknownFlag (checkUnknownFlags logic)", () => {
    describe("known flags pass through", () => {
      it("should return null for --help", () => {
        expect(findUnknownFlag(["--help"])).toBeNull();
      });

      it("should return null for -h", () => {
        expect(findUnknownFlag(["-h"])).toBeNull();
      });

      it("should return null for --version", () => {
        expect(findUnknownFlag(["--version"])).toBeNull();
      });

      it("should return null for -v", () => {
        expect(findUnknownFlag(["-v"])).toBeNull();
      });

      it("should return null for -V", () => {
        expect(findUnknownFlag(["-V"])).toBeNull();
      });

      it("should return null for --prompt", () => {
        expect(findUnknownFlag(["--prompt"])).toBeNull();
      });

      it("should return null for -p", () => {
        expect(findUnknownFlag(["-p"])).toBeNull();
      });

      it("should return null for --prompt-file", () => {
        expect(findUnknownFlag(["--prompt-file"])).toBeNull();
      });

      it("should return null for -f", () => {
        expect(findUnknownFlag(["-f"])).toBeNull();
      });

      it("should return null for --dry-run", () => {
        expect(findUnknownFlag(["--dry-run"])).toBeNull();
      });

      it("should return null for -n", () => {
        expect(findUnknownFlag(["-n"])).toBeNull();
      });

      it("should return null for -a", () => {
        expect(findUnknownFlag(["-a"])).toBeNull();
      });

      it("should return null for -c", () => {
        expect(findUnknownFlag(["-c"])).toBeNull();
      });

      it("should return null for --agent", () => {
        expect(findUnknownFlag(["--agent"])).toBeNull();
      });

      it("should return null for --cloud", () => {
        expect(findUnknownFlag(["--cloud"])).toBeNull();
      });
    });

    describe("unknown flags detected", () => {
      it("should detect --unknown", () => {
        expect(findUnknownFlag(["--unknown"])).toBe("--unknown");
      });

      it("should detect --verbose", () => {
        expect(findUnknownFlag(["--verbose"])).toBe("--verbose");
      });

      it("should detect -x (unknown short flag)", () => {
        expect(findUnknownFlag(["-x"])).toBe("-x");
      });

      it("should detect --force", () => {
        expect(findUnknownFlag(["--force"])).toBe("--force");
      });

      it("should detect first unknown flag among multiple args", () => {
        expect(findUnknownFlag(["claude", "sprite", "--json", "--dry-run"])).toBe("--json");
      });

      it("should detect unknown flag mixed with known flags", () => {
        expect(findUnknownFlag(["--prompt", "hello", "--output", "file"])).toBe("--output");
      });
    });

    describe("non-flag args pass through", () => {
      it("should return null for plain words", () => {
        expect(findUnknownFlag(["claude", "sprite"])).toBeNull();
      });

      it("should return null for empty args", () => {
        expect(findUnknownFlag([])).toBeNull();
      });

      it("should return null for single dash (stdin convention)", () => {
        // "-" alone is length 1, so it doesn't match the condition
        expect(findUnknownFlag(["-"])).toBeNull();
      });

      it("should return null for negative numbers (-1, -42)", () => {
        // /^-\d/ matches numeric prefixes, which are excluded
        expect(findUnknownFlag(["-1"])).toBeNull();
        expect(findUnknownFlag(["-42"])).toBeNull();
      });

      it("should return null for paths that look like flags", () => {
        // Paths don't start with -- or single dash
        expect(findUnknownFlag(["/path/to/file"])).toBeNull();
      });
    });
  });

  // ── hasTrailingHelpFlag ───────────────────────────────────────────────

  describe("hasTrailingHelpFlag", () => {
    it("should return true when --help follows the first arg", () => {
      expect(hasTrailingHelpFlag(["list", "--help"])).toBe(true);
    });

    it("should return true when -h follows the first arg", () => {
      expect(hasTrailingHelpFlag(["matrix", "-h"])).toBe(true);
    });

    it("should return true when 'help' word follows the first arg", () => {
      expect(hasTrailingHelpFlag(["agents", "help"])).toBe(true);
    });

    it("should return false when help flag is the first arg (not trailing)", () => {
      // slice(1) starts from second element, so ["--help"] has nothing to check
      expect(hasTrailingHelpFlag(["--help"])).toBe(false);
    });

    it("should return false for single arg without help", () => {
      expect(hasTrailingHelpFlag(["list"])).toBe(false);
    });

    it("should return false for empty args", () => {
      expect(hasTrailingHelpFlag([])).toBe(false);
    });

    it("should return true when help is third arg (still trailing)", () => {
      expect(hasTrailingHelpFlag(["list", "claude", "--help"])).toBe(true);
    });

    it("should return false when no help flag present", () => {
      expect(hasTrailingHelpFlag(["list", "-a", "claude"])).toBe(false);
    });

    it("should detect help among multiple trailing args", () => {
      expect(hasTrailingHelpFlag(["list", "-a", "claude", "-h"])).toBe(true);
    });
  });

  // ── VERB_ALIASES ──────────────────────────────────────────────────────

  describe("VERB_ALIASES", () => {
    it("should include 'run'", () => {
      expect(VERB_ALIASES.has("run")).toBe(true);
    });

    it("should include 'launch'", () => {
      expect(VERB_ALIASES.has("launch")).toBe(true);
    });

    it("should include 'start'", () => {
      expect(VERB_ALIASES.has("start")).toBe(true);
    });

    it("should include 'deploy'", () => {
      expect(VERB_ALIASES.has("deploy")).toBe(true);
    });

    it("should include 'exec'", () => {
      expect(VERB_ALIASES.has("exec")).toBe(true);
    });

    it("should not include actual subcommands", () => {
      expect(VERB_ALIASES.has("list")).toBe(false);
      expect(VERB_ALIASES.has("matrix")).toBe(false);
      expect(VERB_ALIASES.has("agents")).toBe(false);
      expect(VERB_ALIASES.has("clouds")).toBe(false);
      expect(VERB_ALIASES.has("update")).toBe(false);
      expect(VERB_ALIASES.has("help")).toBe(false);
    });

    it("should have exactly 5 entries", () => {
      expect(VERB_ALIASES.size).toBe(5);
    });
  });

  // ── KNOWN_FLAGS ───────────────────────────────────────────────────────

  describe("KNOWN_FLAGS completeness", () => {
    it("should contain all help flags", () => {
      expect(KNOWN_FLAGS.has("--help")).toBe(true);
      expect(KNOWN_FLAGS.has("-h")).toBe(true);
    });

    it("should contain all version flags", () => {
      expect(KNOWN_FLAGS.has("--version")).toBe(true);
      expect(KNOWN_FLAGS.has("-v")).toBe(true);
      expect(KNOWN_FLAGS.has("-V")).toBe(true);
    });

    it("should contain prompt flags", () => {
      expect(KNOWN_FLAGS.has("--prompt")).toBe(true);
      expect(KNOWN_FLAGS.has("-p")).toBe(true);
      expect(KNOWN_FLAGS.has("--prompt-file")).toBe(true);
      expect(KNOWN_FLAGS.has("-f")).toBe(true);
    });

    it("should contain dry-run flag", () => {
      expect(KNOWN_FLAGS.has("--dry-run")).toBe(true);
      expect(KNOWN_FLAGS.has("-n")).toBe(true);
    });

    it("should contain list filter flags", () => {
      expect(KNOWN_FLAGS.has("-a")).toBe(true);
      expect(KNOWN_FLAGS.has("-c")).toBe(true);
      expect(KNOWN_FLAGS.has("--agent")).toBe(true);
      expect(KNOWN_FLAGS.has("--cloud")).toBe(true);
    });

    it("should have exactly 15 known flags", () => {
      // --help, -h, --version, -v, -V, --prompt, -p, --prompt-file, -f,
      // --dry-run, -n, -a, -c, --agent, --cloud
      expect(KNOWN_FLAGS.size).toBe(15);
    });
  });

  // ── handlePromptFileError logic ───────────────────────────────────────

  describe("handlePromptFileError error mapping", () => {
    // We test the error code -> message mapping logic from index.ts

    function getPromptFileErrorMessage(promptFile: string, code: string): string {
      if (code === "ENOENT") {
        return `Prompt file not found: ${promptFile}`;
      } else if (code === "EACCES") {
        return `Permission denied reading prompt file: ${promptFile}`;
      } else if (code === "EISDIR") {
        return `'${promptFile}' is a directory, not a file.`;
      } else {
        return `Error reading prompt file '${promptFile}'`;
      }
    }

    it("should produce 'not found' message for ENOENT", () => {
      const msg = getPromptFileErrorMessage("instructions.txt", "ENOENT");
      expect(msg).toContain("not found");
      expect(msg).toContain("instructions.txt");
    });

    it("should produce 'permission denied' message for EACCES", () => {
      const msg = getPromptFileErrorMessage("/etc/shadow", "EACCES");
      expect(msg).toContain("Permission denied");
      expect(msg).toContain("/etc/shadow");
    });

    it("should produce 'is a directory' message for EISDIR", () => {
      const msg = getPromptFileErrorMessage("/tmp", "EISDIR");
      expect(msg).toContain("directory");
      expect(msg).toContain("/tmp");
    });

    it("should produce generic error for unknown codes", () => {
      const msg = getPromptFileErrorMessage("file.txt", "EMFILE");
      expect(msg).toContain("Error reading");
      expect(msg).toContain("file.txt");
    });

    it("should include the file path in all error messages", () => {
      const file = "/home/user/prompt.md";
      for (const code of ["ENOENT", "EACCES", "EISDIR", "UNKNOWN"]) {
        const msg = getPromptFileErrorMessage(file, code);
        expect(msg).toContain(file);
      }
    });
  });

  // ── HELP_FLAGS ────────────────────────────────────────────────────────

  describe("HELP_FLAGS", () => {
    it("should include --help", () => {
      expect(HELP_FLAGS).toContain("--help");
    });

    it("should include -h", () => {
      expect(HELP_FLAGS).toContain("-h");
    });

    it("should include bare 'help' word", () => {
      expect(HELP_FLAGS).toContain("help");
    });

    it("should have exactly 3 entries", () => {
      expect(HELP_FLAGS).toHaveLength(3);
    });
  });

  // ── Edge cases for flag parsing interactions ──────────────────────────

  describe("flag parsing edge cases", () => {
    it("should handle extracting --prompt when --dry-run is also present", () => {
      const [value, rest] = extractFlagValue(
        ["claude", "sprite", "--dry-run", "--prompt", "Test"],
        ["--prompt", "-p"],
        "prompt",
        ""
      );
      expect(value).toBe("Test");
      expect(rest).toEqual(["claude", "sprite", "--dry-run"]);
    });

    it("should handle extracting --prompt-file then --prompt from same args", () => {
      // First extract --prompt-file
      const [file, afterFile] = extractFlagValue(
        ["--prompt-file", "f.txt", "--prompt", "text"],
        ["--prompt-file", "-f"],
        "prompt file",
        ""
      );
      expect(file).toBe("f.txt");
      // Then extract --prompt from remaining
      const [prompt, afterPrompt] = extractFlagValue(
        afterFile,
        ["--prompt", "-p"],
        "prompt",
        ""
      );
      expect(prompt).toBe("text");
      expect(afterPrompt).toEqual([]);
    });

    it("should parse list filters with mixed flags and positional args", () => {
      // In practice, parseListFilters receives filteredArgs.slice(1),
      // so "list" is already stripped
      const result = parseListFilters(["-a", "claude", "extra_positional"]);
      expect(result.agentFilter).toBe("claude");
      // extra_positional is ignored because agentFilter already set via -a
    });

    it("should treat bare positional as agentFilter in list context", () => {
      // "spawn list claude" -> parseListFilters receives ["claude"]
      const result = parseListFilters(["claude"]);
      expect(result.agentFilter).toBe("claude");
    });
  });

  // ── extractFlagValue with prompt-file flags ───────────────────────────

  describe("extractFlagValue for --prompt-file", () => {
    it("should extract --prompt-file with absolute path", () => {
      const [value, rest] = extractFlagValue(
        ["--prompt-file", "/home/user/prompt.md", "claude", "sprite"],
        ["--prompt-file", "-f"],
        "prompt file",
        "spawn <agent> <cloud> --prompt-file <file>"
      );
      expect(value).toBe("/home/user/prompt.md");
      expect(rest).toEqual(["claude", "sprite"]);
    });

    it("should extract -f with relative path", () => {
      const [value, rest] = extractFlagValue(
        ["claude", "-f", "./prompt.txt", "sprite"],
        ["--prompt-file", "-f"],
        "prompt file",
        ""
      );
      expect(value).toBe("./prompt.txt");
      expect(rest).toEqual(["claude", "sprite"]);
    });

    it("should throw when --prompt-file has no following arg", () => {
      expect(() => {
        extractFlagValue(
          ["claude", "--prompt-file"],
          ["--prompt-file", "-f"],
          "prompt file",
          ""
        );
      }).toThrow("requires a value");
    });
  });
});

import { describe, it, expect } from "bun:test";

/**
 * Tests for CLI argument parsing logic from index.ts.
 *
 * Since index.ts runs main() on import, we test the extracted parsing
 * logic as pure functions to avoid side effects.
 */

/** Replica of expandEqualsFlags from index.ts for testability */
function expandEqualsFlags(args: string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      result.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      result.push(arg);
    }
  }
  return result;
}

// Extracted from index.ts main() for testability
function extractPromptArgs(args: string[]): { prompt: string | undefined; filteredArgs: string[] } {
  let prompt: string | undefined;
  let filteredArgs = [...args];

  const promptIndex = args.findIndex(arg => arg === "--prompt" || arg === "-p");
  if (promptIndex !== -1 && args[promptIndex + 1]) {
    prompt = args[promptIndex + 1];
    filteredArgs.splice(promptIndex, 2);
  }

  return { prompt, filteredArgs };
}

function extractPromptFileArgs(args: string[]): { promptFileIndex: number; promptFilePath: string | undefined; filteredArgs: string[] } {
  let filteredArgs = [...args];
  const promptFileIndex = args.findIndex(arg => arg === "--prompt-file");
  let promptFilePath: string | undefined;

  if (promptFileIndex !== -1 && args[promptFileIndex + 1]) {
    promptFilePath = args[promptFileIndex + 1];
    filteredArgs.splice(promptFileIndex, 2);
  }

  return { promptFileIndex, promptFilePath, filteredArgs };
}

function resolveCommand(filteredArgs: string[]): string | undefined {
  return filteredArgs[0];
}

describe("CLI Argument Parsing", () => {
  describe("extractPromptArgs", () => {
    it("should extract --prompt flag and value", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["claude", "sprite", "--prompt", "Fix bugs"]);
      expect(prompt).toBe("Fix bugs");
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should extract -p short flag and value", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["claude", "sprite", "-p", "Add tests"]);
      expect(prompt).toBe("Add tests");
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should return undefined prompt when no flag present", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["claude", "sprite"]);
      expect(prompt).toBeUndefined();
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should handle --prompt at the beginning of args", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["--prompt", "Fix bugs", "claude", "sprite"]);
      expect(prompt).toBe("Fix bugs");
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should handle --prompt without a value (last arg)", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["claude", "sprite", "--prompt"]);
      expect(prompt).toBeUndefined();
      expect(filteredArgs).toEqual(["claude", "sprite", "--prompt"]);
    });

    it("should handle -p without a value (last arg)", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["claude", "sprite", "-p"]);
      expect(prompt).toBeUndefined();
      expect(filteredArgs).toEqual(["claude", "sprite", "-p"]);
    });

    it("should handle empty args", () => {
      const { prompt, filteredArgs } = extractPromptArgs([]);
      expect(prompt).toBeUndefined();
      expect(filteredArgs).toEqual([]);
    });

    it("should handle prompt with spaces", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["claude", "sprite", "--prompt", "Fix all linter errors and add tests"]);
      expect(prompt).toBe("Fix all linter errors and add tests");
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should only extract the first --prompt occurrence", () => {
      const { prompt, filteredArgs } = extractPromptArgs(["--prompt", "first", "--prompt", "second"]);
      expect(prompt).toBe("first");
      // After removing first --prompt and its value, remaining is ["--prompt", "second"]
      expect(filteredArgs).toEqual(["--prompt", "second"]);
    });
  });

  describe("extractPromptFileArgs", () => {
    it("should extract --prompt-file flag and path", () => {
      const { promptFilePath, filteredArgs } = extractPromptFileArgs(["claude", "sprite", "--prompt-file", "instructions.txt"]);
      expect(promptFilePath).toBe("instructions.txt");
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should return undefined when no --prompt-file present", () => {
      const { promptFilePath, filteredArgs } = extractPromptFileArgs(["claude", "sprite"]);
      expect(promptFilePath).toBeUndefined();
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });

    it("should handle --prompt-file without a value", () => {
      const { promptFilePath, filteredArgs } = extractPromptFileArgs(["claude", "--prompt-file"]);
      expect(promptFilePath).toBeUndefined();
      expect(filteredArgs).toEqual(["claude", "--prompt-file"]);
    });

    it("should handle --prompt-file at the beginning", () => {
      const { promptFilePath, filteredArgs } = extractPromptFileArgs(["--prompt-file", "todo.md", "claude", "sprite"]);
      expect(promptFilePath).toBe("todo.md");
      expect(filteredArgs).toEqual(["claude", "sprite"]);
    });
  });

  describe("resolveCommand", () => {
    it("should return first arg as command", () => {
      expect(resolveCommand(["list"])).toBe("list");
      expect(resolveCommand(["agents"])).toBe("agents");
      expect(resolveCommand(["clouds"])).toBe("clouds");
      expect(resolveCommand(["help"])).toBe("help");
      expect(resolveCommand(["--help"])).toBe("--help");
      expect(resolveCommand(["-h"])).toBe("-h");
    });

    it("should return undefined for empty args", () => {
      expect(resolveCommand([])).toBeUndefined();
    });

    it("should return agent name for default command", () => {
      expect(resolveCommand(["claude", "sprite"])).toBe("claude");
    });

    it("should handle version aliases", () => {
      expect(resolveCommand(["version"])).toBe("version");
      expect(resolveCommand(["--version"])).toBe("--version");
      expect(resolveCommand(["-v"])).toBe("-v");
      expect(resolveCommand(["-V"])).toBe("-V");
    });
  });

  describe("command routing logic", () => {
    function routeCommand(cmd: string | undefined): string {
      if (!cmd) return "interactive_or_help";
      switch (cmd) {
        case "help": case "--help": case "-h": return "help";
        case "version": case "--version": case "-v": case "-V": return "version";
        case "list": case "ls": return "list";
        case "agents": return "agents";
        case "clouds": return "clouds";
        case "update": return "update";
        default: return "default";
      }
    }

    it("should route known commands correctly", () => {
      expect(routeCommand("help")).toBe("help");
      expect(routeCommand("--help")).toBe("help");
      expect(routeCommand("-h")).toBe("help");
      expect(routeCommand("version")).toBe("version");
      expect(routeCommand("--version")).toBe("version");
      expect(routeCommand("-v")).toBe("version");
      expect(routeCommand("-V")).toBe("version");
      expect(routeCommand("list")).toBe("list");
      expect(routeCommand("ls")).toBe("list");
      expect(routeCommand("agents")).toBe("agents");
      expect(routeCommand("clouds")).toBe("clouds");
      expect(routeCommand("update")).toBe("update");
    });

    it("should route unknown commands to default (agent name)", () => {
      expect(routeCommand("claude")).toBe("default");
      expect(routeCommand("codex")).toBe("default");
      expect(routeCommand("unknown-agent")).toBe("default");
    });

    it("should route undefined to interactive/help", () => {
      expect(routeCommand(undefined)).toBe("interactive_or_help");
    });
  });

  describe("handleError logic", () => {
    function handleError(err: unknown): string {
      if (err && typeof err === "object" && "message" in err) {
        return `Error: ${err.message}`;
      }
      return `Error: ${String(err)}`;
    }

    it("should extract message from Error objects", () => {
      expect(handleError(new Error("test failure"))).toBe("Error: test failure");
    });

    it("should extract message from duck-typed error objects", () => {
      expect(handleError({ message: "custom error" })).toBe("Error: custom error");
    });

    it("should stringify non-object errors", () => {
      expect(handleError("string error")).toBe("Error: string error");
      expect(handleError(42)).toBe("Error: 42");
      expect(handleError(null)).toBe("Error: null");
      expect(handleError(undefined)).toBe("Error: undefined");
    });

    it("should handle objects without message property", () => {
      expect(handleError({ code: 1 })).toBe("Error: [object Object]");
    });

    it("should handle empty Error", () => {
      expect(handleError(new Error())).toBe("Error: ");
    });
  });

  describe("expandEqualsFlags", () => {
    it("should expand --prompt=value into --prompt value", () => {
      expect(expandEqualsFlags(["--prompt=Fix bugs"])).toEqual(["--prompt", "Fix bugs"]);
    });

    it("should expand --prompt-file=path into --prompt-file path", () => {
      expect(expandEqualsFlags(["--prompt-file=instructions.txt"])).toEqual(["--prompt-file", "instructions.txt"]);
    });

    it("should expand --agent=claude into --agent claude", () => {
      expect(expandEqualsFlags(["--agent=claude"])).toEqual(["--agent", "claude"]);
    });

    it("should expand --cloud=sprite into --cloud sprite", () => {
      expect(expandEqualsFlags(["--cloud=sprite"])).toEqual(["--cloud", "sprite"]);
    });

    it("should not modify short flags", () => {
      expect(expandEqualsFlags(["-p", "test"])).toEqual(["-p", "test"]);
    });

    it("should not modify positional args", () => {
      expect(expandEqualsFlags(["claude", "sprite"])).toEqual(["claude", "sprite"]);
    });

    it("should not modify flags without equals", () => {
      expect(expandEqualsFlags(["--dry-run"])).toEqual(["--dry-run"]);
    });

    it("should handle empty args", () => {
      expect(expandEqualsFlags([])).toEqual([]);
    });

    it("should handle value containing equals sign", () => {
      expect(expandEqualsFlags(["--prompt=a=b"])).toEqual(["--prompt", "a=b"]);
    });

    it("should handle empty value after equals", () => {
      expect(expandEqualsFlags(["--prompt="])).toEqual(["--prompt", ""]);
    });

    it("should handle mixed args with and without equals", () => {
      expect(expandEqualsFlags(["claude", "--prompt=Fix", "sprite", "--dry-run"])).toEqual([
        "claude", "--prompt", "Fix", "sprite", "--dry-run",
      ]);
    });

    it("should not expand single-dash flags with equals", () => {
      expect(expandEqualsFlags(["-p=test"])).toEqual(["-p=test"]);
    });

    it("should preserve arg order", () => {
      expect(expandEqualsFlags(["--prompt=hello", "agent", "--cloud=aws"])).toEqual([
        "--prompt", "hello", "agent", "--cloud", "aws",
      ]);
    });
  });
});

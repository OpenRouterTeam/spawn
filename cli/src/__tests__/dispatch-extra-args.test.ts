import { describe, it, expect } from "bun:test";

/**
 * Tests for warnExtraArgs and dispatchCommand routing logic from index.ts.
 *
 * These functions were added/refactored in PR #422 and have zero test coverage.
 * Since they are not exported and index.ts runs main() on import, we replicate
 * the pure logic here for unit testing.
 *
 * Covered:
 * - warnExtraArgs: warns on extra positional args with correct pluralization
 * - dispatchCommand routing: IMMEDIATE_COMMANDS, SUBCOMMANDS, default handler
 * - SUBCOMMANDS help flag pass-through: "spawn list --help" shows general help
 * - showVersion: output format
 */

// ── Replica of warnExtraArgs from index.ts ───────────────────────────────────

function warnExtraArgs(
  filteredArgs: string[],
  maxExpected: number
): { warned: boolean; extra: string[]; message: string } {
  const extra = filteredArgs.slice(maxExpected);
  if (extra.length > 0) {
    const message = `Warning: extra argument${extra.length > 1 ? "s" : ""} ignored: ${extra.join(", ")}`;
    return { warned: true, extra, message };
  }
  return { warned: false, extra: [], message: "" };
}

// ── Replica of dispatchCommand routing logic ─────────────────────────────────

const HELP_FLAGS = ["--help", "-h", "help"];

const IMMEDIATE_COMMAND_KEYS = new Set([
  "help", "--help", "-h",
  "version", "--version", "-v", "-V",
]);

const SUBCOMMAND_KEYS = new Set([
  "list", "ls", "matrix", "m", "agents", "clouds", "update",
]);

type DispatchResult =
  | { type: "immediate"; cmd: string; extraWarning: ReturnType<typeof warnExtraArgs> }
  | { type: "subcommand"; cmd: string; helpRedirect: boolean; extraWarning: ReturnType<typeof warnExtraArgs> }
  | { type: "default"; agent: string; cloud: string | undefined; prompt: string | undefined; extraWarning: ReturnType<typeof warnExtraArgs> };

function dispatchCommand(
  cmd: string,
  filteredArgs: string[],
  prompt: string | undefined
): DispatchResult {
  if (IMMEDIATE_COMMAND_KEYS.has(cmd)) {
    return {
      type: "immediate",
      cmd,
      extraWarning: warnExtraArgs(filteredArgs, 1),
    };
  }

  if (SUBCOMMAND_KEYS.has(cmd)) {
    const hasHelpFlag = filteredArgs.slice(1).some(a => HELP_FLAGS.includes(a));
    if (hasHelpFlag) {
      return {
        type: "subcommand",
        cmd,
        helpRedirect: true,
        extraWarning: warnExtraArgs(filteredArgs, 1),
      };
    }
    return {
      type: "subcommand",
      cmd,
      helpRedirect: false,
      extraWarning: warnExtraArgs(filteredArgs, 1),
    };
  }

  return {
    type: "default",
    agent: filteredArgs[0],
    cloud: filteredArgs[1],
    prompt,
    extraWarning: warnExtraArgs(filteredArgs, 2),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("warnExtraArgs", () => {
  describe("no warning cases", () => {
    it("should not warn when args fit within maxExpected", () => {
      const result = warnExtraArgs(["list"], 1);
      expect(result.warned).toBe(false);
      expect(result.extra).toEqual([]);
    });

    it("should not warn when args exactly match maxExpected", () => {
      const result = warnExtraArgs(["claude", "sprite"], 2);
      expect(result.warned).toBe(false);
      expect(result.extra).toEqual([]);
    });

    it("should not warn for empty args", () => {
      const result = warnExtraArgs([], 0);
      expect(result.warned).toBe(false);
    });

    it("should not warn when fewer args than maxExpected", () => {
      const result = warnExtraArgs(["claude"], 2);
      expect(result.warned).toBe(false);
    });
  });

  describe("warning cases", () => {
    it("should warn on single extra arg with singular form", () => {
      const result = warnExtraArgs(["list", "extra1"], 1);
      expect(result.warned).toBe(true);
      expect(result.extra).toEqual(["extra1"]);
      expect(result.message).toBe("Warning: extra argument ignored: extra1");
      expect(result.message).not.toContain("arguments"); // singular
    });

    it("should warn on multiple extra args with plural form", () => {
      const result = warnExtraArgs(["list", "extra1", "extra2"], 1);
      expect(result.warned).toBe(true);
      expect(result.extra).toEqual(["extra1", "extra2"]);
      expect(result.message).toBe("Warning: extra arguments ignored: extra1, extra2");
    });

    it("should warn on three extra args for default handler", () => {
      const result = warnExtraArgs(["claude", "sprite", "extra1", "extra2", "extra3"], 2);
      expect(result.warned).toBe(true);
      expect(result.extra).toEqual(["extra1", "extra2", "extra3"]);
      expect(result.message).toContain("extra1, extra2, extra3");
    });

    it("should warn on extra args after subcommand", () => {
      const result = warnExtraArgs(["agents", "something"], 1);
      expect(result.warned).toBe(true);
      expect(result.extra).toEqual(["something"]);
    });

    it("should include extra arg values in message", () => {
      const result = warnExtraArgs(["version", "--json", "output"], 1);
      expect(result.warned).toBe(true);
      expect(result.message).toContain("--json, output");
    });
  });
});

// ── dispatchCommand routing ──────────────────────────────────────────────────

describe("dispatchCommand routing", () => {
  describe("IMMEDIATE_COMMANDS", () => {
    it("should route 'help' as immediate", () => {
      const result = dispatchCommand("help", ["help"], undefined);
      expect(result.type).toBe("immediate");
      expect(result.type === "immediate" && result.cmd).toBe("help");
    });

    it("should route '--help' as immediate", () => {
      const result = dispatchCommand("--help", ["--help"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should route '-h' as immediate", () => {
      const result = dispatchCommand("-h", ["-h"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should route 'version' as immediate", () => {
      const result = dispatchCommand("version", ["version"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should route '--version' as immediate", () => {
      const result = dispatchCommand("--version", ["--version"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should route '-v' as immediate", () => {
      const result = dispatchCommand("-v", ["-v"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should route '-V' as immediate", () => {
      const result = dispatchCommand("-V", ["-V"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should warn on extra args after immediate command", () => {
      const result = dispatchCommand("help", ["help", "extra"], undefined);
      expect(result.type).toBe("immediate");
      if (result.type === "immediate") {
        expect(result.extraWarning.warned).toBe(true);
        expect(result.extraWarning.extra).toEqual(["extra"]);
      }
    });

    it("should not warn when no extra args on immediate command", () => {
      const result = dispatchCommand("version", ["version"], undefined);
      if (result.type === "immediate") {
        expect(result.extraWarning.warned).toBe(false);
      }
    });
  });

  describe("SUBCOMMANDS", () => {
    it("should route 'list' as subcommand", () => {
      const result = dispatchCommand("list", ["list"], undefined);
      expect(result.type).toBe("subcommand");
      if (result.type === "subcommand") {
        expect(result.cmd).toBe("list");
        expect(result.helpRedirect).toBe(false);
      }
    });

    it("should route 'ls' as subcommand (alias for list)", () => {
      const result = dispatchCommand("ls", ["ls"], undefined);
      expect(result.type).toBe("subcommand");
      if (result.type === "subcommand") {
        expect(result.cmd).toBe("ls");
      }
    });

    it("should route 'agents' as subcommand", () => {
      const result = dispatchCommand("agents", ["agents"], undefined);
      expect(result.type).toBe("subcommand");
    });

    it("should route 'clouds' as subcommand", () => {
      const result = dispatchCommand("clouds", ["clouds"], undefined);
      expect(result.type).toBe("subcommand");
    });

    it("should route 'update' as subcommand", () => {
      const result = dispatchCommand("update", ["update"], undefined);
      expect(result.type).toBe("subcommand");
    });

    it("should redirect to help when subcommand has --help flag", () => {
      const result = dispatchCommand("list", ["list", "--help"], undefined);
      expect(result.type).toBe("subcommand");
      if (result.type === "subcommand") {
        expect(result.helpRedirect).toBe(true);
      }
    });

    it("should redirect to help when subcommand has -h flag", () => {
      const result = dispatchCommand("agents", ["agents", "-h"], undefined);
      expect(result.type).toBe("subcommand");
      if (result.type === "subcommand") {
        expect(result.helpRedirect).toBe(true);
      }
    });

    it("should redirect to help when subcommand has 'help' as second arg", () => {
      const result = dispatchCommand("clouds", ["clouds", "help"], undefined);
      expect(result.type).toBe("subcommand");
      if (result.type === "subcommand") {
        expect(result.helpRedirect).toBe(true);
      }
    });

    it("should warn on extra args after subcommand", () => {
      const result = dispatchCommand("agents", ["agents", "extra1"], undefined);
      expect(result.type).toBe("subcommand");
      if (result.type === "subcommand") {
        expect(result.helpRedirect).toBe(false);
        expect(result.extraWarning.warned).toBe(true);
        expect(result.extraWarning.extra).toEqual(["extra1"]);
      }
    });

    it("should not warn when no extra args on subcommand", () => {
      const result = dispatchCommand("list", ["list"], undefined);
      if (result.type === "subcommand") {
        expect(result.extraWarning.warned).toBe(false);
      }
    });
  });

  describe("default handler (agent/cloud)", () => {
    it("should route unknown commands as default with agent and cloud", () => {
      const result = dispatchCommand("claude", ["claude", "sprite"], undefined);
      expect(result.type).toBe("default");
      if (result.type === "default") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBe("sprite");
        expect(result.prompt).toBeUndefined();
      }
    });

    it("should pass prompt through to default handler", () => {
      const result = dispatchCommand("claude", ["claude", "sprite"], "Fix bugs");
      if (result.type === "default") {
        expect(result.prompt).toBe("Fix bugs");
      }
    });

    it("should handle agent-only (no cloud) as default", () => {
      const result = dispatchCommand("claude", ["claude"], undefined);
      expect(result.type).toBe("default");
      if (result.type === "default") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBeUndefined();
      }
    });

    it("should not warn when exactly agent + cloud provided", () => {
      const result = dispatchCommand("claude", ["claude", "sprite"], undefined);
      if (result.type === "default") {
        expect(result.extraWarning.warned).toBe(false);
      }
    });

    it("should warn on extra args beyond agent + cloud", () => {
      const result = dispatchCommand("claude", ["claude", "sprite", "extra"], undefined);
      if (result.type === "default") {
        expect(result.extraWarning.warned).toBe(true);
        expect(result.extraWarning.extra).toEqual(["extra"]);
      }
    });

    it("should warn on multiple extra args beyond agent + cloud", () => {
      const result = dispatchCommand(
        "claude",
        ["claude", "sprite", "extra1", "extra2"],
        undefined
      );
      if (result.type === "default") {
        expect(result.extraWarning.warned).toBe(true);
        expect(result.extraWarning.extra).toEqual(["extra1", "extra2"]);
        expect(result.extraWarning.message).toContain("arguments"); // plural
      }
    });
  });

  describe("routing priority", () => {
    it("should prioritize immediate commands over default handling", () => {
      // "help" is in IMMEDIATE_COMMANDS; should not fall through to default
      const result = dispatchCommand("help", ["help"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("should prioritize subcommands over default handling", () => {
      // "list" is in SUBCOMMANDS; should not fall through to default
      const result = dispatchCommand("list", ["list"], undefined);
      expect(result.type).toBe("subcommand");
    });

    it("should fall through to default for unknown names", () => {
      const result = dispatchCommand("aider", ["aider", "hetzner"], undefined);
      expect(result.type).toBe("default");
    });

    it("should treat typo-like names as default (not immediate or subcommand)", () => {
      const result = dispatchCommand("listt", ["listt"], undefined);
      expect(result.type).toBe("default");
    });
  });
});

// ── showVersion output format ────────────────────────────────────────────────

describe("showVersion output format", () => {
  // Replica of the showVersion output structure
  function formatVersionOutput(version: string, binaryPath: string | undefined): string[] {
    const runtime = process.versions.bun ? "bun" : "node";
    const runtimeVersion = process.versions.bun ?? process.versions.node;
    return [
      `spawn v${version}`,
      `  ${binaryPath ?? "unknown path"}`,
      `  ${runtime} ${runtimeVersion}  ${process.platform} ${process.arch}`,
      `  Run spawn update to check for updates.`,
    ];
  }

  it("should include version string with 'v' prefix", () => {
    const lines = formatVersionOutput("0.2.15", "/usr/local/bin/spawn");
    expect(lines[0]).toBe("spawn v0.2.15");
  });

  it("should include binary path on second line", () => {
    const lines = formatVersionOutput("0.2.15", "/usr/local/bin/spawn");
    expect(lines[1]).toContain("/usr/local/bin/spawn");
  });

  it("should fall back to 'unknown path' when no argv[1]", () => {
    const lines = formatVersionOutput("0.2.15", undefined);
    expect(lines[1]).toContain("unknown path");
  });

  it("should include runtime and platform info", () => {
    const lines = formatVersionOutput("0.2.15", "/usr/local/bin/spawn");
    expect(lines[2]).toContain(process.platform);
    expect(lines[2]).toContain(process.arch);
  });

  it("should suggest spawn update", () => {
    const lines = formatVersionOutput("0.2.15", "/usr/local/bin/spawn");
    expect(lines[3]).toContain("spawn update");
  });
});

// ── HELP_FLAGS used in dispatchCommand and handleDefaultCommand ──────────────

describe("HELP_FLAGS consistency", () => {
  it("should recognize --help as a help flag", () => {
    expect(HELP_FLAGS).toContain("--help");
  });

  it("should recognize -h as a help flag", () => {
    expect(HELP_FLAGS).toContain("-h");
  });

  it("should recognize 'help' (bare word) as a help flag", () => {
    expect(HELP_FLAGS).toContain("help");
  });

  it("should not include --version as a help flag", () => {
    expect(HELP_FLAGS).not.toContain("--version");
  });
});

// ── Integration: end-to-end dispatch scenarios ──────────────────────────────

describe("dispatch end-to-end scenarios", () => {
  it("'spawn list foo' warns about extra arg 'foo'", () => {
    const result = dispatchCommand("list", ["list", "foo"], undefined);
    expect(result.type).toBe("subcommand");
    if (result.type === "subcommand") {
      expect(result.helpRedirect).toBe(false);
      expect(result.extraWarning.warned).toBe(true);
      expect(result.extraWarning.message).toContain("foo");
    }
  });

  it("'spawn version --json' warns about extra arg '--json'", () => {
    const result = dispatchCommand("version", ["version", "--json"], undefined);
    expect(result.type).toBe("immediate");
    if (result.type === "immediate") {
      expect(result.extraWarning.warned).toBe(true);
      expect(result.extraWarning.message).toContain("--json");
    }
  });

  it("'spawn claude sprite extra1 extra2' warns about extra args", () => {
    const result = dispatchCommand(
      "claude",
      ["claude", "sprite", "extra1", "extra2"],
      undefined
    );
    expect(result.type).toBe("default");
    if (result.type === "default") {
      expect(result.extraWarning.warned).toBe(true);
      expect(result.extraWarning.extra).toEqual(["extra1", "extra2"]);
    }
  });

  it("'spawn list --help' shows help instead of running list", () => {
    const result = dispatchCommand("list", ["list", "--help"], undefined);
    expect(result.type).toBe("subcommand");
    if (result.type === "subcommand") {
      expect(result.helpRedirect).toBe(true);
    }
  });

  it("'spawn update -h' shows help instead of running update", () => {
    const result = dispatchCommand("update", ["update", "-h"], undefined);
    expect(result.type).toBe("subcommand");
    if (result.type === "subcommand") {
      expect(result.helpRedirect).toBe(true);
    }
  });

  it("'spawn agents help' shows help instead of running agents", () => {
    const result = dispatchCommand("agents", ["agents", "help"], undefined);
    expect(result.type).toBe("subcommand");
    if (result.type === "subcommand") {
      expect(result.helpRedirect).toBe(true);
    }
  });

  it("'spawn aider' falls through to default handler", () => {
    const result = dispatchCommand("aider", ["aider"], undefined);
    expect(result.type).toBe("default");
    if (result.type === "default") {
      expect(result.agent).toBe("aider");
      expect(result.cloud).toBeUndefined();
    }
  });

  it("'spawn claude sprite --prompt text' passes prompt to default", () => {
    const result = dispatchCommand("claude", ["claude", "sprite"], "Fix all bugs");
    expect(result.type).toBe("default");
    if (result.type === "default") {
      expect(result.prompt).toBe("Fix all bugs");
      expect(result.extraWarning.warned).toBe(false);
    }
  });
});

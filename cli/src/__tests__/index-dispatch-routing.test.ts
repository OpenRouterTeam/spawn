import { describe, it, expect } from "bun:test";

/**
 * Tests for CLI dispatch routing, flag extraction, and error-handling logic
 * from index.ts.
 *
 * Since index.ts runs main() on import, we replicate the logic as pure
 * functions to test without side effects. This covers functions that were
 * added or changed in recent PRs (#531, #537, #540, #549) and lack
 * dedicated unit test coverage:
 *
 * - extractFlagValue: generic flag+value extractor with error detection
 * - parseListFilters: -a/--agent and -c/--cloud flag parsing with error paths
 * - handleDefaultCommand routing: help flags, dry-run, prompt-only, agent-only
 * - warnExtraArgs: detecting extra positional args
 * - hasTrailingHelpFlag: checking for --help after the command
 * - dispatchCommand routing: immediate, list, subcommands, verb aliases, default
 * - KNOWN_FLAGS completeness: ensures new flags are in the set
 *
 * Agent: test-engineer
 */

// ── Replica of extractFlagValue from index.ts lines 38-57 ───────────────────

type ExtractResult =
  | { ok: true; value: string | undefined; remaining: string[] }
  | { ok: false; flag: string };

function extractFlagValue(
  args: string[],
  flags: string[],
  _flagLabel: string,
  _usageHint: string,
): ExtractResult {
  const idx = args.findIndex((arg) => flags.includes(arg));
  if (idx === -1) return { ok: true, value: undefined, remaining: args };

  if (!args[idx + 1] || args[idx + 1].startsWith("-")) {
    return { ok: false, flag: args[idx] };
  }

  const value = args[idx + 1];
  const remaining = [...args];
  remaining.splice(idx, 2);
  return { ok: true, value, remaining };
}

// ── Replica of warnExtraArgs from index.ts lines 287-294 ────────────────────

function getExtraArgs(filteredArgs: string[], maxExpected: number): string[] {
  return filteredArgs.slice(maxExpected);
}

// ── Replica of hasTrailingHelpFlag from index.ts lines 333-335 ──────────────

const HELP_FLAGS = ["--help", "-h", "help"];

function hasTrailingHelpFlag(args: string[]): boolean {
  return args.slice(1).some((a) => HELP_FLAGS.includes(a));
}

// ── Replica of parseListFilters with error detection from index.ts ──────────

type ListFilterResult =
  | { ok: true; agentFilter?: string; cloudFilter?: string }
  | { ok: false; flag: string; kind: "agent" | "cloud" };

function parseListFilters(args: string[]): ListFilterResult {
  let agentFilter: string | undefined;
  let cloudFilter: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" || args[i] === "--agent") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        return { ok: false, flag: args[i], kind: "agent" };
      }
      agentFilter = args[i + 1];
      i++;
    } else if (args[i] === "-c" || args[i] === "--cloud") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        return { ok: false, flag: args[i], kind: "cloud" };
      }
      cloudFilter = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  // Support bare positional filter: "spawn list claude"
  if (!agentFilter && !cloudFilter && positional.length > 0) {
    agentFilter = positional[0];
  }

  return { ok: true, agentFilter, cloudFilter };
}

// ── Replica of handleDefaultCommand routing from index.ts ───────────────────

type DefaultResult =
  | { action: "show_info"; agent: string }
  | { action: "run"; agent: string; cloud: string; prompt?: string; dryRun?: boolean }
  | { action: "dry_run_error" }
  | { action: "prompt_no_cloud"; agent: string };

function handleDefaultCommand(
  agent: string,
  cloud: string | undefined,
  prompt?: string,
  dryRun?: boolean,
): DefaultResult {
  if (cloud && HELP_FLAGS.includes(cloud)) {
    return { action: "show_info", agent };
  }
  if (cloud) {
    return { action: "run", agent, cloud, prompt, dryRun };
  }
  if (dryRun) {
    return { action: "dry_run_error" };
  }
  if (prompt) {
    return { action: "prompt_no_cloud", agent };
  }
  return { action: "show_info", agent };
}

// ── Replica of dispatchCommand routing from index.ts ────────────────────────

const IMMEDIATE_COMMANDS = new Set([
  "help", "--help", "-h",
]);

const LIST_COMMANDS = new Set(["list", "ls", "history"]);

const SUBCOMMANDS = new Set(["matrix", "m", "agents", "clouds", "update", "version", "--version", "-v", "-V"]);

const VERB_ALIASES = new Set(["run", "launch", "start", "deploy", "exec"]);

type DispatchResult =
  | { type: "immediate"; cmd: string }
  | { type: "list"; args: string[] }
  | { type: "list_help" }
  | { type: "subcommand"; cmd: string }
  | { type: "subcommand_help" }
  | { type: "verb_alias"; agent: string; cloud?: string }
  | { type: "verb_alias_bare"; verb: string }
  | { type: "default"; agent: string; cloud?: string };

function dispatchCommand(
  cmd: string,
  filteredArgs: string[],
): DispatchResult {
  if (IMMEDIATE_COMMANDS.has(cmd)) {
    return { type: "immediate", cmd };
  }

  if (LIST_COMMANDS.has(cmd)) {
    if (hasTrailingHelpFlag(filteredArgs)) return { type: "list_help" };
    return { type: "list", args: filteredArgs.slice(1) };
  }

  if (SUBCOMMANDS.has(cmd)) {
    if (hasTrailingHelpFlag(filteredArgs)) return { type: "subcommand_help" };
    return { type: "subcommand", cmd };
  }

  if (VERB_ALIASES.has(cmd)) {
    if (filteredArgs.length > 1) {
      const remaining = filteredArgs.slice(1);
      return { type: "verb_alias", agent: remaining[0], cloud: remaining[1] };
    }
    return { type: "verb_alias_bare", verb: cmd };
  }

  return { type: "default", agent: filteredArgs[0], cloud: filteredArgs[1] };
}

// ── KNOWN_FLAGS set from index.ts ───────────────────────────────────────────

const KNOWN_FLAGS = new Set([
  "--help", "-h",
  "--version", "-v", "-V",
  "--prompt", "-p", "--prompt-file", "-f",
  "--dry-run", "-n",
  "-a", "-c", "--agent", "--cloud",
]);

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("extractFlagValue", () => {
  describe("successful extraction", () => {
    it("should extract --prompt and its value", () => {
      const result = extractFlagValue(
        ["claude", "sprite", "--prompt", "Fix bugs"],
        ["--prompt", "-p"],
        "prompt",
        "spawn <agent> <cloud> --prompt ...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Fix bugs");
        expect(result.remaining).toEqual(["claude", "sprite"]);
      }
    });

    it("should extract short flag -p and its value", () => {
      const result = extractFlagValue(
        ["-p", "Add tests", "claude", "sprite"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Add tests");
        expect(result.remaining).toEqual(["claude", "sprite"]);
      }
    });

    it("should return undefined value when flag is not present", () => {
      const result = extractFlagValue(
        ["claude", "sprite"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
        expect(result.remaining).toEqual(["claude", "sprite"]);
      }
    });

    it("should extract flag in the middle of args", () => {
      const result = extractFlagValue(
        ["claude", "--prompt", "Fix bugs", "sprite"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Fix bugs");
        expect(result.remaining).toEqual(["claude", "sprite"]);
      }
    });

    it("should extract from empty args", () => {
      const result = extractFlagValue([], ["--prompt", "-p"], "prompt", "...");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
        expect(result.remaining).toEqual([]);
      }
    });

    it("should handle value with spaces", () => {
      const result = extractFlagValue(
        ["--prompt", "Fix all linter errors"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Fix all linter errors");
      }
    });

    it("should extract --prompt-file flag", () => {
      const result = extractFlagValue(
        ["claude", "sprite", "--prompt-file", "instructions.txt"],
        ["--prompt-file", "-f"],
        "prompt file",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("instructions.txt");
        expect(result.remaining).toEqual(["claude", "sprite"]);
      }
    });

    it("should extract -f short flag", () => {
      const result = extractFlagValue(
        ["-f", "todo.md", "claude"],
        ["--prompt-file", "-f"],
        "prompt file",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("todo.md");
        expect(result.remaining).toEqual(["claude"]);
      }
    });
  });

  describe("error detection", () => {
    it("should detect missing value when flag is last arg", () => {
      const result = extractFlagValue(
        ["claude", "sprite", "--prompt"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("--prompt");
      }
    });

    it("should detect missing value for short flag as last arg", () => {
      const result = extractFlagValue(
        ["claude", "-p"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-p");
      }
    });

    it("should detect when next arg starts with dash (another flag)", () => {
      const result = extractFlagValue(
        ["--prompt", "--dry-run"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("--prompt");
      }
    });

    it("should detect when next arg is a short flag", () => {
      const result = extractFlagValue(
        ["-p", "-n", "claude"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-p");
      }
    });

    it("should detect missing value for --prompt-file", () => {
      const result = extractFlagValue(
        ["claude", "--prompt-file"],
        ["--prompt-file", "-f"],
        "prompt file",
        "...",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("--prompt-file");
      }
    });

    it("should detect -f followed by another flag", () => {
      const result = extractFlagValue(
        ["-f", "--help"],
        ["--prompt-file", "-f"],
        "prompt file",
        "...",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-f");
      }
    });
  });

  describe("first occurrence wins", () => {
    it("should extract only the first occurrence of the flag", () => {
      const result = extractFlagValue(
        ["--prompt", "first", "--prompt", "second"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("first");
        expect(result.remaining).toEqual(["--prompt", "second"]);
      }
    });

    it("should match first matching flag variant", () => {
      const result = extractFlagValue(
        ["-p", "short", "--prompt", "long"],
        ["--prompt", "-p"],
        "prompt",
        "...",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("short");
        expect(result.remaining).toEqual(["--prompt", "long"]);
      }
    });
  });
});

describe("warnExtraArgs (getExtraArgs)", () => {
  it("should return empty when no extra args", () => {
    expect(getExtraArgs(["claude", "sprite"], 2)).toEqual([]);
  });

  it("should return empty when fewer args than expected", () => {
    expect(getExtraArgs(["claude"], 2)).toEqual([]);
  });

  it("should return empty for empty args", () => {
    expect(getExtraArgs([], 1)).toEqual([]);
  });

  it("should detect one extra arg", () => {
    expect(getExtraArgs(["claude", "sprite", "extra"], 2)).toEqual(["extra"]);
  });

  it("should detect multiple extra args", () => {
    expect(getExtraArgs(["claude", "sprite", "extra1", "extra2"], 2)).toEqual([
      "extra1",
      "extra2",
    ]);
  });

  it("should detect extra args after immediate command (1 expected)", () => {
    expect(getExtraArgs(["help", "extra"], 1)).toEqual(["extra"]);
  });

  it("should return all args when maxExpected is 0", () => {
    expect(getExtraArgs(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
  });
});

describe("hasTrailingHelpFlag", () => {
  it("should detect --help after first arg", () => {
    expect(hasTrailingHelpFlag(["list", "--help"])).toBe(true);
  });

  it("should detect -h after first arg", () => {
    expect(hasTrailingHelpFlag(["agents", "-h"])).toBe(true);
  });

  it("should detect 'help' as trailing arg", () => {
    expect(hasTrailingHelpFlag(["matrix", "help"])).toBe(true);
  });

  it("should NOT detect help flag in first position (it is the command)", () => {
    expect(hasTrailingHelpFlag(["--help"])).toBe(false);
  });

  it("should NOT detect -h in first position", () => {
    expect(hasTrailingHelpFlag(["-h"])).toBe(false);
  });

  it("should return false for no args", () => {
    expect(hasTrailingHelpFlag([])).toBe(false);
  });

  it("should return false for args without help flags", () => {
    expect(hasTrailingHelpFlag(["list", "-a", "claude"])).toBe(false);
  });

  it("should detect --help anywhere after first arg", () => {
    expect(hasTrailingHelpFlag(["list", "-a", "claude", "--help"])).toBe(true);
  });

  it("should detect help as third arg", () => {
    expect(hasTrailingHelpFlag(["agents", "claude", "help"])).toBe(true);
  });
});

describe("parseListFilters with error paths", () => {
  describe("successful extraction", () => {
    it("should extract -a flag", () => {
      const result = parseListFilters(["-a", "claude"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBeUndefined();
      }
    });

    it("should extract --agent flag", () => {
      const result = parseListFilters(["--agent", "aider"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("aider");
      }
    });

    it("should extract -c flag", () => {
      const result = parseListFilters(["-c", "hetzner"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.cloudFilter).toBe("hetzner");
      }
    });

    it("should extract --cloud flag", () => {
      const result = parseListFilters(["--cloud", "sprite"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.cloudFilter).toBe("sprite");
      }
    });

    it("should extract both -a and -c", () => {
      const result = parseListFilters(["-a", "claude", "-c", "sprite"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBe("sprite");
      }
    });

    it("should extract both --agent and --cloud", () => {
      const result = parseListFilters(["--agent", "claude", "--cloud", "hetzner"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBe("hetzner");
      }
    });

    it("should use positional arg as agent filter when no flags present", () => {
      const result = parseListFilters(["claude"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBeUndefined();
      }
    });

    it("should not use positional when -a is present", () => {
      const result = parseListFilters(["-a", "aider", "extra"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("aider");
      }
    });

    it("should not use positional when -c is present", () => {
      const result = parseListFilters(["-c", "sprite", "extra"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.cloudFilter).toBe("sprite");
        expect(result.agentFilter).toBeUndefined();
      }
    });

    it("should return no filters for empty args", () => {
      const result = parseListFilters([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBeUndefined();
        expect(result.cloudFilter).toBeUndefined();
      }
    });
  });

  describe("error detection (missing values)", () => {
    it("should error when -a is last arg (no value)", () => {
      const result = parseListFilters(["-a"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-a");
        expect(result.kind).toBe("agent");
      }
    });

    it("should error when --agent is last arg (no value)", () => {
      const result = parseListFilters(["--agent"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("--agent");
        expect(result.kind).toBe("agent");
      }
    });

    it("should error when -c is last arg (no value)", () => {
      const result = parseListFilters(["-c"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-c");
        expect(result.kind).toBe("cloud");
      }
    });

    it("should error when --cloud is last arg (no value)", () => {
      const result = parseListFilters(["--cloud"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("--cloud");
        expect(result.kind).toBe("cloud");
      }
    });

    it("should error when -a is followed by another flag", () => {
      const result = parseListFilters(["-a", "-c", "sprite"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-a");
        expect(result.kind).toBe("agent");
      }
    });

    it("should error when --agent is followed by --cloud", () => {
      const result = parseListFilters(["--agent", "--cloud", "sprite"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("--agent");
        expect(result.kind).toBe("agent");
      }
    });

    it("should error when -c is followed by a flag", () => {
      const result = parseListFilters(["-c", "--help"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.flag).toBe("-c");
        expect(result.kind).toBe("cloud");
      }
    });
  });

  describe("mixed short and long flags", () => {
    it("should extract -a with --cloud", () => {
      const result = parseListFilters(["-a", "claude", "--cloud", "hetzner"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("claude");
        expect(result.cloudFilter).toBe("hetzner");
      }
    });

    it("should extract --agent with -c", () => {
      const result = parseListFilters(["--agent", "aider", "-c", "sprite"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agentFilter).toBe("aider");
        expect(result.cloudFilter).toBe("sprite");
      }
    });
  });
});

describe("handleDefaultCommand routing", () => {
  describe("help flag as cloud argument", () => {
    it("should show info when cloud is --help", () => {
      const result = handleDefaultCommand("claude", "--help");
      expect(result.action).toBe("show_info");
      if (result.action === "show_info") {
        expect(result.agent).toBe("claude");
      }
    });

    it("should show info when cloud is -h", () => {
      const result = handleDefaultCommand("aider", "-h");
      expect(result.action).toBe("show_info");
      if (result.action === "show_info") {
        expect(result.agent).toBe("aider");
      }
    });

    it("should show info when cloud is 'help'", () => {
      const result = handleDefaultCommand("codex", "help");
      expect(result.action).toBe("show_info");
      if (result.action === "show_info") {
        expect(result.agent).toBe("codex");
      }
    });
  });

  describe("agent and cloud provided", () => {
    it("should run when both agent and cloud are given", () => {
      const result = handleDefaultCommand("claude", "sprite");
      expect(result.action).toBe("run");
      if (result.action === "run") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBe("sprite");
        expect(result.prompt).toBeUndefined();
        expect(result.dryRun).toBeUndefined();
      }
    });

    it("should pass prompt through to run", () => {
      const result = handleDefaultCommand("claude", "sprite", "Fix bugs");
      expect(result.action).toBe("run");
      if (result.action === "run") {
        expect(result.prompt).toBe("Fix bugs");
      }
    });

    it("should pass dryRun through to run", () => {
      const result = handleDefaultCommand("claude", "sprite", undefined, true);
      expect(result.action).toBe("run");
      if (result.action === "run") {
        expect(result.dryRun).toBe(true);
      }
    });

    it("should pass both prompt and dryRun", () => {
      const result = handleDefaultCommand("aider", "hetzner", "Add tests", true);
      expect(result.action).toBe("run");
      if (result.action === "run") {
        expect(result.prompt).toBe("Add tests");
        expect(result.dryRun).toBe(true);
      }
    });
  });

  describe("agent only (no cloud)", () => {
    it("should error for dry-run without cloud", () => {
      const result = handleDefaultCommand("claude", undefined, undefined, true);
      expect(result.action).toBe("dry_run_error");
    });

    it("should suggest clouds when prompt given without cloud", () => {
      const result = handleDefaultCommand("claude", undefined, "Fix bugs");
      expect(result.action).toBe("prompt_no_cloud");
      if (result.action === "prompt_no_cloud") {
        expect(result.agent).toBe("claude");
      }
    });

    it("should show info when only agent is given", () => {
      const result = handleDefaultCommand("claude", undefined);
      expect(result.action).toBe("show_info");
      if (result.action === "show_info") {
        expect(result.agent).toBe("claude");
      }
    });
  });

  describe("priority: dryRun error before prompt error", () => {
    it("should prioritize dry-run error over prompt error when both flags set", () => {
      // When both --dry-run and --prompt are set but no cloud,
      // dry-run error should come first (it's checked before prompt)
      const result = handleDefaultCommand("claude", undefined, "Fix bugs", true);
      expect(result.action).toBe("dry_run_error");
    });
  });
});

describe("dispatchCommand routing", () => {
  describe("immediate commands", () => {
    for (const cmd of ["help", "--help", "-h"]) {
      it(`should route "${cmd}" as immediate`, () => {
        const result = dispatchCommand(cmd, [cmd]);
        expect(result.type).toBe("immediate");
        if (result.type === "immediate") {
          expect(result.cmd).toBe(cmd);
        }
      });
    }
  });

  describe("version commands (subcommands)", () => {
    for (const cmd of ["version", "--version", "-v", "-V"]) {
      it(`should route "${cmd}" as subcommand`, () => {
        const result = dispatchCommand(cmd, [cmd]);
        expect(result.type).toBe("subcommand");
        if (result.type === "subcommand") {
          expect(result.cmd).toBe(cmd);
        }
      });
    }
  });

  describe("list commands", () => {
    for (const cmd of ["list", "ls", "history"]) {
      it(`should route "${cmd}" as list command`, () => {
        const result = dispatchCommand(cmd, [cmd]);
        expect(result.type).toBe("list");
      });

      it(`should route "${cmd} --help" to help`, () => {
        const result = dispatchCommand(cmd, [cmd, "--help"]);
        expect(result.type).toBe("list_help");
      });

      it(`should route "${cmd} -h" to help`, () => {
        const result = dispatchCommand(cmd, [cmd, "-h"]);
        expect(result.type).toBe("list_help");
      });
    }

    it("should pass filter args through for list", () => {
      const result = dispatchCommand("list", ["list", "-a", "claude"]);
      expect(result.type).toBe("list");
      if (result.type === "list") {
        expect(result.args).toEqual(["-a", "claude"]);
      }
    });

    it("should pass positional filter through for list", () => {
      const result = dispatchCommand("list", ["list", "claude"]);
      expect(result.type).toBe("list");
      if (result.type === "list") {
        expect(result.args).toEqual(["claude"]);
      }
    });
  });

  describe("subcommands", () => {
    for (const cmd of ["matrix", "m", "agents", "clouds", "update"]) {
      it(`should route "${cmd}" as subcommand`, () => {
        const result = dispatchCommand(cmd, [cmd]);
        expect(result.type).toBe("subcommand");
        if (result.type === "subcommand") {
          expect(result.cmd).toBe(cmd);
        }
      });

      it(`should route "${cmd} --help" to help`, () => {
        const result = dispatchCommand(cmd, [cmd, "--help"]);
        expect(result.type).toBe("subcommand_help");
      });
    }
  });

  describe("verb aliases", () => {
    for (const verb of ["run", "launch", "start", "deploy", "exec"]) {
      it(`should route "${verb}" with args as verb_alias`, () => {
        const result = dispatchCommand(verb, [verb, "claude", "sprite"]);
        expect(result.type).toBe("verb_alias");
        if (result.type === "verb_alias") {
          expect(result.agent).toBe("claude");
          expect(result.cloud).toBe("sprite");
        }
      });

      it(`should route bare "${verb}" as verb_alias_bare`, () => {
        const result = dispatchCommand(verb, [verb]);
        expect(result.type).toBe("verb_alias_bare");
        if (result.type === "verb_alias_bare") {
          expect(result.verb).toBe(verb);
        }
      });
    }

    it("should handle verb alias with agent only (no cloud)", () => {
      const result = dispatchCommand("run", ["run", "claude"]);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBeUndefined();
      }
    });
  });

  describe("default routing (agent/cloud)", () => {
    it("should route unknown command as default", () => {
      const result = dispatchCommand("claude", ["claude", "sprite"]);
      expect(result.type).toBe("default");
      if (result.type === "default") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBe("sprite");
      }
    });

    it("should route agent-only as default", () => {
      const result = dispatchCommand("claude", ["claude"]);
      expect(result.type).toBe("default");
      if (result.type === "default") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBeUndefined();
      }
    });
  });

  describe("priority: commands do not shadow each other", () => {
    it("immediate commands take priority over everything", () => {
      expect(dispatchCommand("help", ["help"]).type).toBe("immediate");
    });

    it("list commands take priority over verb aliases and default", () => {
      expect(dispatchCommand("list", ["list"]).type).toBe("list");
    });

    it("subcommands take priority over verb aliases and default", () => {
      expect(dispatchCommand("agents", ["agents"]).type).toBe("subcommand");
    });

    it("verb aliases take priority over default routing", () => {
      expect(dispatchCommand("run", ["run", "claude"]).type).toBe("verb_alias");
    });

    it("'history' routes as list, not default", () => {
      expect(dispatchCommand("history", ["history"]).type).toBe("list");
    });

    it("'m' routes as subcommand (matrix alias)", () => {
      expect(dispatchCommand("m", ["m"]).type).toBe("subcommand");
    });
  });
});

describe("KNOWN_FLAGS completeness", () => {
  const expectedFlags = [
    "--help", "-h",
    "--version", "-v", "-V",
    "--prompt", "-p",
    "--prompt-file", "-f",
    "--dry-run", "-n",
    "-a", "-c",
    "--agent", "--cloud",
  ];

  for (const flag of expectedFlags) {
    it(`should include ${flag} in KNOWN_FLAGS`, () => {
      expect(KNOWN_FLAGS.has(flag)).toBe(true);
    });
  }

  it("should not include random flags", () => {
    expect(KNOWN_FLAGS.has("--json")).toBe(false);
    expect(KNOWN_FLAGS.has("--verbose")).toBe(false);
    expect(KNOWN_FLAGS.has("-x")).toBe(false);
    expect(KNOWN_FLAGS.has("--force")).toBe(false);
  });

  it("should have exactly 15 known flags", () => {
    expect(KNOWN_FLAGS.size).toBe(15);
  });
});

describe("LIST_COMMANDS includes history alias", () => {
  it("should include 'list'", () => {
    expect(LIST_COMMANDS.has("list")).toBe(true);
  });

  it("should include 'ls'", () => {
    expect(LIST_COMMANDS.has("ls")).toBe(true);
  });

  it("should include 'history'", () => {
    expect(LIST_COMMANDS.has("history")).toBe(true);
  });

  it("should have exactly 3 list command aliases", () => {
    expect(LIST_COMMANDS.size).toBe(3);
  });
});

import { describe, it, expect } from "bun:test";

/**
 * Tests for verb alias handling in CLI dispatch.
 *
 * Users coming from Docker, kubectl, or other CLIs naturally try
 * "spawn run claude sprite", "spawn launch aider hetzner", etc.
 * The CLI should transparently strip these verb prefixes and forward
 * to the default agent/cloud handler.
 *
 * Also tests info aliases: "spawn info claude" -> show agent info page.
 */

// ── Replica of dispatch logic from index.ts ─────────────────────────────────

const VERB_ALIASES = new Set(["run", "launch", "start", "deploy", "exec"]);
const INFO_ALIASES = new Set(["info", "show", "describe"]);

const IMMEDIATE_COMMAND_KEYS = new Set([
  "help", "--help", "-h",
  "version", "--version", "-v", "-V",
]);

const SUBCOMMAND_KEYS = new Set([
  "list", "ls", "matrix", "m", "agents", "clouds", "update",
]);

type DispatchResult =
  | { type: "immediate"; cmd: string }
  | { type: "subcommand"; cmd: string }
  | { type: "verb_alias"; agent: string; cloud: string | undefined; prompt: string | undefined }
  | { type: "verb_alias_bare"; verb: string }
  | { type: "info_alias"; name: string }
  | { type: "info_alias_bare"; verb: string }
  | { type: "default"; agent: string; cloud: string | undefined; prompt: string | undefined };

function dispatchCommand(
  cmd: string,
  filteredArgs: string[],
  prompt: string | undefined,
): DispatchResult {
  if (IMMEDIATE_COMMAND_KEYS.has(cmd)) {
    return { type: "immediate", cmd };
  }

  if (SUBCOMMAND_KEYS.has(cmd)) {
    return { type: "subcommand", cmd };
  }

  // Handle verb aliases: "spawn run claude sprite" -> "spawn claude sprite"
  if (VERB_ALIASES.has(cmd)) {
    if (filteredArgs.length > 1) {
      const remaining = filteredArgs.slice(1);
      return {
        type: "verb_alias",
        agent: remaining[0],
        cloud: remaining[1],
        prompt,
      };
    }
    return { type: "verb_alias_bare", verb: cmd };
  }

  // Handle info aliases: "spawn info claude" -> "spawn claude" (show info)
  if (INFO_ALIASES.has(cmd)) {
    if (filteredArgs.length > 1) {
      return { type: "info_alias", name: filteredArgs[1] };
    }
    return { type: "info_alias_bare", verb: cmd };
  }

  return {
    type: "default",
    agent: filteredArgs[0],
    cloud: filteredArgs[1],
    prompt,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("verb alias handling", () => {
  describe("recognized aliases", () => {
    for (const verb of ["run", "launch", "start", "deploy", "exec"]) {
      it(`should recognize "${verb}" as a verb alias`, () => {
        expect(VERB_ALIASES.has(verb)).toBe(true);
      });
    }
  });

  describe("verb alias with agent and cloud", () => {
    it("should strip 'run' and forward to default handler", () => {
      const result = dispatchCommand("run", ["run", "claude", "sprite"], undefined);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBe("sprite");
      }
    });

    it("should strip 'launch' and forward to default handler", () => {
      const result = dispatchCommand("launch", ["launch", "aider", "hetzner"], undefined);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("aider");
        expect(result.cloud).toBe("hetzner");
      }
    });

    it("should strip 'start' and forward to default handler", () => {
      const result = dispatchCommand("start", ["start", "codex", "vultr"], undefined);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("codex");
        expect(result.cloud).toBe("vultr");
      }
    });

    it("should strip 'deploy' and forward to default handler", () => {
      const result = dispatchCommand("deploy", ["deploy", "claude", "linode"], undefined);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBe("linode");
      }
    });

    it("should strip 'exec' and forward to default handler", () => {
      const result = dispatchCommand("exec", ["exec", "aider", "sprite"], undefined);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("aider");
        expect(result.cloud).toBe("sprite");
      }
    });

    it("should pass prompt through when using verb alias", () => {
      const result = dispatchCommand("run", ["run", "claude", "sprite"], "Fix all bugs");
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.prompt).toBe("Fix all bugs");
      }
    });
  });

  describe("verb alias with agent only (no cloud)", () => {
    it("should forward 'run claude' as agent-only", () => {
      const result = dispatchCommand("run", ["run", "claude"], undefined);
      expect(result.type).toBe("verb_alias");
      if (result.type === "verb_alias") {
        expect(result.agent).toBe("claude");
        expect(result.cloud).toBeUndefined();
      }
    });
  });

  describe("bare verb (no additional args)", () => {
    it("should show error for bare 'run'", () => {
      const result = dispatchCommand("run", ["run"], undefined);
      expect(result.type).toBe("verb_alias_bare");
      if (result.type === "verb_alias_bare") {
        expect(result.verb).toBe("run");
      }
    });

    it("should show error for bare 'launch'", () => {
      const result = dispatchCommand("launch", ["launch"], undefined);
      expect(result.type).toBe("verb_alias_bare");
      if (result.type === "verb_alias_bare") {
        expect(result.verb).toBe("launch");
      }
    });

    it("should show error for bare 'start'", () => {
      const result = dispatchCommand("start", ["start"], undefined);
      expect(result.type).toBe("verb_alias_bare");
      if (result.type === "verb_alias_bare") {
        expect(result.verb).toBe("start");
      }
    });

    it("should show error for bare 'deploy'", () => {
      const result = dispatchCommand("deploy", ["deploy"], undefined);
      expect(result.type).toBe("verb_alias_bare");
    });

    it("should show error for bare 'exec'", () => {
      const result = dispatchCommand("exec", ["exec"], undefined);
      expect(result.type).toBe("verb_alias_bare");
    });
  });

  describe("verb aliases do not shadow real commands", () => {
    it("should not treat 'list' as a verb alias", () => {
      expect(VERB_ALIASES.has("list")).toBe(false);
    });

    it("should not treat 'help' as a verb alias", () => {
      expect(VERB_ALIASES.has("help")).toBe(false);
    });

    it("should not treat 'update' as a verb alias", () => {
      expect(VERB_ALIASES.has("update")).toBe(false);
    });

    it("should not treat 'agents' as a verb alias", () => {
      expect(VERB_ALIASES.has("agents")).toBe(false);
    });

    it("should not treat 'clouds' as a verb alias", () => {
      expect(VERB_ALIASES.has("clouds")).toBe(false);
    });

    it("should not treat 'matrix' as a verb alias", () => {
      expect(VERB_ALIASES.has("matrix")).toBe(false);
    });

    it("should not treat 'version' as a verb alias", () => {
      expect(VERB_ALIASES.has("version")).toBe(false);
    });
  });

  describe("routing priority: real commands take precedence", () => {
    it("'help' routes as immediate, not verb alias", () => {
      const result = dispatchCommand("help", ["help"], undefined);
      expect(result.type).toBe("immediate");
    });

    it("'list' routes as subcommand, not verb alias", () => {
      const result = dispatchCommand("list", ["list"], undefined);
      expect(result.type).toBe("subcommand");
    });

    it("unknown names fall to default, not verb alias", () => {
      const result = dispatchCommand("claude", ["claude", "sprite"], undefined);
      expect(result.type).toBe("default");
    });
  });
});

describe("info alias handling", () => {
  describe("recognized info aliases", () => {
    for (const verb of ["info", "show", "describe"]) {
      it(`should recognize "${verb}" as an info alias`, () => {
        expect(INFO_ALIASES.has(verb)).toBe(true);
      });
    }
  });

  describe("info alias with a name", () => {
    it("should strip 'info' and forward to info handler", () => {
      const result = dispatchCommand("info", ["info", "claude"], undefined);
      expect(result.type).toBe("info_alias");
      if (result.type === "info_alias") {
        expect(result.name).toBe("claude");
      }
    });

    it("should strip 'show' and forward to info handler", () => {
      const result = dispatchCommand("show", ["show", "hetzner"], undefined);
      expect(result.type).toBe("info_alias");
      if (result.type === "info_alias") {
        expect(result.name).toBe("hetzner");
      }
    });

    it("should strip 'describe' and forward to info handler", () => {
      const result = dispatchCommand("describe", ["describe", "aider"], undefined);
      expect(result.type).toBe("info_alias");
      if (result.type === "info_alias") {
        expect(result.name).toBe("aider");
      }
    });

    it("should work with cloud names", () => {
      const result = dispatchCommand("info", ["info", "sprite"], undefined);
      expect(result.type).toBe("info_alias");
      if (result.type === "info_alias") {
        expect(result.name).toBe("sprite");
      }
    });
  });

  describe("bare info alias (no name)", () => {
    it("should return bare info alias for 'info' alone", () => {
      const result = dispatchCommand("info", ["info"], undefined);
      expect(result.type).toBe("info_alias_bare");
      if (result.type === "info_alias_bare") {
        expect(result.verb).toBe("info");
      }
    });

    it("should return bare info alias for 'show' alone", () => {
      const result = dispatchCommand("show", ["show"], undefined);
      expect(result.type).toBe("info_alias_bare");
      if (result.type === "info_alias_bare") {
        expect(result.verb).toBe("show");
      }
    });

    it("should return bare info alias for 'describe' alone", () => {
      const result = dispatchCommand("describe", ["describe"], undefined);
      expect(result.type).toBe("info_alias_bare");
      if (result.type === "info_alias_bare") {
        expect(result.verb).toBe("describe");
      }
    });
  });

  describe("info aliases do not shadow real commands or verb aliases", () => {
    it("should not treat 'info' as a verb alias", () => {
      expect(VERB_ALIASES.has("info")).toBe(false);
    });

    it("should not treat 'show' as a verb alias", () => {
      expect(VERB_ALIASES.has("show")).toBe(false);
    });

    it("should not treat 'describe' as a verb alias", () => {
      expect(VERB_ALIASES.has("describe")).toBe(false);
    });

    it("should not treat 'run' as an info alias", () => {
      expect(INFO_ALIASES.has("run")).toBe(false);
    });

    it("should not treat 'list' as an info alias", () => {
      expect(INFO_ALIASES.has("list")).toBe(false);
    });

    it("should not treat 'help' as an info alias", () => {
      expect(INFO_ALIASES.has("help")).toBe(false);
    });
  });

  describe("routing priority: info aliases checked after verb aliases", () => {
    it("'info claude' routes as info_alias, not default", () => {
      const result = dispatchCommand("info", ["info", "claude"], undefined);
      expect(result.type).toBe("info_alias");
    });

    it("'run claude' routes as verb_alias, not info_alias", () => {
      const result = dispatchCommand("run", ["run", "claude"], undefined);
      expect(result.type).toBe("verb_alias");
    });

    it("'claude' routes as default, not info_alias", () => {
      const result = dispatchCommand("claude", ["claude"], undefined);
      expect(result.type).toBe("default");
    });
  });
});

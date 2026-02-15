import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createConsoleMocks, restoreMocks } from "./test-helpers";

/**
 * Tests for cmdHelp output completeness in commands.ts.
 *
 * Existing tests only verify cmdHelp produces some output containing "USAGE"
 * and "EXAMPLES" (commands.test.ts). This file verifies that all documented
 * subcommands, flags, sections, and key content are present in the help text.
 *
 * This is important because:
 * - Users rely on `spawn help` as the primary reference
 * - Missing subcommands or flags lead to support requests
 * - The help text must stay in sync with actual CLI capabilities
 *
 * Agent: test-engineer
 */

// Mock @clack/prompts to prevent side effects
mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

const { cmdHelp } = await import("../commands.js");

describe("cmdHelp - content completeness", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
  });

  afterEach(() => {
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  function getHelpOutput(): string {
    cmdHelp();
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  // ── Required sections ──────────────────────────────────────────────

  describe("required sections", () => {
    it("should have a USAGE section", () => {
      expect(getHelpOutput()).toContain("USAGE");
    });

    it("should have an EXAMPLES section", () => {
      expect(getHelpOutput()).toContain("EXAMPLES");
    });

    it("should have an AUTHENTICATION section", () => {
      expect(getHelpOutput()).toContain("AUTHENTICATION");
    });

    it("should have an INSTALL section", () => {
      expect(getHelpOutput()).toContain("INSTALL");
    });

    it("should have a TROUBLESHOOTING section", () => {
      expect(getHelpOutput()).toContain("TROUBLESHOOTING");
    });

    it("should have a MORE INFO section", () => {
      expect(getHelpOutput()).toContain("MORE INFO");
    });
  });

  // ── Documented subcommands ─────────────────────────────────────────

  describe("subcommands in USAGE", () => {
    it("should document spawn list subcommand", () => {
      expect(getHelpOutput()).toContain("spawn list");
    });

    it("should document spawn agents subcommand", () => {
      expect(getHelpOutput()).toContain("spawn agents");
    });

    it("should document spawn clouds subcommand", () => {
      expect(getHelpOutput()).toContain("spawn clouds");
    });

    it("should document spawn update subcommand", () => {
      expect(getHelpOutput()).toContain("spawn update");
    });

    it("should document spawn version subcommand", () => {
      expect(getHelpOutput()).toContain("spawn version");
    });

    it("should document spawn help subcommand", () => {
      expect(getHelpOutput()).toContain("spawn help");
    });

    it("should document the ls alias for list", () => {
      const output = getHelpOutput();
      expect(output).toContain("ls");
    });
  });

  // ── Documented flags ───────────────────────────────────────────────

  describe("flags in USAGE", () => {
    it("should document --prompt flag", () => {
      expect(getHelpOutput()).toContain("--prompt");
    });

    it("should document -p short form for --prompt", () => {
      expect(getHelpOutput()).toContain("-p");
    });

    it("should document --prompt-file flag", () => {
      expect(getHelpOutput()).toContain("--prompt-file");
    });
  });

  // ── Examples ───────────────────────────────────────────────────────

  describe("examples", () => {
    it("should show interactive usage example", () => {
      const output = getHelpOutput();
      // "spawn" alone for interactive
      expect(output).toMatch(/spawn\s+#.*[Ii]nteractive/);
    });

    it("should show direct launch example with agent and cloud", () => {
      const output = getHelpOutput();
      expect(output).toContain("spawn openclaw sprite");
    });

    it("should show --prompt example", () => {
      const output = getHelpOutput();
      expect(output).toContain("--prompt");
    });

    it("should show --prompt-file example", () => {
      const output = getHelpOutput();
      expect(output).toContain("--prompt-file");
    });

    it("should show agent info example", () => {
      const output = getHelpOutput();
      // e.g., "spawn claude  # Show which clouds support Claude"
      expect(output).toMatch(/spawn claude\s+#/);
    });
  });

  // ── Authentication info ────────────────────────────────────────────

  describe("authentication information", () => {
    it("should mention OpenRouter", () => {
      expect(getHelpOutput()).toContain("OpenRouter");
    });

    it("should include OpenRouter API key URL", () => {
      expect(getHelpOutput()).toContain("openrouter.ai/settings/keys");
    });

    it("should mention OPENROUTER_API_KEY env var", () => {
      expect(getHelpOutput()).toContain("OPENROUTER_API_KEY");
    });
  });

  // ── Install section ────────────────────────────────────────────────

  describe("install instructions", () => {
    it("should include curl install command", () => {
      expect(getHelpOutput()).toContain("curl -fsSL");
    });

    it("should include install.sh path", () => {
      expect(getHelpOutput()).toContain("install.sh");
    });
  });

  // ── Troubleshooting ────────────────────────────────────────────────

  describe("troubleshooting tips", () => {
    it("should mention spawn list for script not found", () => {
      const output = getHelpOutput();
      expect(output).toContain("spawn list");
    });

    it("should mention SPAWN_NO_UNICODE for garbled output", () => {
      expect(getHelpOutput()).toContain("SPAWN_NO_UNICODE");
    });

    it("should mention SPAWN_NO_UPDATE_CHECK for slow startup", () => {
      expect(getHelpOutput()).toContain("SPAWN_NO_UPDATE_CHECK");
    });
  });

  // ── Environment variables section ──────────────────────────────────

  describe("environment variables section", () => {
    it("should have an ENVIRONMENT VARIABLES section", () => {
      expect(getHelpOutput()).toContain("ENVIRONMENT VARIABLES");
    });

    it("should document OPENROUTER_API_KEY", () => {
      const output = getHelpOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should document SPAWN_NO_UPDATE_CHECK", () => {
      const output = getHelpOutput();
      expect(output).toContain("SPAWN_NO_UPDATE_CHECK");
    });

    it("should document SPAWN_NO_UNICODE", () => {
      const output = getHelpOutput();
      expect(output).toContain("SPAWN_NO_UNICODE");
    });

    it("should document SPAWN_HOME", () => {
      const output = getHelpOutput();
      expect(output).toContain("SPAWN_HOME");
    });

    it("should document SPAWN_DEBUG", () => {
      const output = getHelpOutput();
      expect(output).toContain("SPAWN_DEBUG");
    });
  });

  // ── Links ──────────────────────────────────────────────────────────

  describe("repository links", () => {
    it("should include GitHub repository URL", () => {
      expect(getHelpOutput()).toContain("github.com");
    });

    it("should include OpenRouter URL", () => {
      expect(getHelpOutput()).toContain("openrouter.ai");
    });
  });
});

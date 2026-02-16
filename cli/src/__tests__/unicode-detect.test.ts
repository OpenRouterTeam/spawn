import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for unicode-detect.ts side-effect module.
 *
 * unicode-detect.ts runs at import time and sets process.env.TERM
 * based on environment variables. Since it has side effects, we test
 * it by spawning subprocesses with controlled environments.
 *
 * Agent: test-engineer
 */

const CLI_DIR = resolve(import.meta.dir, "../..");

// Helper: run a small bun script that imports unicode-detect and prints TERM
function detectTerm(env: Record<string, string>): string {
  const script = `
    import "./src/unicode-detect.ts";
    console.log(process.env.TERM);
  `;
  const result = execSync(`bun -e '${script}'`, {
    cwd: CLI_DIR,
    env: { ...env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`, HOME: process.env.HOME },
    encoding: "utf-8",
    timeout: 5000,
  });
  return result.trim();
}

describe("unicode-detect", () => {
  describe("shouldForceAscii logic", () => {
    it("should force ASCII (TERM=linux) when TERM is dumb", () => {
      const term = detectTerm({ TERM: "dumb" });
      expect(term).toBe("linux");
    });

    it("should force ASCII (TERM=linux) when TERM is unset", () => {
      const term = detectTerm({});
      expect(term).toBe("linux");
    });

    it("should force ASCII (TERM=linux) when SSH_CONNECTION is set", () => {
      const term = detectTerm({ TERM: "xterm-256color", SSH_CONNECTION: "1.2.3.4 5678 5.6.7.8 22" });
      expect(term).toBe("linux");
    });

    it("should force ASCII (TERM=linux) when SSH_CLIENT is set", () => {
      const term = detectTerm({ TERM: "xterm-256color", SSH_CLIENT: "1.2.3.4 5678 22" });
      expect(term).toBe("linux");
    });

    it("should force ASCII (TERM=linux) when SSH_TTY is set", () => {
      const term = detectTerm({ TERM: "xterm-256color", SSH_TTY: "/dev/pts/0" });
      expect(term).toBe("linux");
    });

    it("should keep Unicode when TERM is a modern terminal", () => {
      const term = detectTerm({ TERM: "xterm-256color" });
      expect(term).toBe("xterm-256color");
    });

    it("should keep Unicode when SPAWN_UNICODE=1, even with SSH", () => {
      const term = detectTerm({
        TERM: "xterm-256color",
        SSH_CONNECTION: "1.2.3.4 5678 5.6.7.8 22",
        SPAWN_UNICODE: "1",
      });
      expect(term).toBe("xterm-256color");
    });

    it("should force ASCII when SPAWN_NO_UNICODE=1, even with modern terminal", () => {
      const term = detectTerm({ TERM: "xterm-256color", SPAWN_NO_UNICODE: "1" });
      expect(term).toBe("linux");
    });

    it("should force ASCII when SPAWN_ASCII=1", () => {
      const term = detectTerm({ TERM: "xterm-256color", SPAWN_ASCII: "1" });
      expect(term).toBe("linux");
    });

    it("should prioritize SPAWN_UNICODE=1 over SPAWN_ASCII=1", () => {
      // SPAWN_UNICODE is checked first in the code
      const term = detectTerm({
        TERM: "xterm-256color",
        SPAWN_UNICODE: "1",
        SPAWN_ASCII: "1",
      });
      expect(term).toBe("xterm-256color");
    });

    it("should prioritize SPAWN_UNICODE=1 over dumb TERM", () => {
      const term = detectTerm({ TERM: "dumb", SPAWN_UNICODE: "1" });
      expect(term).toBe("dumb");
    });
  });

  describe("LANG environment variable", () => {
    it("should not modify LANG when Unicode is enabled", () => {
      const script = `
        import "./src/unicode-detect.ts";
        console.log(process.env.LANG ?? "undefined");
      `;
      const result = execSync(`bun -e '${script}'`, {
        cwd: CLI_DIR,
        env: { TERM: "xterm-256color", PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.trim()).toBe("undefined");
    });

    it("should preserve existing LANG with UTF-8", () => {
      const script = `
        import "./src/unicode-detect.ts";
        console.log(process.env.LANG);
      `;
      const result = execSync(`bun -e '${script}'`, {
        cwd: CLI_DIR,
        env: { TERM: "xterm-256color", LANG: "fr_FR.UTF-8", PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.trim()).toBe("fr_FR.UTF-8");
    });

    it("should preserve LANG without UTF-8 when Unicode is enabled", () => {
      const script = `
        import "./src/unicode-detect.ts";
        console.log(process.env.LANG);
      `;
      const result = execSync(`bun -e '${script}'`, {
        cwd: CLI_DIR,
        env: { TERM: "xterm-256color", LANG: "C", PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.trim()).toBe("C");
    });
  });

  describe("debug output", () => {
    it("should print debug info to stderr when SPAWN_DEBUG=1", () => {
      const script = `
        import "./src/unicode-detect.ts";
      `;
      // Debug output goes to console.error (stderr), so redirect stderr to stdout
      const result = execSync(`bun -e '${script}' 2>&1`, {
        cwd: CLI_DIR,
        env: {
          TERM: "xterm-256color",
          SPAWN_DEBUG: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result).toContain("[unicode-detect]");
      expect(result).toContain("TERM:");
      expect(result).toContain("Force ASCII:");
    });

    it("should not print debug info without SPAWN_DEBUG", () => {
      const script = `
        import "./src/unicode-detect.ts";
        console.log("done");
      `;
      // Capture both stdout and stderr
      const result = execSync(`bun -e '${script}' 2>&1`, {
        cwd: CLI_DIR,
        env: { TERM: "xterm-256color", PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result).not.toContain("[unicode-detect]");
      expect(result.trim()).toBe("done");
    });
  });
});

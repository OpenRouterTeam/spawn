import { describe, it, expect } from "bun:test";

/**
 * Tests for unknown flag detection in CLI argument parsing.
 *
 * Since index.ts runs main() on import, we replicate the checkUnknownFlags
 * logic as a pure function to test it without side effects.
 */

const KNOWN_FLAGS = new Set([
  "--help", "-h",
  "--version", "-v", "-V",
  "--prompt", "-p", "--prompt-file", "-f",
  "--dry-run", "-n",
  "--debug",
  "--headless",
  "--output",
  "--default",
  "-a", "-c", "--agent", "--cloud",
  "--clear",
]);

/** Replicated from index.ts for testability - returns the first unknown flag or null */
function findUnknownFlag(args: string[]): string | null {
  for (const arg of args) {
    if (
      (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg))) &&
      !KNOWN_FLAGS.has(arg)
    ) {
      return arg;
    }
  }
  return null;
}

describe("Unknown Flag Detection", () => {
  describe("detects unknown flags", () => {
    it("should detect --json as unknown", () => {
      expect(findUnknownFlag(["list", "--json"])).toBe("--json");
    });

    it("should detect --verbose as unknown", () => {
      expect(findUnknownFlag(["claude", "--verbose", "sprite"])).toBe("--verbose");
    });

    it("should detect -x as unknown short flag", () => {
      expect(findUnknownFlag(["list", "-x"])).toBe("-x");
    });

    it("should detect --force as unknown", () => {
      expect(findUnknownFlag(["agents", "--force"])).toBe("--force");
    });

    it("should detect --verbose as unknown", () => {
      expect(findUnknownFlag(["claude", "sprite", "--verbose"])).toBe("--verbose");
    });

    it("should detect unknown flag at the beginning", () => {
      expect(findUnknownFlag(["--json", "list"])).toBe("--json");
    });

    it("should return first unknown when multiple unknown flags", () => {
      expect(findUnknownFlag(["--json", "--verbose", "list"])).toBe("--json");
    });
  });

  describe("allows known flags", () => {
    it("should allow --help", () => {
      expect(findUnknownFlag(["list", "--help"])).toBeNull();
    });

    it("should allow -h", () => {
      expect(findUnknownFlag(["agents", "-h"])).toBeNull();
    });

    it("should allow --version", () => {
      expect(findUnknownFlag(["--version"])).toBeNull();
    });

    it("should allow -v", () => {
      expect(findUnknownFlag(["-v"])).toBeNull();
    });

    it("should allow -V", () => {
      expect(findUnknownFlag(["-V"])).toBeNull();
    });

    it("should allow --prompt (already extracted, but still known)", () => {
      expect(findUnknownFlag(["--prompt"])).toBeNull();
    });

    it("should allow -p", () => {
      expect(findUnknownFlag(["-p"])).toBeNull();
    });

    it("should allow --prompt-file", () => {
      expect(findUnknownFlag(["--prompt-file"])).toBeNull();
    });

    it("should allow -f (short form of --prompt-file)", () => {
      expect(findUnknownFlag(["-f"])).toBeNull();
    });

    it("should allow --dry-run", () => {
      expect(findUnknownFlag(["claude", "sprite", "--dry-run"])).toBeNull();
    });

    it("should allow -n (short form of --dry-run)", () => {
      expect(findUnknownFlag(["claude", "sprite", "-n"])).toBeNull();
    });

    it("should allow --default (used by spawn pick)", () => {
      expect(findUnknownFlag(["--default", "us-central1-a"])).toBeNull();
    });

    it("should allow --output", () => {
      expect(findUnknownFlag(["claude", "sprite", "--output", "json"])).toBeNull();
    });

    it("should allow --headless", () => {
      expect(findUnknownFlag(["claude", "sprite", "--headless"])).toBeNull();
    });

    it("should allow --debug", () => {
      expect(findUnknownFlag(["claude", "sprite", "--debug"])).toBeNull();
    });
  });

  describe("ignores positional arguments", () => {
    it("should not flag agent names", () => {
      expect(findUnknownFlag(["claude", "sprite"])).toBeNull();
    });

    it("should not flag subcommands", () => {
      expect(findUnknownFlag(["list"])).toBeNull();
    });

    it("should not flag the word 'help'", () => {
      expect(findUnknownFlag(["help"])).toBeNull();
    });

    it("should not flag empty args", () => {
      expect(findUnknownFlag([])).toBeNull();
    });

    it("should not flag a bare hyphen", () => {
      expect(findUnknownFlag(["-"])).toBeNull();
    });

    it("should not flag numeric args like -1", () => {
      expect(findUnknownFlag(["-1"])).toBeNull();
    });

    it("should not flag negative numbers like -42", () => {
      expect(findUnknownFlag(["-42"])).toBeNull();
    });
  });

  describe("mixed arguments", () => {
    it("should find unknown flag among valid positional args", () => {
      expect(findUnknownFlag(["claude", "sprite", "--force"])).toBe("--force");
    });

    it("should pass when all args are positional or known flags", () => {
      expect(findUnknownFlag(["claude", "sprite", "--help"])).toBeNull();
    });

    it("should pass with version flag alone", () => {
      expect(findUnknownFlag(["--version"])).toBeNull();
    });
  });
});

import { describe, it, expect } from "bun:test";
import { KNOWN_FLAGS, findUnknownFlag, expandEqualsFlags } from "../flags";

/**
 * Tests for unknown flag detection and flag expansion in CLI argument parsing.
 *
 * Imports KNOWN_FLAGS and findUnknownFlag directly from flags.ts to avoid
 * copy-paste drift (see issue #1744).
 */

describe("Unknown Flag Detection", () => {
  describe("detects unknown flags", () => {
    it("should detect --json as unknown", () => {
      expect(
        findUnknownFlag([
          "list",
          "--json",
        ]),
      ).toBe("--json");
    });

    it("should detect --verbose as unknown", () => {
      expect(
        findUnknownFlag([
          "claude",
          "--verbose",
          "sprite",
        ]),
      ).toBe("--verbose");
    });

    it("should detect -x as unknown short flag", () => {
      expect(
        findUnknownFlag([
          "list",
          "-x",
        ]),
      ).toBe("-x");
    });

    it("should detect --force as unknown", () => {
      expect(
        findUnknownFlag([
          "agents",
          "--force",
        ]),
      ).toBe("--force");
    });

    it("should detect --verbose as unknown", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--verbose",
        ]),
      ).toBe("--verbose");
    });

    it("should detect unknown flag at the beginning", () => {
      expect(
        findUnknownFlag([
          "--json",
          "list",
        ]),
      ).toBe("--json");
    });

    it("should return first unknown when multiple unknown flags", () => {
      expect(
        findUnknownFlag([
          "--json",
          "--verbose",
          "list",
        ]),
      ).toBe("--json");
    });
  });

  describe("allows known flags", () => {
    it("should allow --help", () => {
      expect(
        findUnknownFlag([
          "list",
          "--help",
        ]),
      ).toBeNull();
    });

    it("should allow -h", () => {
      expect(
        findUnknownFlag([
          "agents",
          "-h",
        ]),
      ).toBeNull();
    });

    it("should allow --version", () => {
      expect(
        findUnknownFlag([
          "--version",
        ]),
      ).toBeNull();
    });

    it("should allow -v", () => {
      expect(
        findUnknownFlag([
          "-v",
        ]),
      ).toBeNull();
    });

    it("should allow -V", () => {
      expect(
        findUnknownFlag([
          "-V",
        ]),
      ).toBeNull();
    });

    it("should allow --prompt (already extracted, but still known)", () => {
      expect(
        findUnknownFlag([
          "--prompt",
        ]),
      ).toBeNull();
    });

    it("should allow -p", () => {
      expect(
        findUnknownFlag([
          "-p",
        ]),
      ).toBeNull();
    });

    it("should allow --prompt-file", () => {
      expect(
        findUnknownFlag([
          "--prompt-file",
        ]),
      ).toBeNull();
    });

    it("should allow -f (short form of --prompt-file)", () => {
      expect(
        findUnknownFlag([
          "-f",
        ]),
      ).toBeNull();
    });

    it("should allow --dry-run", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--dry-run",
        ]),
      ).toBeNull();
    });

    it("should allow -n (short form of --dry-run)", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "-n",
        ]),
      ).toBeNull();
    });

    it("should allow --default (used by spawn pick)", () => {
      expect(
        findUnknownFlag([
          "--default",
          "us-central1-a",
        ]),
      ).toBeNull();
    });

    it("should allow --output", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--output",
          "json",
        ]),
      ).toBeNull();
    });

    it("should allow --headless", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--headless",
        ]),
      ).toBeNull();
    });

    it("should allow --debug", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--debug",
        ]),
      ).toBeNull();
    });

    it("should allow --name", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--name",
          "my-box",
        ]),
      ).toBeNull();
    });
  });

  describe("ignores positional arguments", () => {
    it("should not flag agent names", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
        ]),
      ).toBeNull();
    });

    it("should not flag subcommands", () => {
      expect(
        findUnknownFlag([
          "list",
        ]),
      ).toBeNull();
    });

    it("should not flag the word 'help'", () => {
      expect(
        findUnknownFlag([
          "help",
        ]),
      ).toBeNull();
    });

    it("should not flag empty args", () => {
      expect(findUnknownFlag([])).toBeNull();
    });

    it("should not flag a bare hyphen", () => {
      expect(
        findUnknownFlag([
          "-",
        ]),
      ).toBeNull();
    });

    it("should not flag numeric args like -1", () => {
      expect(
        findUnknownFlag([
          "-1",
        ]),
      ).toBeNull();
    });

    it("should not flag negative numbers like -42", () => {
      expect(
        findUnknownFlag([
          "-42",
        ]),
      ).toBeNull();
    });
  });

  describe("mixed arguments", () => {
    it("should find unknown flag among valid positional args", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--force",
        ]),
      ).toBe("--force");
    });

    it("should pass when all args are positional or known flags", () => {
      expect(
        findUnknownFlag([
          "claude",
          "sprite",
          "--help",
        ]),
      ).toBeNull();
    });

    it("should pass with version flag alone", () => {
      expect(
        findUnknownFlag([
          "--version",
        ]),
      ).toBeNull();
    });
  });
});

describe("KNOWN_FLAGS completeness", () => {
  it("should contain --name flag", () => {
    expect(KNOWN_FLAGS.has("--name")).toBe(true);
  });

  it("should contain all expected flags", () => {
    const expected = [
      "--help",
      "-h",
      "--version",
      "-v",
      "-V",
      "--prompt",
      "-p",
      "--prompt-file",
      "-f",
      "--dry-run",
      "-n",
      "--debug",
      "--headless",
      "--output",
      "--name",
      "--default",
      "-a",
      "-c",
      "--agent",
      "--cloud",
      "--clear",
      "--custom",
    ];
    for (const flag of expected) {
      expect(KNOWN_FLAGS.has(flag)).toBe(true);
    }
  });
});

describe("expandEqualsFlags", () => {
  it("should expand --flag=value into two args", () => {
    expect(
      expandEqualsFlags([
        "--prompt=hello",
      ]),
    ).toEqual([
      "--prompt",
      "hello",
    ]);
  });

  it("should expand multiple --flag=value pairs", () => {
    expect(
      expandEqualsFlags([
        "--prompt=hello",
        "--name=box",
      ]),
    ).toEqual([
      "--prompt",
      "hello",
      "--name",
      "box",
    ]);
  });

  it("should pass through args without equals", () => {
    expect(
      expandEqualsFlags([
        "--help",
        "claude",
        "sprite",
      ]),
    ).toEqual([
      "--help",
      "claude",
      "sprite",
    ]);
  });

  it("should not expand short flags", () => {
    expect(
      expandEqualsFlags([
        "-p=value",
      ]),
    ).toEqual([
      "-p=value",
    ]);
  });

  it("should handle empty args", () => {
    expect(expandEqualsFlags([])).toEqual([]);
  });

  it("should handle value containing equals sign", () => {
    expect(
      expandEqualsFlags([
        "--prompt=a=b",
      ]),
    ).toEqual([
      "--prompt",
      "a=b",
    ]);
  });

  it("should handle mixed args", () => {
    expect(
      expandEqualsFlags([
        "claude",
        "--prompt=hello",
        "sprite",
        "--dry-run",
      ]),
    ).toEqual([
      "claude",
      "--prompt",
      "hello",
      "sprite",
      "--dry-run",
    ]);
  });
});

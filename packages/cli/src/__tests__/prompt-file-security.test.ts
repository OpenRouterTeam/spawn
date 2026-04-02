import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripControlChars, validatePromptFilePath, validatePromptFileStats } from "../security.js";

describe("validatePromptFilePath", () => {
  it("should accept normal text file paths", () => {
    expect(() => validatePromptFilePath("prompt.txt")).not.toThrow();
    expect(() => validatePromptFilePath("./prompt.txt")).not.toThrow();
    expect(() => validatePromptFilePath("prompts/task.md")).not.toThrow();
    expect(() => validatePromptFilePath("/home/user/prompt.txt")).not.toThrow();
    expect(() => validatePromptFilePath("/tmp/instructions.md")).not.toThrow();
    expect(() => validatePromptFilePath("/etc/hosts")).not.toThrow();
    expect(() => validatePromptFilePath("/home/user/.config/spawn/prompt.txt")).not.toThrow();
  });

  it("should reject empty paths", () => {
    expect(() => validatePromptFilePath("")).toThrow("Prompt file path is required");
    expect(() => validatePromptFilePath("   ")).toThrow("Prompt file path is required");
  });

  it("should reject credential files of all types", () => {
    const cases: Array<
      [
        string,
        string,
      ]
    > = [
      [
        "/home/user/.ssh/id_rsa",
        "SSH",
      ],
      [
        "/home/user/.ssh/id_ed25519",
        "SSH",
      ],
      [
        "~/.ssh/config",
        "SSH directory",
      ],
      [
        "/root/.ssh/authorized_keys",
        "SSH directory",
      ],
      [
        "/home/user/.aws/credentials",
        "AWS",
      ],
      [
        "/home/user/.aws/config",
        "AWS",
      ],
      [
        "/home/user/.config/gcloud/application_default_credentials.json",
        "Google Cloud",
      ],
      [
        "/home/user/.azure/accessTokens.json",
        "Azure",
      ],
      [
        "/home/user/.kube/config",
        "Kubernetes",
      ],
      [
        "/home/user/.docker/config.json",
        "Docker",
      ],
      [
        ".env",
        "environment file",
      ],
      [
        ".env.local",
        "environment file",
      ],
      [
        ".env.production",
        "environment file",
      ],
      [
        "/app/.env",
        "environment file",
      ],
      [
        "/home/user/.npmrc",
        "npm",
      ],
      [
        "/home/user/.netrc",
        "netrc",
      ],
      [
        "/home/user/.git-credentials",
        "Git credentials",
      ],
    ];
    for (const [path, expectedMsg] of cases) {
      expect(() => validatePromptFilePath(path), path).toThrow(expectedMsg);
    }
  });

  it("should reject system password files", () => {
    expect(() => validatePromptFilePath("/etc/shadow")).toThrow("password hashes");
    expect(() => validatePromptFilePath("/etc/master.passwd")).toThrow("password hashes");
  });

  it("should include helpful error message about exfiltration risk", () => {
    expect(() => validatePromptFilePath("/home/user/.ssh/id_rsa")).toThrow("sent to the agent");
    expect(() => validatePromptFilePath("/home/user/.ssh/id_rsa")).toThrow("plain text file");
  });

  it("should reject SSH key files by filename pattern anywhere in path", () => {
    expect(() => validatePromptFilePath("/tmp/id_rsa")).toThrow("SSH key");
    expect(() => validatePromptFilePath("/backup/id_ed25519")).toThrow("SSH key");
    expect(() => validatePromptFilePath("id_ecdsa")).toThrow("SSH key");
    expect(() => validatePromptFilePath("/tmp/id_rsa.pub")).toThrow("SSH key");
  });

  describe("symlink bypass protection", () => {
    const home = process.env.HOME ?? "";
    const testDir = join(home, ".spawn-test-symlinks");
    const sshDir = join(testDir, ".ssh");
    const envFile = join(testDir, ".env");

    beforeEach(() => {
      mkdirSync(sshDir, {
        recursive: true,
      });
      writeFileSync(join(sshDir, "id_rsa"), "fake-key");
      writeFileSync(envFile, "SECRET=value");
    });

    afterEach(() => {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    });

    it("should reject symlinks pointing to sensitive SSH files", () => {
      const symlink = join(testDir, "innocent.txt");
      symlinkSync(join(sshDir, "id_rsa"), symlink);
      expect(() => validatePromptFilePath(symlink)).toThrow("SSH");
    });

    it("should reject symlinks pointing to .env files", () => {
      const symlink = join(testDir, "notes.txt");
      symlinkSync(envFile, symlink);
      expect(() => validatePromptFilePath(symlink)).toThrow("environment file");
    });

    it("should accept symlinks pointing to non-sensitive files", () => {
      const safeFile = join(testDir, "safe.txt");
      writeFileSync(safeFile, "hello");
      const symlink = join(testDir, "link.txt");
      symlinkSync(safeFile, symlink);
      expect(() => validatePromptFilePath(symlink)).not.toThrow();
    });
  });

  it("should reject paths containing ANSI escape sequences", () => {
    expect(() => validatePromptFilePath("\x1b[2J\x1b[Hfake.txt")).toThrow("control characters");
    expect(() => validatePromptFilePath("file\x1b[31mred.txt")).toThrow("control characters");
  });

  it("should reject paths containing null bytes", () => {
    expect(() => validatePromptFilePath("file\x00.txt")).toThrow("control characters");
  });

  it("should reject paths containing other control characters", () => {
    expect(() => validatePromptFilePath("file\x07bell.txt")).toThrow("control characters");
    expect(() => validatePromptFilePath("file\x08backspace.txt")).toThrow("control characters");
    expect(() => validatePromptFilePath("file\x7Fdel.txt")).toThrow("control characters");
  });
});

describe("stripControlChars", () => {
  it("should strip ANSI escape sequences", () => {
    expect(stripControlChars("\x1b[2J\x1b[Hfake.txt")).toBe("[2J[Hfake.txt");
  });

  it("should strip null bytes", () => {
    expect(stripControlChars("file\x00.txt")).toBe("file.txt");
  });

  it("should strip bell, backspace, and DEL", () => {
    expect(stripControlChars("file\x07\x08\x7F.txt")).toBe("file.txt");
  });

  it("should preserve tabs and newlines", () => {
    expect(stripControlChars("line1\nline2\ttab")).toBe("line1\nline2\ttab");
  });

  it("should return normal strings unchanged", () => {
    expect(stripControlChars("/tmp/prompt.txt")).toBe("/tmp/prompt.txt");
    expect(stripControlChars("")).toBe("");
    expect(stripControlChars("hello world")).toBe("hello world");
  });
});

describe("validatePromptFileStats", () => {
  it("should accept regular files within size limit", () => {
    expect(() =>
      validatePromptFileStats("prompt.txt", {
        isFile: () => true,
        size: 100,
      }),
    ).not.toThrow();
    expect(() =>
      validatePromptFileStats("prompt.txt", {
        isFile: () => true,
        size: 1024 * 1024,
      }),
    ).not.toThrow();
  });

  it("should reject non-regular files", () => {
    expect(() =>
      validatePromptFileStats("/dev/urandom", {
        isFile: () => false,
        size: 100,
      }),
    ).toThrow("not a regular file");
  });

  it("should reject files over 1MB or empty files", () => {
    expect(() =>
      validatePromptFileStats("huge.txt", {
        isFile: () => true,
        size: 1024 * 1024 + 1,
      }),
    ).toThrow("too large");
    expect(() =>
      validatePromptFileStats("empty.txt", {
        isFile: () => true,
        size: 0,
      }),
    ).toThrow("empty");
  });

  it("should show file size in MB for large files", () => {
    const stats = {
      isFile: () => true,
      size: 5 * 1024 * 1024,
    };
    expect(() => validatePromptFileStats("large.bin", stats)).toThrow("5.0MB");
    expect(() => validatePromptFileStats("large.bin", stats)).toThrow("maximum is 1MB");
  });
});

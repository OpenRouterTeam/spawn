import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBackupRoot, listBackups, restoreBackups, snapshotBeforeWrite, snapshotPaths } from "../local/backup.js";

const HOME = process.env.HOME ?? "";

function reset(): void {
  rmSync(getBackupRoot(), {
    recursive: true,
    force: true,
  });
}

describe("local backup primitives", () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    reset();
  });

  it("snapshots an existing file before overwrite and restores its content", () => {
    const target = join(HOME, ".claude", "settings.json");
    mkdirSync(join(HOME, ".claude"), {
      recursive: true,
    });
    writeFileSync(target, '{"theme":"light"}');

    snapshotBeforeWrite(target, "claude");

    // Simulate spawn overwriting the file
    writeFileSync(target, '{"theme":"dark","spawn":true}');

    const summary = restoreBackups();

    expect(summary.restored).toContain(target);
    expect(summary.removed).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe('{"theme":"light"}');
  });

  it("removes a file spawn created when no original existed", () => {
    const target = join(HOME, ".codex", "config.toml");
    expect(existsSync(target)).toBe(false);

    snapshotBeforeWrite(target, "codex");

    // Simulate spawn creating the file
    mkdirSync(join(HOME, ".codex"), {
      recursive: true,
    });
    writeFileSync(target, "model = openrouter/auto");

    const summary = restoreBackups();

    expect(summary.removed).toContain(target);
    expect(summary.restored).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("is idempotent: a second snapshot does not clobber the first", () => {
    const target = join(HOME, ".claude.json");
    writeFileSync(target, "ORIGINAL");

    snapshotBeforeWrite(target, "claude");
    writeFileSync(target, "INTERMEDIATE");
    snapshotBeforeWrite(target, "claude");
    writeFileSync(target, "FINAL");

    const summary = restoreBackups();

    expect(readFileSync(target, "utf-8")).toBe("ORIGINAL");
    expect(summary.restored).toEqual([
      target,
    ]);
  });

  it("filters by agent when an agent is passed to restoreBackups", () => {
    const claudeFile = join(HOME, ".claude", "settings.json");
    const codexFile = join(HOME, ".codex", "config.toml");
    mkdirSync(join(HOME, ".claude"), {
      recursive: true,
    });
    mkdirSync(join(HOME, ".codex"), {
      recursive: true,
    });
    writeFileSync(claudeFile, "claude-original");
    writeFileSync(codexFile, "codex-original");

    snapshotBeforeWrite(claudeFile, "claude");
    snapshotBeforeWrite(codexFile, "codex");

    writeFileSync(claudeFile, "claude-modified");
    writeFileSync(codexFile, "codex-modified");

    const summary = restoreBackups("claude");

    expect(readFileSync(claudeFile, "utf-8")).toBe("claude-original");
    expect(readFileSync(codexFile, "utf-8")).toBe("codex-modified");
    expect(summary.remaining).toBe(1);

    const remaining = listBackups();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agent).toBe("codex");
  });

  it("snapshotPaths walks a list and skips paths it has already snapshotted", () => {
    const a = join(HOME, ".bashrc");
    const b = join(HOME, ".zshrc");
    writeFileSync(a, "a-original");
    writeFileSync(b, "b-original");

    snapshotPaths(
      [
        a,
        b,
        a,
      ],
      "claude",
    );

    expect(listBackups()).toHaveLength(2);

    writeFileSync(a, "a-modified");
    writeFileSync(b, "b-modified");

    restoreBackups();

    expect(readFileSync(a, "utf-8")).toBe("a-original");
    expect(readFileSync(b, "utf-8")).toBe("b-original");
  });

  it("treats a corrupt manifest as empty (no crash)", () => {
    mkdirSync(getBackupRoot(), {
      recursive: true,
    });
    writeFileSync(join(getBackupRoot(), "manifest.json"), "{not valid json");

    expect(listBackups()).toEqual([]);
    expect(() => restoreBackups()).not.toThrow();
  });

  it("removes the backup root once the manifest is empty", () => {
    const target = join(HOME, ".claude.json");
    writeFileSync(target, "ORIG");
    snapshotBeforeWrite(target, "claude");

    expect(existsSync(getBackupRoot())).toBe(true);

    restoreBackups();

    expect(existsSync(getBackupRoot())).toBe(false);
  });
});

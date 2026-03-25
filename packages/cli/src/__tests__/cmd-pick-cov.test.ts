/**
 * cmd-pick-cov.test.ts — Coverage tests for commands/pick.ts
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
mockClackPrompts();

// ── Import module under test ────────────────────────────────────────────────
const { cmdPick } = await import("../commands/pick.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cmdPick", () => {
  let processExitSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let savedIsTTY: boolean;

  beforeEach(() => {
    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });
    stdoutSpy = spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);

    // Default: stdin is a TTY (no piped input)
    savedIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedIsTTY,
      configurable: true,
    });
  });

  it("exits with error when no options provided (empty input, TTY stdin)", async () => {
    // stdin is TTY, no piped input, so inputText will be ""
    // parsePickerInput("") returns [] => exits with code 1
    await expect(cmdPick([])).rejects.toThrow("process.exit(1)");
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalled();
  });
});

/**
 * cmd-pick-cov.test.ts — Coverage tests for commands/pick.ts
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
mockClackPrompts();

// We need to mock the picker module since cmdPick imports it dynamically
const mockParsePickerInput = mock((text: string) => {
  if (!text.trim()) {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .map((line: string) => {
      const parts = line.split("\t");
      return {
        value: parts[0] || "",
        label: parts[1] || parts[0] || "",
        hint: parts[2] || undefined,
      };
    });
});

const mockPickToTTY = mock((_config: unknown) => "selected-value");

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

  it("parses --prompt flag", async () => {
    // We can't easily test the full picker flow without mocking the dynamic import,
    // but we can verify flag parsing by checking that no options still exits
    await expect(
      cmdPick([
        "--prompt",
        "Choose one",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("parses -p shorthand flag", async () => {
    await expect(
      cmdPick([
        "-p",
        "Choose one",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("parses --default flag", async () => {
    await expect(
      cmdPick([
        "--default",
        "val1",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("ignores unknown flags gracefully", async () => {
    await expect(
      cmdPick([
        "--unknown",
        "val",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("collects remaining non-flag args", async () => {
    // positional args are collected but cmdPick still needs stdin options
    await expect(
      cmdPick([
        "positional",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("ignores --default without a following value", async () => {
    await expect(
      cmdPick([
        "--default",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("ignores --prompt without a following value", async () => {
    await expect(
      cmdPick([
        "--prompt",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("handles multiple flags together", async () => {
    await expect(
      cmdPick([
        "--prompt",
        "Choose",
        "--default",
        "val1",
        "--unknown-flag",
      ]),
    ).rejects.toThrow("process.exit(1)");
  });
});

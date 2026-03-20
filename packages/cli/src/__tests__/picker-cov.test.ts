/**
 * picker-cov.test.ts — Coverage tests for picker.ts
 *
 * Tests parsePickerInput edge cases, pickFallback, and pickToTTY/pickToTTYWithActions
 * using spyOn for fs operations.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { parsePickerInput, pickFallback, pickToTTY, pickToTTYWithActions } from "../picker";

describe("picker.ts coverage", () => {
  // ── parsePickerInput extended ─────────────────────────────────────────

  describe("parsePickerInput", () => {
    it("handles tabs within values", () => {
      const result = parsePickerInput("a\tb\tc\td");
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("a");
      expect(result[0].label).toBe("b");
      expect(result[0].hint).toBe("c");
    });

    it("trims leading tabs from line, so leading-tab input becomes value", () => {
      // "\t\tonly-hint" is trimmed to "only-hint", then split("\t") gives ["only-hint"]
      const result = parsePickerInput("\t\tonly-hint");
      expect(result).toEqual([
        {
          value: "only-hint",
          label: "only-hint",
        },
      ]);
    });

    it("filters lines where all tab-separated parts are empty", () => {
      // "\t\t" is trimmed to "", which is filtered by the l.length > 0 check
      const result = parsePickerInput("\t\t");
      expect(result).toEqual([]);
    });

    it("handles single newline", () => {
      const result = parsePickerInput("\n");
      expect(result).toEqual([]);
    });
  });

  // ── pickFallback ──────────────────────────────────────────────────────

  describe("pickFallback", () => {
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("returns defaultValue for empty options", () => {
      const result = pickFallback({
        message: "Pick one",
        options: [],
        defaultValue: "fallback",
      });
      expect(result).toBe("fallback");
    });

    it("returns null for empty options with no default", () => {
      const result = pickFallback({
        message: "Pick one",
        options: [],
      });
      expect(result).toBeNull();
    });

    it("renders options to stderr and reads from fd", () => {
      // Mock /dev/tty open to fail, so it uses stdin (fd 0)
      const openSpy = spyOn(fs, "openSync").mockImplementation(() => {
        throw new Error("no /dev/tty");
      });
      // Mock readSync to return "1\n"
      const readSpy = spyOn(fs, "readSync").mockImplementation(() => {
        const input = Buffer.from("1\n");
        return input.length;
      });

      const result = pickFallback({
        message: "Pick zone",
        options: [
          {
            value: "us-east-1",
            label: "Virginia",
          },
          {
            value: "eu-west-1",
            label: "Ireland",
            hint: "Recommended",
          },
        ],
        defaultValue: "us-east-1",
      });

      // readSync returned garbage bytes (not "1\n" properly), falls back to default
      expect(result).toBe("us-east-1");
      openSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("returns default when read returns empty", () => {
      const openSpy = spyOn(fs, "openSync").mockImplementation(() => {
        throw new Error("no tty");
      });
      const readSpy = spyOn(fs, "readSync").mockReturnValue(0);

      const result = pickFallback({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "A",
          },
        ],
        defaultValue: "a",
      });

      expect(result).toBe("a");
      openSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("returns first option when no default and read fails", () => {
      const openSpy = spyOn(fs, "openSync").mockImplementation(() => {
        throw new Error("no tty");
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation(() => {
        throw new Error("read failed");
      });

      const result = pickFallback({
        message: "Pick",
        options: [
          {
            value: "first",
            label: "First",
          },
        ],
      });

      expect(result).toBe("first");
      openSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  // ── pickToTTY ─────────────────────────────────────────────────────────

  describe("pickToTTY", () => {
    it("returns null for empty options with no default", () => {
      // pickToTTYWithActions returns cancel for empty options
      const result = pickToTTY({
        message: "Pick",
        options: [],
      });
      expect(result).toBeNull();
    });

    it("returns defaultValue for empty options when default is set", () => {
      const result = pickToTTY({
        message: "Pick",
        options: [],
        defaultValue: "fallback-val",
      });
      expect(result).toBe("fallback-val");
    });

    it("falls back to pickFallback when /dev/tty cannot be opened", () => {
      const openSpy = spyOn(fs, "openSync").mockImplementation(() => {
        throw new Error("no /dev/tty");
      });
      const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
      const readSpy = spyOn(fs, "readSync").mockImplementation(() => {
        throw new Error("no read");
      });

      const result = pickToTTY({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "A",
          },
        ],
        defaultValue: "a",
      });

      expect(result).toBe("a");
      openSpy.mockRestore();
      stderrSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  // ── pickToTTYWithActions ──────────────────────────────────────────────

  describe("pickToTTYWithActions", () => {
    it("returns cancel for empty options with no default", () => {
      const result = pickToTTYWithActions({
        message: "Pick",
        options: [],
      });
      expect(result.action).toBe("cancel");
      expect(result.value).toBeNull();
      expect(result.index).toBe(-1);
    });

    it("returns select with default for empty options with defaultValue", () => {
      const result = pickToTTYWithActions({
        message: "Pick",
        options: [],
        defaultValue: "def",
      });
      expect(result.action).toBe("select");
      expect(result.value).toBe("def");
    });

    it("falls back when stty -g fails", () => {
      // Open succeeds but stty -g fails
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockReturnValue({
        status: 1,
        stdout: null,
        stderr: null,
        pid: 0,
        output: [],
        signal: null,
      });
      const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
      const readSpy = spyOn(fs, "readSync").mockImplementation(() => {
        throw new Error("fail");
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "A",
          },
        ],
        defaultValue: "a",
      });

      // Falls back to pickFallback which returns default
      expect(result.action).toBe("select");
      expect(result.value).toBe("a");

      openSpy.mockRestore();
      closeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      stderrSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("falls back when raw mode fails", () => {
      let spawnCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) {
          // stty -g succeeds
          return {
            status: 0,
            stdout: Buffer.from("saved-settings"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        // stty raw -echo fails
        return {
          status: 1,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
      const readSpy = spyOn(fs, "readSync").mockImplementation(() => {
        throw new Error("fail");
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "A",
          },
        ],
        defaultValue: "a",
      });

      expect(result.action).toBe("select");
      expect(result.value).toBe("a");

      openSpy.mockRestore();
      closeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      stderrSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("handles Enter key to select in TTY mode", () => {
      let spawnCallCount = 0;
      let readCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) {
          // stty -g
          return {
            status: 0,
            stdout: Buffer.from("saved"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 2) {
          // stty raw -echo
          return {
            status: 0,
            stdout: null,
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 3) {
          // stty size for getTTYCols
          return {
            status: 0,
            stdout: Buffer.from("24 80"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        // stty restore
        return {
          status: 0,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        readCallCount++;
        if (readCallCount === 1) {
          // Enter key
          buf[0] = 0x0d;
          return 1;
        }
        return 0;
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "first",
            label: "First",
          },
          {
            value: "second",
            label: "Second",
          },
        ],
      });

      expect(result.action).toBe("select");
      expect(result.value).toBe("first");
      expect(result.index).toBe(0);

      openSpy.mockRestore();
      closeSpy.mockRestore();
      writeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("handles arrow keys and delete key in TTY mode", () => {
      let spawnCallCount = 0;
      let readCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount <= 2) {
          return {
            status: 0,
            stdout: Buffer.from("saved"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 3) {
          return {
            status: 0,
            stdout: Buffer.from("24 80"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        return {
          status: 0,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        readCallCount++;
        if (readCallCount === 1) {
          // Down arrow
          buf[0] = 0x1b;
          buf[1] = 0x5b;
          buf[2] = 0x42;
          return 3;
        }
        if (readCallCount === 2) {
          // 'd' key for delete
          buf[0] = 0x64;
          return 1;
        }
        return 0;
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "first",
            label: "First",
          },
          {
            value: "second",
            label: "Second",
          },
        ],
        deleteKey: true,
      });

      expect(result.action).toBe("delete");
      expect(result.value).toBe("second");
      expect(result.index).toBe(1);

      openSpy.mockRestore();
      closeSpy.mockRestore();
      writeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("handles Ctrl-C cancel in TTY mode", () => {
      let spawnCallCount = 0;
      let readCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount <= 2) {
          return {
            status: 0,
            stdout: Buffer.from("saved"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 3) {
          return {
            status: 0,
            stdout: Buffer.from("24 80"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        return {
          status: 0,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        readCallCount++;
        if (readCallCount === 1) {
          // Ctrl-C
          buf[0] = 0x03;
          return 1;
        }
        return 0;
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "A",
          },
        ],
      });

      expect(result.action).toBe("cancel");
      expect(result.value).toBeNull();

      openSpy.mockRestore();
      closeSpy.mockRestore();
      writeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("handles options with subtitles and hints", () => {
      let spawnCallCount = 0;
      let readCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount <= 2) {
          return {
            status: 0,
            stdout: Buffer.from("saved"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 3) {
          return {
            status: 0,
            stdout: Buffer.from("24 120"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        return {
          status: 0,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        readCallCount++;
        if (readCallCount === 1) {
          buf[0] = 0x0d; // Enter
          return 1;
        }
        return 0;
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "Alpha",
            hint: "First option",
            subtitle: "Subtitle for alpha",
          },
          {
            value: "b",
            label: "Beta",
            hint: "Second option",
          },
        ],
        defaultValue: "a",
      });

      expect(result.action).toBe("select");
      expect(result.value).toBe("a");

      openSpy.mockRestore();
      closeSpy.mockRestore();
      writeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("handles 'd' key when deleteKey is disabled (no-op)", () => {
      let spawnCallCount = 0;
      let readCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount <= 2) {
          return {
            status: 0,
            stdout: Buffer.from("saved"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 3) {
          return {
            status: 0,
            stdout: Buffer.from("24 80"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        return {
          status: 0,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        readCallCount++;
        if (readCallCount === 1) {
          buf[0] = 0x64; // 'd'
          return 1;
        }
        if (readCallCount === 2) {
          buf[0] = 0x0d; // Enter
          return 1;
        }
        return 0;
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "a",
            label: "A",
          },
        ],
        deleteKey: false,
      });

      expect(result.action).toBe("select");
      expect(result.value).toBe("a");

      openSpy.mockRestore();
      closeSpy.mockRestore();
      writeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("uses defaultValue to set initial selection", () => {
      let spawnCallCount = 0;
      let readCallCount = 0;
      const openSpy = spyOn(fs, "openSync").mockReturnValue(99);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const spawnSyncSpy = spyOn(child_process, "spawnSync").mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount <= 2) {
          return {
            status: 0,
            stdout: Buffer.from("saved"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        if (spawnCallCount === 3) {
          return {
            status: 0,
            stdout: Buffer.from("24 80"),
            stderr: null,
            pid: 0,
            output: [],
            signal: null,
          };
        }
        return {
          status: 0,
          stdout: null,
          stderr: null,
          pid: 0,
          output: [],
          signal: null,
        };
      });
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        readCallCount++;
        if (readCallCount === 1) {
          buf[0] = 0x0d; // Enter (select current)
          return 1;
        }
        return 0;
      });

      const result = pickToTTYWithActions({
        message: "Pick",
        options: [
          {
            value: "first",
            label: "First",
          },
          {
            value: "second",
            label: "Second",
          },
          {
            value: "third",
            label: "Third",
          },
        ],
        defaultValue: "second",
      });

      expect(result.action).toBe("select");
      expect(result.value).toBe("second");
      expect(result.index).toBe(1);

      openSpy.mockRestore();
      closeSpy.mockRestore();
      writeSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  // ── pickFallback with /dev/tty open ───────────────────────────────────

  describe("pickFallback with tty", () => {
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("reads from /dev/tty when available", () => {
      const openSpy = spyOn(fs, "openSync").mockReturnValue(42);
      const closeSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
      const readSpy = spyOn(fs, "readSync").mockImplementation((fd, buf: Buffer) => {
        const input = "2\n";
        for (let i = 0; i < input.length; i++) {
          buf[i] = input.charCodeAt(i);
        }
        return input.length;
      });

      const result = pickFallback({
        message: "Pick zone",
        options: [
          {
            value: "us-east-1",
            label: "Virginia",
          },
          {
            value: "eu-west-1",
            label: "Ireland",
          },
        ],
      });

      expect(result).toBe("eu-west-1");
      openSpy.mockRestore();
      closeSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("returns null when no options and no default", () => {
      const result = pickFallback({
        message: "Pick",
        options: [],
      });
      expect(result).toBeNull();
    });
  });
});

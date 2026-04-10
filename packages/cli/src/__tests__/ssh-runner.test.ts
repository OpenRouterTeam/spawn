/**
 * ssh-runner.test.ts — Tests for the generic SSH CloudRunner.
 *
 * Tests cover the validation paths that throw before any subprocess is spawned,
 * verifying input sanitization without requiring actual SSH connectivity.
 */

import { describe, expect, it } from "bun:test";
import { makeSshRunner } from "../shared/ssh-runner.js";

describe("makeSshRunner", () => {
  it("returns a CloudRunner with runServer, uploadFile, and downloadFile", () => {
    const runner = makeSshRunner("1.2.3.4", "root", [
      "-i",
      "/tmp/key",
    ]);
    expect(typeof runner.runServer).toBe("function");
    expect(typeof runner.uploadFile).toBe("function");
    expect(typeof runner.downloadFile).toBe("function");
  });

  describe("runServer validation", () => {
    it("throws for empty command", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.runServer("")).rejects.toThrow(
        "Invalid command: must be non-empty and must not contain null bytes",
      );
    });

    it("throws for command containing null bytes", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.runServer("echo\x00pwned")).rejects.toThrow(
        "Invalid command: must be non-empty and must not contain null bytes",
      );
    });

    it("throws for command that is only null bytes", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.runServer("\x00")).rejects.toThrow(
        "Invalid command: must be non-empty and must not contain null bytes",
      );
    });
  });

  describe("uploadFile validation", () => {
    it("throws for path traversal in remote path", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.uploadFile("/local/file.txt", "../etc/passwd")).rejects.toThrow("path traversal detected");
    });

    it("throws for unsafe characters in remote path", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.uploadFile("/local/file.txt", "/path/with spaces")).rejects.toThrow("unsafe characters");
    });
  });

  describe("downloadFile validation", () => {
    it("throws for path traversal in remote path", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.downloadFile("../etc/shadow", "/local/out.txt")).rejects.toThrow("path traversal detected");
    });

    it("throws for unsafe characters in remote path", async () => {
      const runner = makeSshRunner("1.2.3.4", "root", []);
      await expect(runner.downloadFile("/path/with spaces", "/local/out.txt")).rejects.toThrow("unsafe characters");
    });
  });
});

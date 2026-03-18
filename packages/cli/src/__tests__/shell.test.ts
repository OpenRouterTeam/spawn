/**
 * Tests for shared/shell.ts — platform-aware shell execution utilities.
 *
 * Uses platform parameter overrides for testability since process.platform is read-only.
 */

import { describe, expect, it } from "bun:test";
import { getInstallCmd, getInstallScriptUrl, getLocalShell, getWhichCommand, isWindows } from "../shared/shell";

const CDN = "https://example.com";

describe("isWindows", () => {
  it("returns true for win32", () => {
    expect(isWindows("win32")).toBe(true);
  });

  for (const platform of [
    "darwin",
    "linux",
  ] as const) {
    it(`returns false for ${platform}`, () => {
      expect(isWindows(platform)).toBe(false);
    });
  }

  it("uses process.platform when no override", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });
});

describe("getLocalShell", () => {
  it("returns powershell on Windows", () => {
    const [shell, flag] = getLocalShell("win32");
    expect(shell).toBe("powershell.exe");
    expect(flag).toBe("-Command");
  });

  for (const platform of [
    "darwin",
    "linux",
  ] as const) {
    it(`returns bash on ${platform === "darwin" ? "macOS" : "Linux"}`, () => {
      const [shell, flag] = getLocalShell(platform);
      expect(shell).toBe("bash");
      expect(flag).toBe("-c");
    });
  }
});

describe("getInstallScriptUrl", () => {
  it("returns .ps1 URL on Windows", () => {
    expect(getInstallScriptUrl(CDN, "win32")).toBe(`${CDN}/cli/install.ps1`);
  });

  for (const platform of [
    "darwin",
    "linux",
  ] as const) {
    it(`returns .sh URL on ${platform === "darwin" ? "macOS" : "Linux"}`, () => {
      expect(getInstallScriptUrl(CDN, platform)).toBe(`${CDN}/cli/install.sh`);
    });
  }
});

describe("getInstallCmd", () => {
  it("returns irm | iex on Windows", () => {
    const cmd = getInstallCmd(CDN, "win32");
    expect(cmd).toContain("irm");
    expect(cmd).toContain("iex");
    expect(cmd).toContain("install.ps1");
  });

  for (const platform of [
    "darwin",
    "linux",
  ] as const) {
    it(`returns curl | bash on ${platform === "darwin" ? "macOS" : "Linux"}`, () => {
      const cmd = getInstallCmd(CDN, platform);
      expect(cmd).toContain("curl");
      expect(cmd).toContain("bash");
      expect(cmd).toContain("install.sh");
    });
  }
});

describe("getWhichCommand", () => {
  it("returns 'where' on Windows", () => {
    expect(getWhichCommand("win32")).toBe("where");
  });

  for (const platform of [
    "darwin",
    "linux",
  ] as const) {
    it(`returns 'which' on ${platform === "darwin" ? "macOS" : "Linux"}`, () => {
      expect(getWhichCommand(platform)).toBe("which");
    });
  }
});

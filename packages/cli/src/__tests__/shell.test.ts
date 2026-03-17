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

  it("returns false for darwin", () => {
    expect(isWindows("darwin")).toBe(false);
  });

  it("returns false for linux", () => {
    expect(isWindows("linux")).toBe(false);
  });

  it("uses process.platform when no override", () => {
    // On macOS/Linux CI this should be false
    expect(isWindows()).toBe(process.platform === "win32");
  });
});

describe("getLocalShell", () => {
  it("returns powershell on Windows", () => {
    const [shell, flag] = getLocalShell("win32");
    expect(shell).toBe("powershell.exe");
    expect(flag).toBe("-Command");
  });

  it("returns bash on macOS", () => {
    const [shell, flag] = getLocalShell("darwin");
    expect(shell).toBe("bash");
    expect(flag).toBe("-c");
  });

  it("returns bash on Linux", () => {
    const [shell, flag] = getLocalShell("linux");
    expect(shell).toBe("bash");
    expect(flag).toBe("-c");
  });
});

describe("getInstallScriptUrl", () => {
  it("returns .ps1 URL on Windows", () => {
    expect(getInstallScriptUrl(CDN, "win32")).toBe(`${CDN}/cli/install.ps1`);
  });

  it("returns .sh URL on macOS", () => {
    expect(getInstallScriptUrl(CDN, "darwin")).toBe(`${CDN}/cli/install.sh`);
  });

  it("returns .sh URL on Linux", () => {
    expect(getInstallScriptUrl(CDN, "linux")).toBe(`${CDN}/cli/install.sh`);
  });
});

describe("getInstallCmd", () => {
  it("returns irm | iex on Windows", () => {
    const cmd = getInstallCmd(CDN, "win32");
    expect(cmd).toContain("irm");
    expect(cmd).toContain("iex");
    expect(cmd).toContain("install.ps1");
  });

  it("returns curl | bash on macOS", () => {
    const cmd = getInstallCmd(CDN, "darwin");
    expect(cmd).toContain("curl");
    expect(cmd).toContain("bash");
    expect(cmd).toContain("install.sh");
  });
});

describe("getWhichCommand", () => {
  it("returns 'where' on Windows", () => {
    expect(getWhichCommand("win32")).toBe("where");
  });

  it("returns 'which' on macOS", () => {
    expect(getWhichCommand("darwin")).toBe("which");
  });

  it("returns 'which' on Linux", () => {
    expect(getWhichCommand("linux")).toBe("which");
  });
});

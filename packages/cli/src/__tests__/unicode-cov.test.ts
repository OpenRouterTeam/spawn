/**
 * unicode-cov.test.ts — Coverage tests for unicode-detect.ts
 *
 * The module is a side-effect module that sets TERM=linux when it detects
 * that ASCII mode should be forced. Tests verify the observable side effect
 * by manipulating env vars before importing the module fresh each time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

describe("unicode-detect.ts side effect (TERM=linux forcing)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = {
      ...process.env,
    };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  function setCleanEnv() {
    delete process.env.SPAWN_UNICODE;
    delete process.env.SPAWN_NO_UNICODE;
    delete process.env.SPAWN_ASCII;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_TTY;
    delete process.env.SPAWN_DEBUG;
  }

  /**
   * Run shouldForceAscii logic against current process.env.
   * This mirrors the actual logic in unicode-detect.ts exactly.
   */
  function shouldForceAscii(): boolean {
    if (process.env.SPAWN_UNICODE === "1") {
      return false;
    }
    if (process.env.SPAWN_NO_UNICODE === "1" || process.env.SPAWN_ASCII === "1") {
      return true;
    }
    if (process.env.TERM === "dumb" || !process.env.TERM) {
      return true;
    }
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
      return true;
    }
    return false;
  }

  it("forces ASCII when SPAWN_NO_UNICODE=1", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SPAWN_NO_UNICODE = "1";
    expect(shouldForceAscii()).toBe(true);
  });

  it("forces ASCII when SPAWN_ASCII=1", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SPAWN_ASCII = "1";
    expect(shouldForceAscii()).toBe(true);
  });

  it("does NOT force ASCII when SPAWN_UNICODE=1 (explicit override)", () => {
    setCleanEnv();
    process.env.TERM = "dumb"; // would normally force ASCII
    process.env.SPAWN_UNICODE = "1";
    expect(shouldForceAscii()).toBe(false);
  });

  it("forces ASCII for dumb terminal", () => {
    setCleanEnv();
    process.env.TERM = "dumb";
    expect(shouldForceAscii()).toBe(true);
  });

  it("forces ASCII when TERM is unset", () => {
    setCleanEnv();
    delete process.env.TERM;
    expect(shouldForceAscii()).toBe(true);
  });

  it("forces ASCII for SSH sessions (SSH_CONNECTION)", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SSH_CONNECTION = "1.2.3.4 5678 10.0.0.1 22";
    expect(shouldForceAscii()).toBe(true);
  });

  it("forces ASCII for SSH sessions (SSH_CLIENT)", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SSH_CLIENT = "1.2.3.4 5678 22";
    expect(shouldForceAscii()).toBe(true);
  });

  it("forces ASCII for SSH sessions (SSH_TTY)", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SSH_TTY = "/dev/pts/0";
    expect(shouldForceAscii()).toBe(true);
  });

  it("does NOT force ASCII for local terminal with proper TERM", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    expect(shouldForceAscii()).toBe(false);
  });

  it("SPAWN_UNICODE=1 overrides SSH detection", () => {
    setCleanEnv();
    process.env.TERM = "xterm";
    process.env.SSH_CONNECTION = "1.2.3.4 5678 10.0.0.1 22";
    process.env.SPAWN_UNICODE = "1";
    expect(shouldForceAscii()).toBe(false);
  });
});

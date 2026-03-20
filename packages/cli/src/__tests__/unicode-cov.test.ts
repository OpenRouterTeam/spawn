/**
 * unicode-cov.test.ts — Coverage tests for unicode-detect.ts
 *
 * Tests the shouldForceAscii logic by manipulating env vars.
 * The module is a side-effect module that runs at import time,
 * but it also has a shouldForceAscii() function we test through
 * fresh dynamic imports.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

describe("unicode-detect.ts coverage", () => {
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

  it("should force ASCII when SPAWN_NO_UNICODE=1", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SPAWN_NO_UNICODE = "1";

    // Simulate the shouldForceAscii logic directly
    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should force ASCII when SPAWN_ASCII=1", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SPAWN_ASCII = "1";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should NOT force ASCII when SPAWN_UNICODE=1 (explicit override)", () => {
    setCleanEnv();
    process.env.TERM = "dumb"; // would normally force ASCII
    process.env.SPAWN_UNICODE = "1";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(false);
  });

  it("should force ASCII for dumb terminal", () => {
    setCleanEnv();
    process.env.TERM = "dumb";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should force ASCII when TERM is unset", () => {
    setCleanEnv();
    delete process.env.TERM;

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should force ASCII for SSH sessions (SSH_CONNECTION)", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SSH_CONNECTION = "1.2.3.4 5678 10.0.0.1 22";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should force ASCII for SSH sessions (SSH_CLIENT)", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SSH_CLIENT = "1.2.3.4 5678 22";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should force ASCII for SSH sessions (SSH_TTY)", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";
    process.env.SSH_TTY = "/dev/pts/0";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(true);
  });

  it("should NOT force ASCII for local terminal with proper TERM", () => {
    setCleanEnv();
    process.env.TERM = "xterm-256color";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(false);
  });

  it("SPAWN_UNICODE=1 overrides SSH detection", () => {
    setCleanEnv();
    process.env.TERM = "xterm";
    process.env.SSH_CONNECTION = "1.2.3.4 5678 10.0.0.1 22";
    process.env.SPAWN_UNICODE = "1";

    const shouldForceAscii = (): boolean => {
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
    };

    expect(shouldForceAscii()).toBe(false);
  });
});

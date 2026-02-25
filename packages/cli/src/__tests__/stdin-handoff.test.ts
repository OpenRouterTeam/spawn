/**
 * IMPORTANT: stdin handoff regression tests
 *
 * These tests guard against a critical bug where the parent TypeScript process
 * and the child SSH/bash process fight over stdin. The @clack/prompts library
 * (used for interactive prompts during provisioning) corrupts stdin state:
 * - Leaves raw mode enabled or terminal line discipline dirty
 * - Leaves event listeners attached (readline's emitKeypressEvents)
 * - Pauses stdin, blocking the child's fd 0 inheritance
 *
 * When prepareStdinForHandoff() fails to fully reset stdin, users experience:
 * - Having to press Enter 2+ times before input works
 * - Typed characters not appearing / echoing
 * - Complete input breakage requiring terminal restart
 *
 * DO NOT weaken these tests. If prepareStdinForHandoff() changes, update
 * the tests to match but preserve the invariants:
 * 1. All listeners removed
 * 2. Raw mode unconditionally reset (not gated on isRaw)
 * 3. Terminal line discipline reset via stty
 * 4. stdin resumed (not paused)
 */
import { describe, it, expect, afterEach, spyOn, mock } from "bun:test";

// Suppress log output during tests
spyOn(process.stderr, "write").mockImplementation(() => true);

const { prepareStdinForHandoff } = await import("../shared/ui.js");

// Save original property descriptors for restoration
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

/** Install a mock setRawMode on process.stdin (not available in non-TTY test env). */
function installSetRawModeMock(): ReturnType<typeof mock> {
  const fn = mock(() => process.stdin);
  Object.defineProperty(process.stdin, "setRawMode", {
    value: fn,
    writable: true,
    configurable: true,
  });
  return fn;
}

describe("prepareStdinForHandoff", () => {
  // Track spies for cleanup
  let spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    // Restore all spies after each test
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
    // Restore isTTY / isRaw / setRawMode to original state
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
    if (originalIsRaw) {
      Object.defineProperty(process.stdin, "isRaw", originalIsRaw);
    }
    if (originalSetRawMode) {
      Object.defineProperty(process.stdin, "setRawMode", originalSetRawMode);
    }
    // Remove any leftover listeners from test setup
    process.stdin.removeAllListeners();
  });

  it("removes all event listeners from stdin", () => {
    // Simulate @clack leaving behind listeners
    process.stdin.on("data", () => {});
    process.stdin.on("keypress", () => {});
    process.stdin.on("readable", () => {});
    expect(process.stdin.listenerCount("data")).toBeGreaterThan(0);

    prepareStdinForHandoff();

    expect(process.stdin.listenerCount("data")).toBe(0);
    expect(process.stdin.listenerCount("keypress")).toBe(0);
    expect(process.stdin.listenerCount("readable")).toBe(0);
  });

  it("resets raw mode unconditionally when stdin is a TTY", () => {
    // Simulate the tricky case: @clack already toggled raw mode off,
    // but the terminal is still dirty
    const setRawModeMock = installSetRawModeMock();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "isRaw", { value: false, configurable: true });

    // Mock spawnSync and resume to avoid side effects
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), success: true, signalCode: null });
    spies.push(spawnSyncSpy);
    const resumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    spies.push(resumeSpy);

    prepareStdinForHandoff();

    // Must call setRawMode(false) even when isRaw is already false
    expect(setRawModeMock).toHaveBeenCalledWith(false);
  });

  it("does not throw when stdin is not a TTY", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), success: true, signalCode: null });
    spies.push(spawnSyncSpy);
    const resumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    spies.push(resumeSpy);

    // Should not throw — setRawMode is only called for TTYs
    expect(() => prepareStdinForHandoff()).not.toThrow();
  });

  it("calls stty sane to reset terminal line discipline", () => {
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), success: true, signalCode: null });
    spies.push(spawnSyncSpy);
    const resumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    spies.push(resumeSpy);

    prepareStdinForHandoff();

    expect(spawnSyncSpy).toHaveBeenCalledWith(["stty", "sane"], { stdin: "inherit" });
  });

  it("resumes stdin instead of pausing it", () => {
    const resumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    spies.push(resumeSpy);
    const pauseSpy = spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    spies.push(pauseSpy);
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), success: true, signalCode: null });
    spies.push(spawnSyncSpy);

    prepareStdinForHandoff();

    expect(resumeSpy).toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it("handles the full @clack corruption scenario", () => {
    // Simulate full @clack state corruption:
    // - Multiple listeners left behind
    // - isRaw reports false (clack already reset it)
    // - Terminal is still dirty underneath
    process.stdin.on("data", () => {});
    process.stdin.on("keypress", () => {});

    const setRawModeMock = installSetRawModeMock();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "isRaw", { value: false, configurable: true });
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), success: true, signalCode: null });
    spies.push(spawnSyncSpy);
    const resumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    spies.push(resumeSpy);

    prepareStdinForHandoff();

    // All invariants must hold:
    // 1. Listeners removed
    expect(process.stdin.listenerCount("data")).toBe(0);
    expect(process.stdin.listenerCount("keypress")).toBe(0);
    // 2. Raw mode unconditionally reset
    expect(setRawModeMock).toHaveBeenCalledWith(false);
    // 3. stty sane called
    expect(spawnSyncSpy).toHaveBeenCalledWith(["stty", "sane"], { stdin: "inherit" });
    // 4. stdin resumed
    expect(resumeSpy).toHaveBeenCalled();
  });
});

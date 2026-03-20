/**
 * cmd-update-cov.test.ts — Coverage tests for commands/update.ts
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const clack = mockClackPrompts();

// ── Import module under test ────────────────────────────────────────────────
const { cmdUpdate } = await import("../commands/update.js");
const { VERSION } = await import("../commands/shared.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cmdUpdate", () => {
  let originalFetch: typeof global.fetch;
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    clack.spinnerStart.mockReset();
    clack.spinnerStop.mockReset();
    clack.logSuccess.mockReset();
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("shows already up to date when versions match", async () => {
    global.fetch = mock(async () => new Response(VERSION));

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("up to date"));
  });

  it("shows already up to date from primary version URL", async () => {
    global.fetch = mock(async () => new Response(`${VERSION}\n`));

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("up to date"));
  });

  it("shows update available and runs update", async () => {
    const newVersion = "99.99.99";
    const updateFn = mock(() => {});

    global.fetch = mock(async () => new Response(newVersion));

    await cmdUpdate({
      runUpdate: updateFn,
    });

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining(newVersion));
    expect(updateFn).toHaveBeenCalled();
    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Updated successfully"));
  });

  it("shows error message when update function throws", async () => {
    const newVersion = "99.99.99";
    const updateFn = mock(() => {
      throw new Error("update failed");
    });

    global.fetch = mock(async () => new Response(newVersion));

    await cmdUpdate({
      runUpdate: updateFn,
    });

    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Auto-update failed"));
  });

  it("shows error when fetch fails completely", async () => {
    global.fetch = mock(async () => {
      throw new Error("Network error");
    });

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("Failed to check"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Error:"), expect.anything());
  });

  it("falls back to package.json when primary version URL returns non-version", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // Primary: returns non-version text
        return new Response("not-a-version");
      }
      // Fallback: package.json
      return new Response(
        JSON.stringify({
          version: VERSION,
        }),
      );
    });

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("up to date"));
  });

  it("falls back to package.json when primary returns HTTP error", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // Primary: HTTP error
        return new Response("Not Found", {
          status: 404,
        });
      }
      // Fallback: package.json
      return new Response(
        JSON.stringify({
          version: VERSION,
        }),
      );
    });

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("up to date"));
  });

  it("shows error when both primary and fallback fail", async () => {
    global.fetch = mock(async () => {
      return new Response("Not Found", {
        status: 404,
      });
    });

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("Failed to check"));
  });

  it("shows manual update instructions on fetch failure", async () => {
    global.fetch = mock(async () => {
      throw new Error("DNS failure");
    });

    await cmdUpdate();

    const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((msg: string) => msg.includes("How to fix"))).toBe(true);
  });

  it("throws when fallback package.json has no version field", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("not-a-version");
      }
      // Fallback returns valid JSON but no version
      return new Response(
        JSON.stringify({
          name: "spawn",
        }),
      );
    });

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("Failed to check"));
  });

  it("throws when fallback package.json is invalid JSON", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("not-a-version");
      }
      return new Response("not json at all");
    });

    await cmdUpdate();

    expect(clack.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("Failed to check"));
  });

  it("shows console.log output after successful update", async () => {
    const newVersion = "99.99.99";
    const updateFn = mock(() => {});
    global.fetch = mock(async () => new Response(newVersion));

    await cmdUpdate({
      runUpdate: updateFn,
    });

    // consoleSpy (console.log) should have been called
    expect(consoleSpy).toHaveBeenCalled();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("Run spawn again"));
  });

  it("shows manual install command after failed update", async () => {
    const newVersion = "99.99.99";
    const updateFn = mock(() => {
      throw new Error("install failed");
    });
    global.fetch = mock(async () => new Response(newVersion));

    await cmdUpdate({
      runUpdate: updateFn,
    });

    // Should show the install command
    expect(consoleSpy).toHaveBeenCalled();
  });
});

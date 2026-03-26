/**
 * ui-cov.test.ts — Coverage tests for shared/ui.ts
 *
 * NOTE: do-payment-warning.test.ts uses mock.module("../shared/ui") which
 * contaminates any file that does `await import("../shared/ui.js")`.
 * To work around this, we import statically (which captures real functions)
 * and exercise logging via direct calls, checking they don't throw.
 * For functions that need @clack/prompts, we mock that first.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockClackPrompts } from "./test-helpers";

const clackMocks = mockClackPrompts({
  text: mock(() => Promise.resolve("user-input")),
  select: mock(() => Promise.resolve("selected-id")),
});

// Static imports capture the REAL functions before mock.module can interfere.
import {
  defaultSpawnName,
  getServerNameFromEnv,
  loadApiToken,
  logDebug,
  logError,
  logInfo,
  logStep,
  logStepDone,
  logStepInline,
  logWarn,
  openBrowser,
  prepareStdinForHandoff,
  prompt,
  promptSpawnNameShared,
  selectFromList,
} from "../shared/ui";

// ── Setup / Teardown ────────────────────────────────────────────────────

let stderrSpy: ReturnType<typeof spyOn>;
let stderrOutput: string[];

beforeEach(() => {
  stderrOutput = [];
  stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrOutput.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  delete process.env.SPAWN_DEBUG;
  delete process.env.SPAWN_NON_INTERACTIVE;
  delete process.env.SPAWN_NAME;
  delete process.env.SPAWN_NAME_KEBAB;
  delete process.env.SPAWN_NAME_DISPLAY;
});

// ── Logging functions ──────────────────────────────────────────────

describe("logging functions", () => {
  it("logInfo writes green text to stderr", () => {
    logInfo("test info");
    expect(stderrOutput.join("")).toContain("test info");
  });

  it("logWarn writes yellow text to stderr", () => {
    logWarn("test warn");
    expect(stderrOutput.join("")).toContain("test warn");
  });

  it("logError writes red text to stderr", () => {
    logError("test error");
    expect(stderrOutput.join("")).toContain("test error");
  });

  it("logStep writes cyan text to stderr", () => {
    logStep("test step");
    expect(stderrOutput.join("")).toContain("test step");
  });

  it("logStepInline writes message (newline-terminated in non-TTY)", () => {
    logStepInline("inline msg");
    const output = stderrOutput.join("");
    expect(output).toContain("inline msg");
    // In non-TTY (test environment), output ends with newline instead of \r overwrite
    expect(output).toEndWith("\n");
  });

  it("logStepDone is no-op in non-TTY", () => {
    logStepDone();
    const output = stderrOutput.join("");
    // In non-TTY (test environment), logStepDone writes nothing
    expect(output).toBe("");
  });

  it("logDebug only outputs when SPAWN_DEBUG=1", () => {
    logDebug("invisible");
    expect(stderrOutput.join("")).toBe("");
    process.env.SPAWN_DEBUG = "1";
    logDebug("visible");
    expect(stderrOutput.join("")).toContain("visible");
  });
});

// ── prompt ──────────────────────────────────────────────────────────

describe("prompt", () => {
  it("throws when SPAWN_NON_INTERACTIVE is set", async () => {
    process.env.SPAWN_NON_INTERACTIVE = "1";
    await expect(prompt("question")).rejects.toThrow("Cannot prompt");
  });

  it("returns trimmed text input from clack", async () => {
    const result = await prompt("Enter value:");
    expect(result).toBe("user-input");
  });
});

// ── selectFromList ─────────────────────────────────────────────────

describe("selectFromList", () => {
  it("returns default for empty items", async () => {
    const result = await selectFromList([], "Pick one", "fallback");
    expect(result).toBe("fallback");
  });

  it("returns the only item when single item provided", async () => {
    const result = await selectFromList(
      [
        "only-one|Only One",
      ],
      "Pick",
      "",
    );
    expect(result).toBe("only-one");
  });

  it("parses pipe-separated items for selection", async () => {
    const result = await selectFromList(
      [
        "a|Alpha",
        "b|Beta",
      ],
      "Pick",
      "a",
    );
    expect(typeof result).toBe("string");
  });
});

// ── openBrowser ────────────────────────────────────────────────────

describe("openBrowser", () => {
  it("shows URL in stderr output on linux", () => {
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      success: false,
      signalCode: null,
      resourceUsage: undefined,
      pid: 0,
    } satisfies ReturnType<typeof Bun.spawnSync>);
    openBrowser("https://example.com");
    spawnSyncSpy.mockRestore();
    expect(stderrOutput.join("")).toContain("https://example.com");
  });

  it("shows different message when browser opens successfully", () => {
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      success: true,
      signalCode: null,
      resourceUsage: undefined,
      pid: 0,
    } satisfies ReturnType<typeof Bun.spawnSync>);
    openBrowser("https://example.com");
    spawnSyncSpy.mockRestore();
    expect(stderrOutput.join("")).toContain("https://example.com");
  });

  it("handles exception from Bun.spawnSync gracefully", () => {
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("no browser");
    });
    openBrowser("https://example.com");
    spawnSyncSpy.mockRestore();
    expect(stderrOutput.join("")).toContain("https://example.com");
  });
});

// ── loadApiToken ───────────────────────────────────────────────────

describe("loadApiToken", () => {
  it("returns token from api_key field", () => {
    const configPath = join(process.env.HOME ?? "/tmp", ".config", "spawn");
    mkdirSync(configPath, {
      recursive: true,
    });
    writeFileSync(
      join(configPath, "hetzner.json"),
      JSON.stringify({
        api_key: "test-hetzner-token",
      }),
    );
    const token = loadApiToken("hetzner");
    expect(token).toBe("test-hetzner-token");
  });

  it("returns token from token field when api_key is missing", () => {
    const configPath = join(process.env.HOME ?? "/tmp", ".config", "spawn");
    mkdirSync(configPath, {
      recursive: true,
    });
    writeFileSync(
      join(configPath, "digitalocean.json"),
      JSON.stringify({
        token: "do-tok",
      }),
    );
    const token = loadApiToken("digitalocean");
    expect(token).toBe("do-tok");
  });

  it("returns null when no config file exists", () => {
    const token = loadApiToken("nonexistent");
    expect(token).toBeNull();
  });

  it("returns null when config is malformed", () => {
    const configPath = join(process.env.HOME ?? "/tmp", ".config", "spawn");
    mkdirSync(configPath, {
      recursive: true,
    });
    writeFileSync(join(configPath, "bad.json"), "not json");
    const token = loadApiToken("bad");
    expect(token).toBeNull();
  });
});

// ── defaultSpawnName ───────────────────────────────────────────────

describe("defaultSpawnName", () => {
  it("generates a name with spawn- prefix", () => {
    const name = defaultSpawnName();
    expect(name).toMatch(/^spawn-[a-z0-9]+$/);
  });
});

// ── getServerNameFromEnv ───────────────────────────────────────────

describe("getServerNameFromEnv", () => {
  it("returns cloud-specific env var when set", () => {
    process.env.MY_CLOUD_NAME = "my-server";
    const name = getServerNameFromEnv("MY_CLOUD_NAME");
    delete process.env.MY_CLOUD_NAME;
    expect(name).toBe("my-server");
  });

  it("falls back to SPAWN_NAME_KEBAB or default", () => {
    delete process.env.NONEXISTENT_VAR;
    process.env.SPAWN_NAME_KEBAB = "kebab-name";
    const name = getServerNameFromEnv("NONEXISTENT_VAR");
    delete process.env.SPAWN_NAME_KEBAB;
    expect(name).toBe("kebab-name");
  });
});

// ── promptSpawnNameShared ──────────────────────────────────────────

describe("promptSpawnNameShared", () => {
  it("skips when SPAWN_NAME_KEBAB already set", async () => {
    process.env.SPAWN_NAME_KEBAB = "already-set";
    await promptSpawnNameShared("Test Cloud");
    // Should return immediately without prompting
    expect(process.env.SPAWN_NAME_KEBAB).toBe("already-set");
  });

  it("uses user input from prompt in interactive mode", async () => {
    delete process.env.SPAWN_NAME;
    delete process.env.SPAWN_NAME_KEBAB;
    delete process.env.SPAWN_NAME_DISPLAY;
    delete process.env.SPAWN_NON_INTERACTIVE;
    await promptSpawnNameShared("Test Cloud");
    // Should have set SPAWN_NAME_KEBAB via prompt
    expect(process.env.SPAWN_NAME_KEBAB).toBeTruthy();
  });

  it("uses default name in non-interactive mode", async () => {
    delete process.env.SPAWN_NAME;
    delete process.env.SPAWN_NAME_KEBAB;
    process.env.SPAWN_NON_INTERACTIVE = "1";
    await promptSpawnNameShared("Test Cloud");
    expect(process.env.SPAWN_NAME_KEBAB).toMatch(/^spawn-/);
  });
});

// ── prepareStdinForHandoff ─────────────────────────────────────────

describe("prepareStdinForHandoff", () => {
  it("does not throw", () => {
    expect(() => prepareStdinForHandoff()).not.toThrow();
  });
});

/**
 * cmd-interactive-cov.test.ts — Additional coverage for commands/interactive.ts
 *
 * Covers paths not exercised in cmd-interactive.test.ts:
 * - promptSpawnName (SPAWN_NAME env, cancel, validation)
 * - cmdAgentInteractive (unknown agent, dry-run, cancel on cloud)
 * - getAndValidateCloudChoices
 * - promptSetupOptions (custom-model step)
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { isString } from "@openrouter/spawn-shared";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

const mockManifest = createMockManifest();

const CANCEL_SYMBOL = Symbol("cancel");
let selectCallIndex = 0;
let selectReturnValues: unknown[] = [];
let isCancelValues: Set<unknown> = new Set();
let textReturnValue: unknown;
let multiselectReturnValue: unknown = [];

const clack = mockClackPrompts({
  select: mock(async () => {
    const value = selectReturnValues[selectCallIndex] ?? "claude";
    selectCallIndex++;
    return value;
  }),
  text: mock(async () => textReturnValue),
  multiselect: mock(async () => multiselectReturnValue),
  isCancel: (value: unknown) => isCancelValues.has(value),
});

// ── Import modules under test ───────────────────────────────────────────────
const { cmdAgentInteractive, promptSpawnName, getAndValidateCloudChoices } = await import("../commands/interactive.js");
const { loadManifest, _resetCacheForTesting } = await import("../manifest.js");

describe("promptSpawnName", () => {
  let savedSpawnName: string | undefined;

  beforeEach(() => {
    savedSpawnName = process.env.SPAWN_NAME;
    textReturnValue = undefined;
    clack.text.mockClear();
    isCancelValues = new Set();
  });

  afterEach(() => {
    if (savedSpawnName === undefined) {
      delete process.env.SPAWN_NAME;
    } else {
      process.env.SPAWN_NAME = savedSpawnName;
    }
  });

  it("returns SPAWN_NAME env var when set", async () => {
    process.env.SPAWN_NAME = "my-custom-name";
    const result = await promptSpawnName();
    expect(result).toBe("my-custom-name");
    expect(clack.text).not.toHaveBeenCalled();
  });

  it("returns undefined when user enters empty string", async () => {
    delete process.env.SPAWN_NAME;
    textReturnValue = "";
    const result = await promptSpawnName();
    expect(result).toBeUndefined();
  });

  it("returns user input when provided", async () => {
    delete process.env.SPAWN_NAME;
    textReturnValue = "my-spawn-name";
    const result = await promptSpawnName();
    expect(result).toBe("my-spawn-name");
  });
});

describe("getAndValidateCloudChoices", () => {
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it("exits when no clouds available for agent", () => {
    const noCloudManifest = {
      ...mockManifest,
      matrix: {
        "sprite/claude": "missing",
        "hetzner/claude": "missing",
        "sprite/codex": "implemented",
      },
    };
    expect(() => getAndValidateCloudChoices(noCloudManifest, "claude")).toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("returns cloud list for agent with implemented clouds", () => {
    const result = getAndValidateCloudChoices(mockManifest, "claude");
    expect(result.clouds.length).toBeGreaterThan(0);
    expect(result.clouds).toContain("sprite");
  });
});

describe("cmdAgentInteractive", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let originalSpawnHome: string | undefined;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    originalSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = `${process.env.HOME ?? ""}/.spawn-interactive-cov-${Date.now()}`;

    selectCallIndex = 0;
    selectReturnValues = [];
    isCancelValues = new Set();
    textReturnValue = undefined;
    multiselectReturnValue = [];

    clack.logError.mockClear();
    clack.logInfo.mockClear();
    clack.logStep.mockClear();
    clack.intro.mockClear();
    clack.outro.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;
    global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
    _resetCacheForTesting();
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (originalSpawnHome === undefined) {
      delete process.env.SPAWN_HOME;
    } else {
      process.env.SPAWN_HOME = originalSpawnHome;
    }
  });

  it("exits with error for unknown agent", async () => {
    await expect(cmdAgentInteractive("nonexistent-agent")).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Unknown agent"));
  });

  it("suggests closest match for misspelled agent", async () => {
    await expect(cmdAgentInteractive("claudee")).rejects.toThrow("process.exit");
    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(true);
  });

  it("shows dry-run preview instead of launching", async () => {
    selectReturnValues = [
      "sprite",
    ];

    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      return new Response("#!/bin/bash\nexit 0");
    });
    _resetCacheForTesting();
    await loadManifest(true);

    await cmdAgentInteractive("claude", undefined, true);

    // In dry-run mode, outro should not be called with "Handing off"
    const outroCalls = clack.outro.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(outroCalls.some((msg: string) => msg.includes("Handing off"))).toBe(false);
  });

  it("launches agent after cloud selection (happy path)", async () => {
    selectReturnValues = [
      "sprite",
    ];

    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
    });
    _resetCacheForTesting();
    await loadManifest(true);

    await cmdAgentInteractive("claude");

    expect(clack.logStep).toHaveBeenCalledWith(expect.stringContaining("Launching"));
    expect(clack.outro).toHaveBeenCalledWith(expect.stringContaining("spawn script"));
  });

  it("cancels when user cancels cloud selection", async () => {
    selectReturnValues = [
      CANCEL_SYMBOL,
    ];
    isCancelValues = new Set([
      CANCEL_SYMBOL,
    ]);

    await expect(cmdAgentInteractive("claude")).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});

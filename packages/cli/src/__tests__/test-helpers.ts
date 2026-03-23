import type { Manifest } from "../manifest";

import { mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock Data ──────────────────────────────────────────────────────────────────

export const createMockManifest = (): Manifest => ({
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
    },
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
      env: {
        OPENAI_API_KEY: "test-key",
      },
    },
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
      price: "test",
      url: "https://sprite.sh",
      type: "vm",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      price: "test",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/codex": "missing",
  },
});

export const createEmptyManifest = (): Manifest => ({
  agents: {},
  clouds: {},
  matrix: {},
});

// ── Console Mocks ──────────────────────────────────────────────────────────────

export function createConsoleMocks() {
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

export function restoreMocks(
  ...mocks: Array<
    | {
        mockRestore?: () => void;
      }
    | undefined
  >
) {
  mocks.forEach((mock) => {
    mock?.mockRestore();
  });
}

// ── @clack/prompts Mock ──────────────────────────────────────────────────────

export interface ClackPromptsMock {
  logStep: ReturnType<typeof mock>;
  logInfo: ReturnType<typeof mock>;
  logError: ReturnType<typeof mock>;
  logWarn: ReturnType<typeof mock>;
  logSuccess: ReturnType<typeof mock>;
  logMessage: ReturnType<typeof mock>;
  spinnerStart: ReturnType<typeof mock>;
  spinnerStop: ReturnType<typeof mock>;
  spinnerMessage: ReturnType<typeof mock>;
  spinnerClear: ReturnType<typeof mock>;
  intro: ReturnType<typeof mock>;
  outro: ReturnType<typeof mock>;
  cancel: ReturnType<typeof mock>;
  select: ReturnType<typeof mock>;
  autocomplete: ReturnType<typeof mock>;
  text: ReturnType<typeof mock>;
  confirm: ReturnType<typeof mock>;
  multiselect: ReturnType<typeof mock>;
  isCancel: (...args: unknown[]) => boolean;
}

/**
 * Creates a centralized @clack/prompts mock and registers it via mock.module().
 *
 * Returns an object of individual mock refs that tests can use for assertions.
 * Pass `overrides` to customize specific functions (e.g., custom `select` behavior).
 *
 * MUST be called at module top level (before dynamic imports of modules that use @clack/prompts).
 */
export function mockClackPrompts(overrides?: Partial<ClackPromptsMock>): ClackPromptsMock {
  const mocks: ClackPromptsMock = {
    logStep: mock(() => {}),
    logInfo: mock(() => {}),
    logError: mock(() => {}),
    logWarn: mock(() => {}),
    logSuccess: mock(() => {}),
    logMessage: mock(() => {}),
    spinnerStart: mock(() => {}),
    spinnerStop: mock(() => {}),
    spinnerMessage: mock(() => {}),
    spinnerClear: mock(() => {}),
    intro: mock(() => {}),
    outro: mock(() => {}),
    cancel: mock(() => {}),
    select: mock(() => {}),
    autocomplete: mock(async () => "claude"),
    text: mock(async () => undefined),
    confirm: mock(async () => true),
    multiselect: mock(() => Promise.resolve([])),
    isCancel: () => false,
    ...overrides,
  };

  mock.module("@clack/prompts", () => ({
    spinner: () => ({
      start: mocks.spinnerStart,
      stop: mocks.spinnerStop,
      message: mocks.spinnerMessage,
      clear: mocks.spinnerClear,
    }),
    log: {
      step: mocks.logStep,
      info: mocks.logInfo,
      error: mocks.logError,
      warn: mocks.logWarn,
      success: mocks.logSuccess,
      message: mocks.logMessage,
    },
    intro: mocks.intro,
    outro: mocks.outro,
    cancel: mocks.cancel,
    select: mocks.select,
    autocomplete: mocks.autocomplete,
    text: mocks.text,
    confirm: mocks.confirm,
    multiselect: mocks.multiselect,
    isCancel: mocks.isCancel,
  }));

  return mocks;
}

// ── Bun.spawn Mock ─────────────────────────────────────────────────────────────

/**
 * Mocks Bun.spawn to return a fake process with the given exit code, stdout, and stderr.
 * Identical helper was previously duplicated across aws-cov, gcp-cov, do-cov, hetzner-cov,
 * and sprite-cov test files. Centralised here to avoid repetition.
 */
export function mockBunSpawn(exitCode = 0, stdout = "", stderr = "") {
  function createMockProc(): ReturnType<typeof Bun.spawn> {
    return {
      pid: 1234,
      exitCode: Promise.resolve(exitCode),
      exited: Promise.resolve(exitCode),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stdout));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stderr));
          c.close();
        },
      }),
      kill: mock(() => {}),
      killed: false,
      ref: () => {},
      unref: () => {},
      stdin: new WritableStream(),
      signalCode: null,
      resourceUsage: () =>
        ({
          cpuTime: {
            system: 0,
            user: 0,
            total: 0,
          },
          maxRSS: 0,
          sharedMemorySize: 0,
          unsharedDataSize: 0,
          unsharedStackSize: 0,
          minorPageFaults: 0,
          majorPageFaults: 0,
          swapCount: 0,
          inBlock: 0,
          outBlock: 0,
          ipcMessagesSent: 0,
          ipcMessagesReceived: 0,
          signalsReceived: 0,
          voluntaryContextSwitches: 0,
          involuntaryContextSwitches: 0,
        }) satisfies ReturnType<ReturnType<typeof Bun.spawn>["resourceUsage"]>,
    };
  }
  // Return a fresh mock proc per call so ReadableStreams are not reused
  return spyOn(Bun, "spawn").mockImplementation(() => createMockProc());
}

// ── Fetch Mocks ────────────────────────────────────────────────────────────────

export function mockSuccessfulFetch(data: unknown) {
  return mock(() => Promise.resolve(new Response(JSON.stringify(data))));
}

// ── Test Environment Setup ─────────────────────────────────────────────────────

export interface TestEnvironment {
  testDir: string;
  cacheDir: string;
  cacheFile: string;
  originalEnv: NodeJS.ProcessEnv;
  originalFetch: typeof global.fetch;
}

export function setupTestEnvironment(): TestEnvironment {
  const testDir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random()}`);
  mkdirSync(testDir, {
    recursive: true,
  });

  const cacheDir = join(testDir, "spawn");
  const cacheFile = join(cacheDir, "manifest.json");

  const originalEnv = {
    ...process.env,
  };
  const originalFetch = global.fetch;

  process.env.XDG_CACHE_HOME = testDir;

  return {
    testDir,
    cacheDir,
    cacheFile,
    originalEnv,
    originalFetch,
  };
}

export function teardownTestEnvironment(env: TestEnvironment) {
  process.env = env.originalEnv;
  global.fetch = env.originalFetch;

  if (existsSync(env.testDir)) {
    rmSync(env.testDir, {
      recursive: true,
      force: true,
    });
  }

  mock.restore();
}

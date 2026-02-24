import { spyOn, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Manifest } from "../manifest";

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

export function createProcessExitMock() {
  const impl: () => never = () => {
    throw new Error("process.exit");
  };
  return spyOn(process, "exit").mockImplementation(impl);
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

// ── Fetch Mocks ────────────────────────────────────────────────────────────────

export function mockSuccessfulFetch(data: any) {
  return mock(() => Promise.resolve(new Response(JSON.stringify(data))));
}

export function mockFailedFetch(error = "Network error") {
  return mock(() => Promise.reject(new Error(error)));
}

export function mockFetchWithStatus(status: number, data?: any) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(data || {}), {
        status,
        statusText: status === 404 ? "Not Found" : "Error",
      }),
    ),
  );
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

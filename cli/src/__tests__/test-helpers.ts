import { spyOn, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
    aider: {
      name: "Aider",
      description: "AI pair programmer",
      url: "https://aider.chat",
      install: "pip install aider-chat",
      launch: "aider",
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
    "sprite/aider": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/aider": "missing",
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
  return spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as any);
}

export function restoreMocks(...mocks: Array<{ mockRestore?: () => void } | undefined>) {
  mocks.forEach(mock => mock?.mockRestore());
}

// ── Fetch Mocks ────────────────────────────────────────────────────────────────

export function mockSuccessfulFetch(data: any) {
  return mock(() => Promise.resolve({
    ok: true,
    json: async () => data,
  }) as any);
}

export function mockFailedFetch(error: string = "Network error") {
  return mock(() => Promise.reject(new Error(error)));
}

export function mockFetchWithStatus(status: number, data?: any) {
  return mock(() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "Error",
    json: async () => data || {},
  }) as any);
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
  mkdirSync(testDir, { recursive: true });

  const cacheDir = join(testDir, "spawn");
  const cacheFile = join(cacheDir, "manifest.json");

  const originalEnv = { ...process.env };
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
    rmSync(env.testDir, { recursive: true, force: true });
  }

  mock.restore();
}

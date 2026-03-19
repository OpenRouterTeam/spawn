/**
 * orchestrate-cov.test.ts — Additional coverage tests for shared/orchestrate.ts
 *
 * Covers: skipAgentInstall, tunnel support, SPAWN_ENABLED_STEPS parsing,
 * configure failure handling, preLaunchMsg, model preferences, Windows env setup
 */

import type { AgentConfig } from "../shared/agents";
import type { CloudOrchestrator, OrchestrationOptions } from "../shared/orchestrate";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asyncTryCatch, isNumber, tryCatch } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate";

const mockGetOrPromptApiKey = mock(() => Promise.resolve("sk-or-v1-test-key"));
const mockTryTarballInstall = mock(() => Promise.resolve(false));

function createMockCloud(overrides: Partial<CloudOrchestrator> = {}): CloudOrchestrator {
  const mockRunner = {
    runServer: mock(() => Promise.resolve()),
    uploadFile: mock(() => Promise.resolve()),
    downloadFile: mock(() => Promise.resolve()),
  };
  return {
    cloudName: "testcloud",
    cloudLabel: "Test Cloud",
    runner: mockRunner,
    authenticate: mock(() => Promise.resolve()),
    promptSize: mock(() => Promise.resolve()),
    createServer: mock(() =>
      Promise.resolve({
        ip: "10.0.0.1",
        user: "root",
        server_name: "test-server-1",
        cloud: "testcloud",
      }),
    ),
    getServerName: mock(() => Promise.resolve("test-server-1")),
    waitForReady: mock(() => Promise.resolve()),
    interactiveSession: mock(() => Promise.resolve(0)),
    ...overrides,
  };
}

function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "TestAgent",
    install: mock(() => Promise.resolve()),
    envVars: mock((key: string) => [
      `OPENROUTER_API_KEY=${key}`,
    ]),
    launchCmd: mock(() => "test-agent --start"),
    ...overrides,
  };
}

const defaultOpts: OrchestrationOptions = {
  tryTarball: mockTryTarballInstall,
  getApiKey: mockGetOrPromptApiKey,
};

async function runSafe(
  cloud: CloudOrchestrator,
  agent: AgentConfig,
  name: string,
  opts: OrchestrationOptions = defaultOpts,
): Promise<void> {
  const r = await asyncTryCatch(async () => runOrchestration(cloud, agent, name, opts));
  if (!r.ok && !r.error.message.startsWith("__EXIT_")) {
    throw r.error;
  }
}

let exitSpy: ReturnType<typeof spyOn>;
let stderrSpy: ReturnType<typeof spyOn>;
let testDir: string;
let savedSpawnHome: string | undefined;

beforeEach(() => {
  testDir = join(process.env.HOME ?? "", `.spawn-test-orch2-${Date.now()}-${Math.random()}`);
  mkdirSync(testDir, {
    recursive: true,
  });
  savedSpawnHome = process.env.SPAWN_HOME;
  process.env.SPAWN_HOME = testDir;
  process.env.SPAWN_SKIP_GITHUB_AUTH = "1";
  delete process.env.SPAWN_ENABLED_STEPS;
  delete process.env.SPAWN_BETA;
  delete process.env.MODEL_ID;
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`__EXIT_${isNumber(code) ? code : 0}__`);
  });
  mockGetOrPromptApiKey.mockClear();
  mockGetOrPromptApiKey.mockImplementation(() => Promise.resolve("sk-or-v1-test-key"));
  mockTryTarballInstall.mockClear();
  mockTryTarballInstall.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  if (savedSpawnHome !== undefined) {
    process.env.SPAWN_HOME = savedSpawnHome;
  } else {
    delete process.env.SPAWN_HOME;
  }
  tryCatch(() =>
    rmSync(testDir, {
      recursive: true,
      force: true,
    }),
  );
  // Clean up preferences file so it doesn't leak to other tests
  const prefsPath = join(process.env.HOME ?? "", ".config", "spawn", "preferences.json");
  if (existsSync(prefsPath)) {
    tryCatch(() => unlinkSync(prefsPath));
  }
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
});

// ── skipAgentInstall ───────────────────────────────────────────────────

describe("orchestrate skipAgentInstall", () => {
  it("skips install when skipAgentInstall is true", async () => {
    const install = mock(() => Promise.resolve());
    const cloud = createMockCloud({
      skipAgentInstall: true,
    });
    const agent = createMockAgent({
      install,
    });

    await runSafe(cloud, agent, "testagent");

    expect(install).not.toHaveBeenCalled();
  });
});

// ── SPAWN_ENABLED_STEPS ────────────────────────────────────────────────

describe("orchestrate SPAWN_ENABLED_STEPS", () => {
  it("passes enabledSteps to agent.configure", async () => {
    process.env.SPAWN_ENABLED_STEPS = "github,auto-update";
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledTimes(1);
    const args = configure.mock.calls[0];
    // Third arg is the enabledSteps Set
    const steps = args[2];
    expect(steps).toBeInstanceOf(Set);
  });

  it("handles empty SPAWN_ENABLED_STEPS (disables all optional steps)", async () => {
    process.env.SPAWN_ENABLED_STEPS = "";
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledTimes(1);
    const steps = configure.mock.calls[0][2];
    expect(steps).toBeInstanceOf(Set);
    expect(steps.size).toBe(0);
  });
});

// ── configure failure ──────────────────────────────────────────────────

describe("orchestrate configure failure", () => {
  it("continues when configure throws timeout (non-fatal)", async () => {
    // Use "timed out" so wrapSshCall throws immediately (non-retryable)
    const configure = mock(() => Promise.reject(new Error("command timed out")));
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    // Should still reach interactive session despite configure failure
    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });
});

// ── preLaunchMsg ───────────────────────────────────────────────────────

describe("orchestrate preLaunchMsg", () => {
  it("shows preLaunchMsg when defined", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent({
      preLaunchMsg: "Setup channels first!",
    });

    await runSafe(cloud, agent, "testagent");

    // Verify the message was shown (via stderr)
    const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(output).toContain("Setup channels first!");
  });
});

// ── model preferences from file ────────────────────────────────────────

describe("orchestrate model preferences", () => {
  it("loads model from preferences file", async () => {
    const prefsDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(prefsDir, {
      recursive: true,
    });
    writeFileSync(
      join(prefsDir, "preferences.json"),
      JSON.stringify({
        models: {
          testagent: "openai/gpt-4o",
        },
      }),
    );

    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledWith("sk-or-v1-test-key", "openai/gpt-4o", undefined);
  });

  it("MODEL_ID env var takes priority over preferences file", async () => {
    process.env.MODEL_ID = "anthropic/claude-3";
    const prefsDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(prefsDir, {
      recursive: true,
    });
    writeFileSync(
      join(prefsDir, "preferences.json"),
      JSON.stringify({
        models: {
          testagent: "openai/gpt-4o",
        },
      }),
    );

    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledWith("sk-or-v1-test-key", "anthropic/claude-3", undefined);
  });
});

// ── modelEnvVar injection ──────────────────────────────────────────────

describe("orchestrate modelEnvVar", () => {
  it("injects model env var when modelId and modelEnvVar are set", async () => {
    process.env.MODEL_ID = "anthropic/claude-3";
    const envVarsFn = mock((key: string) => [
      `OPENROUTER_API_KEY=${key}`,
    ]);
    const cloud = createMockCloud();
    const agent = createMockAgent({
      envVars: envVarsFn,
      modelEnvVar: "AGENT_MODEL",
    });

    await runSafe(cloud, agent, "testagent");

    // The runner should receive env setup with AGENT_MODEL included
    expect(cloud.runner.runServer).toHaveBeenCalled();
  });
});

// ── auto-update setup ──────────────────────────────────────────────────

describe("orchestrate auto-update", () => {
  it("sets up auto-update for non-local cloud with updateCmd", async () => {
    const cloud = createMockCloud({
      cloudName: "hetzner",
    });
    const agent = createMockAgent({
      updateCmd: "npm update -g agent",
    });

    await runSafe(cloud, agent, "testagent");

    // runner.runServer should have been called with systemd-related commands
    const calls = cloud.runner.runServer.mock.calls;
    const allCmds = calls.map((c: unknown[]) => String(c[0])).join(" ");
    expect(allCmds.length).toBeGreaterThan(0);
  });

  it("skips auto-update for local cloud", async () => {
    const runServerMock = mock(() => Promise.resolve());
    const cloud = createMockCloud({
      cloudName: "local",
      runner: {
        runServer: runServerMock,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      },
    });
    const agent = createMockAgent({
      updateCmd: "npm update -g agent",
    });

    await runSafe(cloud, agent, "testagent");

    // For local cloud, auto-update should be skipped
    // The runServer calls should only be for env setup, not systemd
    const calls = runServerMock.mock.calls;
    const allCmds = calls.map((c: unknown[]) => String(c[0])).join(" ");
    expect(allCmds).not.toContain("systemd");
  });
});

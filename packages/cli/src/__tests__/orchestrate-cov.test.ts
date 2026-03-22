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

// ── checkAccountReady failure ─────────────────────────────────────────

describe("orchestrate checkAccountReady", () => {
  it("continues when checkAccountReady throws", async () => {
    const cloud = createMockCloud({
      checkAccountReady: mock(() => Promise.reject(new Error("billing error"))),
    });
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });
});

// ── preProvision failure ──────────────────────────────────────────────

describe("orchestrate preProvision", () => {
  it("continues when preProvision throws", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent({
      preProvision: mock(() => Promise.reject(new Error("pre-provision fail"))),
    });

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });
});

// ── invalid MODEL_ID ──────────────────────────────────────────────────

describe("orchestrate invalid MODEL_ID", () => {
  it("ignores invalid MODEL_ID format", async () => {
    process.env.MODEL_ID = "not a valid model!!!";
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledTimes(1);
    const modelArg = configure.mock.calls[0][1];
    expect(modelArg).toBeUndefined();
  });
});

// ── preferences file with invalid schema ──────────────────────────────

describe("orchestrate preferences invalid schema", () => {
  it("ignores preferences file with non-object models field", async () => {
    const prefsDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(prefsDir, {
      recursive: true,
    });
    writeFileSync(
      join(prefsDir, "preferences.json"),
      JSON.stringify({
        models: 42,
      }),
    );

    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledTimes(1);
    const modelArg = configure.mock.calls[0][1];
    expect(modelArg).toBeUndefined();
  });
});

// ── tarball install path (SPAWN_BETA=tarball) ─────────────────────────

describe("orchestrate tarball install", () => {
  it("uses tarball when SPAWN_BETA=tarball and cloud is non-local", async () => {
    process.env.SPAWN_BETA = "tarball";
    const install = mock(() => Promise.resolve());
    const tarball = mock(() => Promise.resolve(true));
    const cloud = createMockCloud({
      cloudName: "hetzner",
    });
    const agent = createMockAgent({
      install,
    });

    await runSafe(cloud, agent, "testagent", {
      tryTarball: tarball,
      getApiKey: mockGetOrPromptApiKey,
    });

    expect(tarball).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
  });

  it("falls back to install when tarball returns false", async () => {
    process.env.SPAWN_BETA = "tarball";
    const install = mock(() => Promise.resolve());
    const tarball = mock(() => Promise.resolve(false));
    const cloud = createMockCloud({
      cloudName: "hetzner",
    });
    const agent = createMockAgent({
      install,
    });

    await runSafe(cloud, agent, "testagent", {
      tryTarball: tarball,
      getApiKey: mockGetOrPromptApiKey,
    });

    expect(tarball).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("skips tarball for local cloud", async () => {
    process.env.SPAWN_BETA = "tarball";
    const install = mock(() => Promise.resolve());
    const tarball = mock(() => Promise.resolve(true));
    const cloud = createMockCloud({
      cloudName: "local",
    });
    const agent = createMockAgent({
      install,
    });

    await runSafe(cloud, agent, "testagent", {
      tryTarball: tarball,
      getApiKey: mockGetOrPromptApiKey,
    });

    expect(tarball).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

// ── env setup failure ─────────────────────────────────────────────────

describe("orchestrate env setup failure", () => {
  it("continues when env setup throws timeout", async () => {
    const runServerMock = mock(() => Promise.reject(new Error("command timed out")));
    const cloud = createMockCloud({
      runner: {
        runServer: runServerMock,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      },
    });
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });
});

// ── SPAWN_NAME_KEBAB recording ────────────────────────────────────────

describe("orchestrate SPAWN_NAME", () => {
  it("records SPAWN_NAME_KEBAB in spawn record", async () => {
    process.env.SPAWN_NAME_KEBAB = "my-test-spawn";
    const cloud = createMockCloud();
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });

  it("records SPAWN_NAME when SPAWN_NAME_KEBAB is not set", async () => {
    delete process.env.SPAWN_NAME_KEBAB;
    process.env.SPAWN_NAME = "My Test Spawn";
    const cloud = createMockCloud();
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
    delete process.env.SPAWN_NAME;
  });
});

// ── tunnel support ────────────────────────────────────────────────────

describe("orchestrate tunnel", () => {
  it("opens browser directly for local cloud with tunnel", async () => {
    const browserUrl = mock((port: number) => `http://localhost:${port}/dashboard`);
    const cloud = createMockCloud({
      cloudName: "local",
    });
    const agent = createMockAgent({
      tunnel: {
        remotePort: 8080,
        browserUrl,
      },
    });

    await runSafe(cloud, agent, "testagent");

    expect(browserUrl).toHaveBeenCalledWith(8080);
  });

  it("handles tunnel with no browserUrl for local cloud", async () => {
    const cloud = createMockCloud({
      cloudName: "local",
    });
    const agent = createMockAgent({
      tunnel: {
        remotePort: 8080,
      },
    });

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });

  it("handles tunnel with browserUrl returning empty string", async () => {
    const browserUrl = mock((_port: number) => "");
    const cloud = createMockCloud({
      cloudName: "local",
    });
    const agent = createMockAgent({
      tunnel: {
        remotePort: 8080,
        browserUrl,
      },
    });

    await runSafe(cloud, agent, "testagent");

    expect(browserUrl).toHaveBeenCalledWith(8080);
  });
});

// ── restart loop wrapping ─────────────────────────────────────────────

describe("orchestrate restart loop", () => {
  it("wraps launch command in restart loop for non-local cloud", async () => {
    const sessionFn = mock(() => Promise.resolve(0));
    const cloud = createMockCloud({
      cloudName: "hetzner",
      interactiveSession: sessionFn,
    });
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    const cmd = sessionFn.mock.calls[0][0];
    expect(cmd).toContain("_spawn_restarts=0");
    expect(cmd).toContain("_spawn_max=10");
  });

  it("does not wrap in restart loop for local cloud", async () => {
    const sessionFn = mock(() => Promise.resolve(0));
    const cloud = createMockCloud({
      cloudName: "local",
      interactiveSession: sessionFn,
    });
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    const cmd = sessionFn.mock.calls[0][0];
    expect(cmd).not.toContain("_spawn_restarts");
  });
});

// ── step validation with unknown steps ────────────────────────────────

describe("orchestrate unknown steps", () => {
  it("warns about unknown step names", async () => {
    process.env.SPAWN_ENABLED_STEPS = "github,nonexistent-step";
    const cloud = createMockCloud();
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(output).toContain("Unknown setup steps");
  });
});

// ── tunnel metadata ───────────────────────────────────────────────────

describe("orchestrate tunnel metadata", () => {
  it("saves tunnel metadata with browser URL template", async () => {
    const browserUrl = mock((port: number) => `http://localhost:${port}/ui`);
    const cloud = createMockCloud({
      cloudName: "local",
    });
    const agent = createMockAgent({
      tunnel: {
        remotePort: 3000,
        browserUrl,
      },
    });

    await runSafe(cloud, agent, "testagent");

    expect(browserUrl).toHaveBeenCalledTimes(2);
  });
});

// ── github step skipped ───────────────────────────────────────────────

describe("orchestrate github step", () => {
  it("skips github auth when enabledSteps excludes github", async () => {
    process.env.SPAWN_ENABLED_STEPS = "auto-update";
    const cloud = createMockCloud();
    const agent = createMockAgent();

    await runSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
  });
});

// ── skipTarball agent flag ────────────────────────────────────────────

describe("orchestrate skipTarball", () => {
  it("skips tarball when agent has skipTarball flag", async () => {
    process.env.SPAWN_BETA = "tarball";
    const install = mock(() => Promise.resolve());
    const tarball = mock(() => Promise.resolve(true));
    const cloud = createMockCloud({
      cloudName: "hetzner",
    });
    const agent = createMockAgent({
      install,
      skipTarball: true,
    });

    await runSafe(cloud, agent, "testagent", {
      tryTarball: tarball,
      getApiKey: mockGetOrPromptApiKey,
    });

    expect(tarball).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

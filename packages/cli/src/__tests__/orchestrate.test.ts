/**
 * orchestrate.test.ts — Tests for the shared orchestration pipeline.
 *
 * Verifies that runOrchestration correctly sequences cloud provisioning steps,
 * handles optional hooks (preProvision, configure, preLaunch), model selection,
 * and restart loop wrapping for non-local clouds.
 *
 * IMPORTANT: We only mock ../shared/oauth (not ../shared/agent-setup or
 * ../shared/ui) because Bun's mock.module is process-global and would
 * bleed into with-retry-result.test.ts which tests the real wrapSshCall.
 */

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { isNumber } from "../shared/type-guards.js";

// ── Mock oauth + tarball (needed to avoid interactive prompts / network) ──

const mockGetOrPromptApiKey = mock(() => Promise.resolve("sk-or-v1-test-key"));

mock.module("../shared/oauth", () => ({
  getOrPromptApiKey: mockGetOrPromptApiKey,
}));

// ── Import the real module under test ─────────────────────────────────────

const { runOrchestration } = await import("../shared/orchestrate");

import type { AgentConfig } from "../shared/agents";
import type { CloudOrchestrator, OrchestrationOptions } from "../shared/orchestrate";

const mockTryTarballInstall = mock(() => Promise.resolve(false));

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a minimal mock CloudOrchestrator with all methods as mock functions. */
function createMockCloud(overrides: Partial<CloudOrchestrator> = {}): CloudOrchestrator {
  const mockRunner = {
    runServer: mock(() => Promise.resolve()),
    uploadFile: mock(() => Promise.resolve()),
  };
  return {
    cloudName: "testcloud",
    cloudLabel: "Test Cloud",
    runner: mockRunner,
    authenticate: mock(() => Promise.resolve()),
    promptSize: mock(() => Promise.resolve()),
    createServer: mock(() => Promise.resolve()),
    getServerName: mock(() => Promise.resolve("test-server-1")),
    waitForReady: mock(() => Promise.resolve()),
    interactiveSession: mock(() => Promise.resolve(0)),
    saveLaunchCmd: mock(() => {}),
    ...overrides,
  };
}

/** Create a minimal mock AgentConfig. */
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

/** Default options that inject the mock tarball function. */
const defaultOpts: OrchestrationOptions = {
  tryTarball: mockTryTarballInstall,
};

/** Run orchestration and catch the process.exit throw. */
async function runOrchestrationSafe(
  cloud: CloudOrchestrator,
  agent: AgentConfig,
  agentName: string,
  opts: OrchestrationOptions = defaultOpts,
): Promise<void> {
  try {
    await runOrchestration(cloud, agent, agentName, opts);
  } catch (e) {
    // process.exit mock throws to stop execution — that's expected
    if (e instanceof Error && e.message.startsWith("__EXIT_")) {
      return;
    }
    throw e;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────

describe("runOrchestration", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let capturedExitCode: number | undefined;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    capturedExitCode = undefined;
    // Skip GitHub auth prompts during tests
    process.env.SPAWN_SKIP_GITHUB_AUTH = "1";
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      capturedExitCode = isNumber(code) ? code : 0;
      throw new Error(`__EXIT_${capturedExitCode}__`);
    });
    mockGetOrPromptApiKey.mockClear();
    mockGetOrPromptApiKey.mockImplementation(() => Promise.resolve("sk-or-v1-test-key"));
    mockTryTarballInstall.mockClear();
    mockTryTarballInstall.mockImplementation(() => Promise.resolve(false));
  });

  it("calls all cloud lifecycle methods in correct order", async () => {
    const callOrder: string[] = [];
    const cloud = createMockCloud({
      authenticate: mock(async () => {
        callOrder.push("authenticate");
      }),
      promptSize: mock(async () => {
        callOrder.push("promptSize");
      }),
      getServerName: mock(async () => {
        callOrder.push("getServerName");
        return "srv";
      }),
      createServer: mock(async () => {
        callOrder.push("createServer");
      }),
      waitForReady: mock(async () => {
        callOrder.push("waitForReady");
      }),
      interactiveSession: mock(async () => {
        callOrder.push("interactiveSession");
        return 0;
      }),
      saveLaunchCmd: mock(() => {
        callOrder.push("saveLaunchCmd");
      }),
    });
    const agent = createMockAgent({
      install: mock(async () => {
        callOrder.push("install");
      }),
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(callOrder.indexOf("authenticate")).toBeLessThan(callOrder.indexOf("promptSize"));
    expect(callOrder.indexOf("promptSize")).toBeLessThan(callOrder.indexOf("getServerName"));
    expect(callOrder.indexOf("getServerName")).toBeLessThan(callOrder.indexOf("createServer"));
    expect(callOrder.indexOf("createServer")).toBeLessThan(callOrder.indexOf("waitForReady"));
    expect(callOrder.indexOf("waitForReady")).toBeLessThan(callOrder.indexOf("install"));
    expect(callOrder.indexOf("install")).toBeLessThan(callOrder.indexOf("saveLaunchCmd"));
    expect(callOrder.indexOf("saveLaunchCmd")).toBeLessThan(callOrder.indexOf("interactiveSession"));
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("obtains API key before provisioning server", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent();

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockGetOrPromptApiKey).toHaveBeenCalledTimes(1);
    expect(mockGetOrPromptApiKey).toHaveBeenCalledWith("testagent", "testcloud");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("passes API key to agent.envVars", async () => {
    const envVarsFn = mock((key: string) => [
      `OPENROUTER_API_KEY=${key}`,
    ]);
    const cloud = createMockCloud();
    const agent = createMockAgent({
      envVars: envVarsFn,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(envVarsFn).toHaveBeenCalledWith("sk-or-v1-test-key");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("calls process.exit with interactiveSession exit code", async () => {
    const cloud = createMockCloud({
      interactiveSession: mock(() => Promise.resolve(42)),
    });
    const agent = createMockAgent();

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(capturedExitCode).toBe(42);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("calls process.exit(0) on clean exit", async () => {
    const cloud = createMockCloud({
      interactiveSession: mock(() => Promise.resolve(0)),
    });
    const agent = createMockAgent();

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(capturedExitCode).toBe(0);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── preProvision hook ───────────────────────────────────────────────

  it("calls preProvision when defined", async () => {
    const preProvision = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      preProvision,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(preProvision).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("continues when preProvision throws (non-fatal)", async () => {
    const preProvision = mock(() => Promise.reject(new Error("pre-provision boom")));
    const cloud = createMockCloud();
    const agent = createMockAgent({
      preProvision,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    // Cloud lifecycle should still proceed despite preProvision failure
    expect(cloud.authenticate).toHaveBeenCalledTimes(1);
    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips preProvision when not defined", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent(); // no preProvision

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(cloud.authenticate).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── Model default ──────────────────────────────────────────────────

  it("passes modelDefault to configure without prompting", async () => {
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      modelDefault: "anthropic/claude-3",
      configure,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledWith("sk-or-v1-test-key", "anthropic/claude-3");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("uses MODEL_ID env var when modelDefault is not set", async () => {
    const originalModelId = process.env.MODEL_ID;
    process.env.MODEL_ID = "google/gemini-pro";
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledWith("sk-or-v1-test-key", "google/gemini-pro");
    process.env.MODEL_ID = originalModelId;
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("passes undefined modelId when neither modelDefault nor MODEL_ID is set", async () => {
    const originalModelId = process.env.MODEL_ID;
    delete process.env.MODEL_ID;
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledWith("sk-or-v1-test-key", undefined);
    process.env.MODEL_ID = originalModelId;
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── configure hook ──────────────────────────────────────────────────

  it("calls configure when defined on agent", async () => {
    const configure = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      configure,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(configure).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips configure when not defined on agent", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent(); // no configure

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── preLaunch hook ──────────────────────────────────────────────────

  it("calls preLaunch when defined", async () => {
    const preLaunch = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      preLaunch,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(preLaunch).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips preLaunch when not defined", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent(); // no preLaunch

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── Restart loop wrapping (non-local cloud) ─────────────────────────

  it("wraps launch command in restart loop for non-local clouds", async () => {
    let capturedCmd = "";
    const cloud = createMockCloud({
      cloudName: "hetzner",
      interactiveSession: mock(async (cmd: string) => {
        capturedCmd = cmd;
        return 0;
      }),
    });
    const agent = createMockAgent({
      launchCmd: mock(() => "my-agent --run"),
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(capturedCmd).toContain("_spawn_restarts=0");
    expect(capturedCmd).toContain("_spawn_max=10");
    expect(capturedCmd).toContain("my-agent --run");
    expect(capturedCmd).toContain("Restarting in 5s");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("does NOT wrap launch command for local cloud", async () => {
    let capturedCmd = "";
    const cloud = createMockCloud({
      cloudName: "local",
      interactiveSession: mock(async (cmd: string) => {
        capturedCmd = cmd;
        return 0;
      }),
    });
    const agent = createMockAgent({
      launchCmd: mock(() => "my-agent --run"),
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(capturedCmd).toBe("my-agent --run");
    expect(capturedCmd).not.toContain("_spawn_restarts");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── saveLaunchCmd ───────────────────────────────────────────────────

  it("saves the raw launch command (not the restart-wrapped one)", async () => {
    const saveLaunchCmd = mock(() => {});
    const cloud = createMockCloud({
      cloudName: "hetzner",
      saveLaunchCmd,
    });
    const agent = createMockAgent({
      launchCmd: mock(() => "my-agent --start"),
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(saveLaunchCmd).toHaveBeenCalledTimes(1);
    const args = saveLaunchCmd.mock.calls[0];
    expect(args[0]).toBe("my-agent --start");
    expect(typeof args[1]).toBe("string"); // spawnId
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── install ─────────────────────────────────────────────────────────

  it("calls agent.install during orchestration", async () => {
    const install = mock(() => Promise.resolve());
    const cloud = createMockCloud();
    const agent = createMockAgent({
      install,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(install).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── Tarball install ──────────────────────────────────────────────────

  it("attempts tarball install before agent.install on non-local clouds", async () => {
    const install = mock(() => Promise.resolve());
    const cloud = createMockCloud({
      cloudName: "digitalocean",
    });
    const agent = createMockAgent({
      install,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockTryTarballInstall).toHaveBeenCalledTimes(1);
    expect(mockTryTarballInstall).toHaveBeenCalledWith(cloud.runner, "testagent");
    // Tarball failed (returned false) so agent.install should be called
    expect(install).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips agent.install when tarball succeeds", async () => {
    mockTryTarballInstall.mockImplementation(() => Promise.resolve(true));
    const install = mock(() => Promise.resolve());
    const cloud = createMockCloud({
      cloudName: "hetzner",
    });
    const agent = createMockAgent({
      install,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockTryTarballInstall).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips tarball install for local cloud", async () => {
    const install = mock(() => Promise.resolve());
    const cloud = createMockCloud({
      cloudName: "local",
    });
    const agent = createMockAgent({
      install,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockTryTarballInstall).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips tarball install when agent has skipTarball set", async () => {
    const install = mock(() => Promise.resolve());
    const cloud = createMockCloud({
      cloudName: "digitalocean",
    });
    const agent = createMockAgent({
      install,
      skipTarball: true,
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockTryTarballInstall).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── checkAccountReady ──────────────────────────────────────────────

  it("calls checkAccountReady between authenticate and preProvision", async () => {
    const callOrder: string[] = [];
    const cloud = createMockCloud({
      authenticate: mock(async () => {
        callOrder.push("authenticate");
      }),
      checkAccountReady: mock(async () => {
        callOrder.push("checkAccountReady");
      }),
    });
    const agent = createMockAgent({
      preProvision: mock(async () => {
        callOrder.push("preProvision");
      }),
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(callOrder.indexOf("authenticate")).toBeLessThan(callOrder.indexOf("checkAccountReady"));
    expect(callOrder.indexOf("checkAccountReady")).toBeLessThan(callOrder.indexOf("preProvision"));
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("continues when checkAccountReady throws (non-fatal)", async () => {
    const cloud = createMockCloud({
      checkAccountReady: mock(() => Promise.reject(new Error("billing check failed"))),
    });
    const agent = createMockAgent();

    await runOrchestrationSafe(cloud, agent, "testagent");

    // Cloud lifecycle should still proceed despite checkAccountReady failure
    expect(cloud.createServer).toHaveBeenCalledTimes(1);
    expect(cloud.interactiveSession).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips checkAccountReady when not defined on cloud", async () => {
    const cloud = createMockCloud(); // no checkAccountReady
    const agent = createMockAgent();

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(cloud.authenticate).toHaveBeenCalledTimes(1);
    expect(cloud.createServer).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

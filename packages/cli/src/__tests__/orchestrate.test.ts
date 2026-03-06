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

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { isNumber } from "../shared/type-guards.js";

// ── Mock only oauth (needed to avoid interactive prompts) ─────────────

const mockGetOrPromptApiKey = mock(() => Promise.resolve("sk-or-v1-test-key"));
const mockGetModelIdInteractive = mock(() => Promise.resolve("openrouter/auto"));

mock.module("../shared/oauth", () => ({
  getOrPromptApiKey: mockGetOrPromptApiKey,
  getModelIdInteractive: mockGetModelIdInteractive,
}));

// ── Import the real module under test ─────────────────────────────────────

const { runOrchestration } = await import("../shared/orchestrate");
import type { CloudOrchestrator } from "../shared/orchestrate";
import type { AgentConfig } from "../shared/agents";

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

/** Run orchestration and catch the process.exit throw. */
async function runOrchestrationSafe(cloud: CloudOrchestrator, agent: AgentConfig, agentName: string): Promise<void> {
  try {
    await runOrchestration(cloud, agent, agentName);
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
    mockGetModelIdInteractive.mockClear();
    mockGetModelIdInteractive.mockImplementation(() => Promise.resolve("openrouter/auto"));
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

  // ── Model selection ─────────────────────────────────────────────────

  it("calls getModelIdInteractive when agent.modelPrompt is true", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent({
      modelPrompt: true,
      modelDefault: "anthropic/claude-3",
    });

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockGetModelIdInteractive).toHaveBeenCalledTimes(1);
    expect(mockGetModelIdInteractive).toHaveBeenCalledWith("anthropic/claude-3", "TestAgent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("uses 'openrouter/auto' as default model when modelDefault is not set", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent({
      modelPrompt: true,
    }); // no modelDefault

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockGetModelIdInteractive).toHaveBeenCalledWith("openrouter/auto", "TestAgent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("skips model selection when modelPrompt is falsy", async () => {
    const cloud = createMockCloud();
    const agent = createMockAgent(); // modelPrompt undefined

    await runOrchestrationSafe(cloud, agent, "testagent");

    expect(mockGetModelIdInteractive).not.toHaveBeenCalled();
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
});

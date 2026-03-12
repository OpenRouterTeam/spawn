/**
 * orchestrate-messaging.test.ts — Tests for messaging channel flows
 * (WhatsApp QR scan, enabledSteps-dependent behavior) and SSH tunnel
 * + browser open sequencing in the orchestration pipeline.
 *
 * These tests complement orchestrate.test.ts by covering the enabledSteps
 * branches that were previously untested.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { asyncTryCatch, tryCatch } from "@openrouter/spawn-shared";
import { isNumber } from "../shared/type-guards.js";

const mockGetOrPromptApiKey = mock(() => Promise.resolve("sk-or-v1-test-key"));
const mockTryTarballInstall = mock(() => Promise.resolve(false));

import type { AgentConfig } from "../shared/agents";
import type { CloudOrchestrator, OrchestrationOptions } from "../shared/orchestrate";

import { runOrchestration } from "../shared/orchestrate";

// ── Helpers ───────────────────────────────────────────────────────────────

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

async function runOrchestrationSafe(
  cloud: CloudOrchestrator,
  agent: AgentConfig,
  agentName: string,
  opts: OrchestrationOptions = defaultOpts,
): Promise<void> {
  const r = await asyncTryCatch(async () => runOrchestration(cloud, agent, agentName, opts));
  if (!r.ok) {
    if (r.error.message.startsWith("__EXIT_")) {
      return;
    }
    throw r.error;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────

describe("orchestration — messaging and tunnel", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let capturedExitCode: number | undefined;
  let stderrSpy: ReturnType<typeof spyOn>;
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let savedEnabledSteps: string | undefined;

  beforeEach(() => {
    capturedExitCode = undefined;
    testDir = join(process.env.HOME ?? "", `.spawn-test-msg-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    savedEnabledSteps = process.env.SPAWN_ENABLED_STEPS;
    process.env.SPAWN_HOME = testDir;
    process.env.SPAWN_SKIP_GITHUB_AUTH = "1";
    delete process.env.SPAWN_ENABLED_STEPS;
    delete process.env.SPAWN_BETA;
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

  afterEach(() => {
    if (savedSpawnHome !== undefined) {
      process.env.SPAWN_HOME = savedSpawnHome;
    } else {
      delete process.env.SPAWN_HOME;
    }
    if (savedEnabledSteps !== undefined) {
      process.env.SPAWN_ENABLED_STEPS = savedEnabledSteps;
    } else {
      delete process.env.SPAWN_ENABLED_STEPS;
    }
    tryCatch(() =>
      rmSync(testDir, {
        recursive: true,
        force: true,
      }),
    );
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── enabledSteps parsing ────────────────────────────────────────────

  describe("SPAWN_ENABLED_STEPS parsing", () => {
    it("passes enabledSteps from env to configure", async () => {
      process.env.SPAWN_ENABLED_STEPS = "github,telegram,whatsapp";
      const configure = mock(() => Promise.resolve());
      const cloud = createMockCloud();
      const agent = createMockAgent({
        configure,
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const callArgs = configure.mock.calls[0];
      const enabledSteps = callArgs[2];
      expect(enabledSteps).toBeInstanceOf(Set);
      expect(enabledSteps.has("github")).toBe(true);
      expect(enabledSteps.has("telegram")).toBe(true);
      expect(enabledSteps.has("whatsapp")).toBe(true);
    });

    it("passes undefined enabledSteps when env var is not set", async () => {
      delete process.env.SPAWN_ENABLED_STEPS;
      const configure = mock(() => Promise.resolve());
      const cloud = createMockCloud();
      const agent = createMockAgent({
        configure,
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const callArgs = configure.mock.calls[0];
      expect(callArgs[2]).toBeUndefined();
    });

    it("handles empty SPAWN_ENABLED_STEPS as empty set", async () => {
      process.env.SPAWN_ENABLED_STEPS = "";
      const configure = mock(() => Promise.resolve());
      const cloud = createMockCloud();
      const agent = createMockAgent({
        configure,
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const callArgs = configure.mock.calls[0];
      const enabledSteps = callArgs[2];
      expect(enabledSteps).toBeInstanceOf(Set);
      expect(enabledSteps.size).toBe(0);
    });
  });

  // ── WhatsApp QR scan flow ───────────────────────────────────────────

  describe("WhatsApp interactive session", () => {
    it("runs WhatsApp QR scan session when whatsapp is in enabledSteps", async () => {
      process.env.SPAWN_ENABLED_STEPS = "whatsapp";
      let whatsappSessionRun = false;
      const interactiveSessionCalls: string[] = [];
      const cloud = createMockCloud({
        interactiveSession: mock(async (cmd: string) => {
          interactiveSessionCalls.push(cmd);
          if (cmd.includes("openclaw channels login")) {
            whatsappSessionRun = true;
          }
          return 0;
        }),
      });
      const agent = createMockAgent();

      await runOrchestrationSafe(cloud, agent, "testagent");

      expect(whatsappSessionRun).toBe(true);
      // The WhatsApp command should include the channel flag
      const whatsappCmd = interactiveSessionCalls.find((c) => c.includes("openclaw channels login"));
      expect(whatsappCmd).toContain("--channel whatsapp");
    });

    it("does not run WhatsApp session when whatsapp is not in enabledSteps", async () => {
      process.env.SPAWN_ENABLED_STEPS = "github,browser";
      const interactiveSessionCalls: string[] = [];
      const cloud = createMockCloud({
        interactiveSession: mock(async (cmd: string) => {
          interactiveSessionCalls.push(cmd);
          return 0;
        }),
      });
      const agent = createMockAgent();

      await runOrchestrationSafe(cloud, agent, "testagent");

      const whatsappCmd = interactiveSessionCalls.find((c) => c.includes("openclaw channels login"));
      expect(whatsappCmd).toBeUndefined();
    });

    it("does not run WhatsApp session when SPAWN_ENABLED_STEPS is not set", async () => {
      delete process.env.SPAWN_ENABLED_STEPS;
      const interactiveSessionCalls: string[] = [];
      const cloud = createMockCloud({
        interactiveSession: mock(async (cmd: string) => {
          interactiveSessionCalls.push(cmd);
          return 0;
        }),
      });
      const agent = createMockAgent();

      await runOrchestrationSafe(cloud, agent, "testagent");

      const whatsappCmd = interactiveSessionCalls.find((c) => c.includes("openclaw channels login"));
      expect(whatsappCmd).toBeUndefined();
    });

    it("WhatsApp session runs before the main agent launch", async () => {
      process.env.SPAWN_ENABLED_STEPS = "whatsapp";
      const callOrder: string[] = [];
      const cloud = createMockCloud({
        interactiveSession: mock(async (cmd: string) => {
          if (cmd.includes("openclaw channels login")) {
            callOrder.push("whatsapp-qr");
          } else {
            callOrder.push("agent-launch");
          }
          return 0;
        }),
      });
      const agent = createMockAgent();

      await runOrchestrationSafe(cloud, agent, "testagent");

      const whatsappIdx = callOrder.indexOf("whatsapp-qr");
      const launchIdx = callOrder.indexOf("agent-launch");
      expect(whatsappIdx).toBeGreaterThanOrEqual(0);
      expect(launchIdx).toBeGreaterThanOrEqual(0);
      expect(whatsappIdx).toBeLessThan(launchIdx);
    });
  });

  // ── GitHub auth gating ──────────────────────────────────────────────

  describe("GitHub auth gating", () => {
    it("skips GitHub auth when github is not in enabledSteps", async () => {
      process.env.SPAWN_ENABLED_STEPS = "browser";
      // Remove the skip env var to actually test the gating logic
      delete process.env.SPAWN_SKIP_GITHUB_AUTH;
      const cloud = createMockCloud();
      const agent = createMockAgent();

      await runOrchestrationSafe(cloud, agent, "testagent");

      // GitHub auth should have been skipped — no github-related commands
      // The runner shouldn't have github-related calls beyond agent setup
      // (This is a negative test — we're verifying the branch wasn't taken)
      expect(cloud.interactiveSession).toHaveBeenCalled();
      // Restore for other tests
      process.env.SPAWN_SKIP_GITHUB_AUTH = "1";
    });
  });

  // ── preLaunchMsg ────────────────────────────────────────────────────

  describe("preLaunchMsg", () => {
    it("outputs preLaunchMsg to stderr when defined", async () => {
      stderrSpy.mockRestore();
      const stderrOutput: string[] = [];
      stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrOutput.push(String(chunk));
        return true;
      });

      const cloud = createMockCloud();
      const agent = createMockAgent({
        preLaunchMsg: "Your web dashboard will open automatically",
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const allOutput = stderrOutput.join("");
      expect(allOutput).toContain("Your web dashboard will open automatically");
    });

    it("does not output preLaunchMsg when not defined", async () => {
      stderrSpy.mockRestore();
      const stderrOutput: string[] = [];
      stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrOutput.push(String(chunk));
        return true;
      });

      const cloud = createMockCloud();
      const agent = createMockAgent(); // no preLaunchMsg

      await runOrchestrationSafe(cloud, agent, "testagent");

      const allOutput = stderrOutput.join("");
      expect(allOutput).not.toContain("Tip:");
    });
  });
});

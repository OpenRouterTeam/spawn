/**
 * auto-update.test.ts — Tests for the agent auto-update systemd service setup.
 *
 * Verifies that setupAutoUpdate generates the correct systemd units and
 * wrapper script, and that the orchestration pipeline calls it for cloud
 * VMs but skips it for local execution and agents without updateCmd.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { asyncTryCatch, isNumber, isString, tryCatch } from "@openrouter/spawn-shared";

const mockGetOrPromptApiKey = mock(() => Promise.resolve("sk-or-v1-test-key"));
const mockTryTarballInstall = mock(() => Promise.resolve(false));

import type { AgentConfig } from "../shared/agents";
import type { CloudOrchestrator, OrchestrationOptions } from "../shared/orchestrate";

import { setupAutoUpdate } from "../shared/agent-setup";
import { runOrchestration } from "../shared/orchestrate";

// ── Helpers ───────────────────────────────────────────────────────────────

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

describe("auto-update service", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let savedEnabledSteps: string | undefined;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `.spawn-test-autoupdate-${Date.now()}-${Math.random()}`);
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

  describe("setupAutoUpdate direct", () => {
    it("calls runServer with systemd unit setup script", async () => {
      const runServer = mock(() => Promise.resolve());
      const runner = {
        runServer,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      };

      await setupAutoUpdate(runner, "claude", "npm install -g @anthropic-ai/claude-code@latest");

      expect(runServer).toHaveBeenCalledTimes(1);
      const script = runServer.mock.calls[0][0];
      expect(script).toContain("command -v systemctl");
      expect(script).toContain("/usr/local/bin/spawn-auto-update");
      expect(script).toContain("spawn-auto-update.service");
      expect(script).toContain("spawn-auto-update.timer");
      expect(script).toContain("systemctl enable spawn-auto-update.timer");
      expect(script).toContain("systemctl start spawn-auto-update.timer");
      expect(script).toContain("systemctl daemon-reload");
    });

    it("uses base64-encoded wrapper containing the update command", async () => {
      const runServer = mock(() => Promise.resolve());
      const runner = {
        runServer,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      };

      await setupAutoUpdate(runner, "codex", "npm install -g @openai/codex@latest");

      const script = runServer.mock.calls[0][0];
      const wrapperMatch =
        /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| \$_sudo tee \/usr\/local\/bin\/spawn-auto-update/.exec(script);
      expect(wrapperMatch).toBeTruthy();
      const decoded = Buffer.from(wrapperMatch![1], "base64").toString("utf-8");
      expect(decoded).toContain("npm install -g @openai/codex@latest");
      expect(decoded).toContain("source");
      expect(decoded).toContain(".spawnrc");
      expect(decoded).toContain("flock -n 9");
      expect(decoded).toContain("LOCKFILE");
    });

    it("includes system updates with dpkg lock coordination", async () => {
      const runServer = mock(() => Promise.resolve());
      const runner = {
        runServer,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      };

      await setupAutoUpdate(runner, "claude", "npm install -g @anthropic-ai/claude-code@latest");

      const script = runServer.mock.calls[0][0];
      const allB64Matches = script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)'/g);
      let wrapperContent = "";
      for (const m of allB64Matches) {
        const decoded = Buffer.from(m[1], "base64").toString("utf-8");
        if (decoded.includes("apt-get")) {
          wrapperContent = decoded;
          break;
        }
      }
      expect(wrapperContent).not.toBe("");
      expect(wrapperContent).toContain("apt-get update");
      expect(wrapperContent).toContain("apt-get upgrade");
      expect(wrapperContent).toContain("DEBIAN_FRONTEND=noninteractive");
      expect(wrapperContent).toContain("force-confdef");
      expect(wrapperContent).toContain("flock -w 300 /var/lib/dpkg/lock-frontend");
      expect(wrapperContent).toContain("unattended-upgrades");
    });

    it("timer unit has correct schedule", async () => {
      const runServer = mock(() => Promise.resolve());
      const runner = {
        runServer,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      };

      await setupAutoUpdate(runner, "openclaw", "npm install -g openclaw@latest");

      const script = runServer.mock.calls[0][0];
      const allB64Matches = script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)'/g);
      let timerContent = "";
      for (const m of allB64Matches) {
        const decoded = Buffer.from(m[1], "base64").toString("utf-8");
        if (decoded.includes("OnUnitActiveSec")) {
          timerContent = decoded;
          break;
        }
      }
      expect(timerContent).not.toBe("");
      expect(timerContent).toContain("OnBootSec=15min");
      expect(timerContent).toContain("OnUnitActiveSec=6h");
      expect(timerContent).toContain("RandomizedDelaySec=30min");
      expect(timerContent).toContain("Persistent=true");
    });

    it("does not throw on runServer failure (non-fatal)", async () => {
      const runServer = mock(() => Promise.reject(new Error("SSH connection refused")));
      const runner = {
        runServer,
        uploadFile: mock(() => Promise.resolve()),
        downloadFile: mock(() => Promise.resolve()),
      };

      await setupAutoUpdate(runner, "claude", "npm install -g @anthropic-ai/claude-code@latest");
      // runServer was attempted — failure is swallowed as non-fatal
      expect(runServer).toHaveBeenCalled();
    });
  });

  describe("orchestration integration", () => {
    it("calls setupAutoUpdate for cloud VMs when agent has updateCmd", async () => {
      const runServer = mock(() => Promise.resolve());
      const cloud = createMockCloud({
        cloudName: "digitalocean",
        runner: {
          runServer,
          uploadFile: mock(() => Promise.resolve()),
          downloadFile: mock(() => Promise.resolve()),
        },
      });
      const agent = createMockAgent({
        updateCmd: "npm install -g test-agent@latest",
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const calls = runServer.mock.calls.map((c) => c[0]);
      const autoUpdateCall = calls.find((cmd: string) => isString(cmd) && cmd.includes("spawn-auto-update"));
      expect(autoUpdateCall).toBeTruthy();
    });

    it("skips setupAutoUpdate for local cloud", async () => {
      const runServer = mock(() => Promise.resolve());
      const cloud = createMockCloud({
        cloudName: "local",
        runner: {
          runServer,
          uploadFile: mock(() => Promise.resolve()),
          downloadFile: mock(() => Promise.resolve()),
        },
      });
      const agent = createMockAgent({
        updateCmd: "npm install -g test-agent@latest",
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const calls = runServer.mock.calls.map((c) => c[0]);
      const autoUpdateCall = calls.find((cmd: string) => isString(cmd) && cmd.includes("spawn-auto-update"));
      expect(autoUpdateCall).toBeUndefined();
    });

    it("skips setupAutoUpdate when auto-update step is disabled", async () => {
      process.env.SPAWN_ENABLED_STEPS = "github";
      const runServer = mock(() => Promise.resolve());
      const cloud = createMockCloud({
        cloudName: "digitalocean",
        runner: {
          runServer,
          uploadFile: mock(() => Promise.resolve()),
          downloadFile: mock(() => Promise.resolve()),
        },
      });
      const agent = createMockAgent({
        updateCmd: "npm install -g test-agent@latest",
      });

      await runOrchestrationSafe(cloud, agent, "testagent");

      const calls = runServer.mock.calls.map((c) => c[0]);
      const autoUpdateCall = calls.find((cmd: string) => isString(cmd) && cmd.includes("spawn-auto-update"));
      expect(autoUpdateCall).toBeUndefined();
    });

    it("skips setupAutoUpdate when agent has no updateCmd", async () => {
      const runServer = mock(() => Promise.resolve());
      const cloud = createMockCloud({
        cloudName: "digitalocean",
        runner: {
          runServer,
          uploadFile: mock(() => Promise.resolve()),
          downloadFile: mock(() => Promise.resolve()),
        },
      });
      const agent = createMockAgent();

      await runOrchestrationSafe(cloud, agent, "testagent");

      const calls = runServer.mock.calls.map((c) => c[0]);
      const autoUpdateCall = calls.find((cmd: string) => isString(cmd) && cmd.includes("spawn-auto-update"));
      expect(autoUpdateCall).toBeUndefined();
    });
  });
});

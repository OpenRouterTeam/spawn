/**
 * agent-setup-cov.test.ts — Coverage tests for shared/agent-setup.ts
 *
 * Covers: createCloudAgents, offerGithubAuth, installAgent,
 * uploadConfigFile, validateRemotePath
 * (wrapSshCall is covered in with-retry-result.test.ts)
 * (setupAutoUpdate is covered in auto-update.test.ts)
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

const clackMocks = mockClackPrompts({
  text: mock(() => Promise.resolve("")),
  select: mock(() => Promise.resolve("")),
});

// Must import after mock.module for @clack/prompts
const { offerGithubAuth, createCloudAgents } = await import("../shared/agent-setup.js");

let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  delete process.env.SPAWN_SKIP_GITHUB_AUTH;
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ── offerGithubAuth ────────────────────────────────────────────────────

describe("offerGithubAuth", () => {
  it("skips when SPAWN_SKIP_GITHUB_AUTH is set", async () => {
    process.env.SPAWN_SKIP_GITHUB_AUTH = "1";
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    await offerGithubAuth(runner);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("skips when not explicitly requested and no github auth detected", async () => {
    delete process.env.SPAWN_SKIP_GITHUB_AUTH;
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    // No GITHUB_TOKEN, no gh auth token — should skip
    await offerGithubAuth(runner, false);
    // When neither githubAuthRequested nor explicitlyRequested, returns early
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("runs when explicitly requested", async () => {
    delete process.env.SPAWN_SKIP_GITHUB_AUTH;
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    await offerGithubAuth(runner, true);
    // Should have called runServer for github-auth.sh install
    expect(runner.runServer).toHaveBeenCalled();
  });

  it("handles runServer failure gracefully", async () => {
    delete process.env.SPAWN_SKIP_GITHUB_AUTH;
    // Create an operational error (has a code property)
    const opError = Object.assign(new Error("SSH failed"), {
      code: "ECONNREFUSED",
    });
    const runner = {
      runServer: mock(() => Promise.reject(opError)),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    await offerGithubAuth(runner, true);
    // runServer was attempted — error swallowed, not rethrown
    expect(runner.runServer).toHaveBeenCalled();
  });
});

// ── createCloudAgents ──────────────────────────────────────────────────

describe("createCloudAgents", () => {
  it("returns agents map with all expected agent keys", () => {
    const result = createCloudAgents({
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    });
    const keys = Object.keys(result.agents);
    expect(keys.length).toBeGreaterThan(0);
    // All registered agents must have non-empty names
    for (const key of keys) {
      expect(result.agents[key].name.length).toBeGreaterThan(0);
    }
  });

  it("agents generate env vars with API key", () => {
    const result = createCloudAgents({
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    });
    const firstAgent = Object.values(result.agents)[0];
    const envVars = firstAgent.envVars("sk-test-key");
    expect(envVars.length).toBeGreaterThan(0);
    expect(envVars.some((v: string) => v.includes("sk-test-key"))).toBe(true);
  });

  it("resolveAgent returns agent by name", () => {
    const result = createCloudAgents({
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    });
    const firstKey = Object.keys(result.agents)[0];
    const agent = result.resolveAgent(firstKey);
    expect(agent.name).toBe(result.agents[firstKey].name);
  });

  it("resolveAgent throws for unknown agent", () => {
    const result = createCloudAgents({
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    });
    expect(() => result.resolveAgent("nonexistent-agent")).toThrow();
  });

  it("agents have install functions that can be called", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    // Call install on the first agent
    const firstKey = Object.keys(result.agents)[0];
    const agent = result.agents[firstKey];
    await agent.install();
    expect(runner.runServer).toHaveBeenCalled();
  });
});

// ── offerGithubAuth with GITHUB_TOKEN ─────────────────────────────────

describe("offerGithubAuth with token", () => {
  it("uses GITHUB_TOKEN when explicitly requested", async () => {
    delete process.env.SPAWN_SKIP_GITHUB_AUTH;
    process.env.GITHUB_TOKEN = "ghp_test123";
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    // Must pass explicitly requested = true
    await offerGithubAuth(runner, true);
    expect(runner.runServer).toHaveBeenCalled();
    delete process.env.GITHUB_TOKEN;
  });
});

// ── startGateway ──────────────────────────────────────────────────────

// ── Agent install, configure, and envVars coverage ────────────────────

describe("createCloudAgents detailed", () => {
  it("claude agent configure calls runServer", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const claude = result.agents.claude;
    await claude.configure?.("sk-test-key", undefined, new Set());
    expect(runner.runServer).toHaveBeenCalled();
  });

  it("codex agent configure calls uploadFile", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const codex = result.agents.codex;
    await codex.configure?.("sk-test-key", undefined, new Set());
    expect(runner.uploadFile).toHaveBeenCalled();
  });

  it("openclaw agent envVars include OPENROUTER_API_KEY", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const envVars = result.agents.openclaw.envVars("sk-or-v1-test");
    expect(envVars.some((v: string) => v.includes("OPENROUTER_API_KEY"))).toBe(true);
    expect(envVars.some((v: string) => v.includes("ANTHROPIC_BASE_URL"))).toBe(true);
  });

  it("openclaw agent has tunnel config", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const openclaw = result.agents.openclaw;
    expect(openclaw.tunnel).toBeDefined();
    expect(openclaw.tunnel?.remotePort).toBe(18789);
    const url = openclaw.tunnel?.browserUrl(8080);
    expect(url).toContain("localhost:8080");
  });

  it("zeroclaw agent envVars include ZEROCLAW_PROVIDER", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const envVars = result.agents.zeroclaw.envVars("sk-or-v1-test");
    expect(envVars.some((v: string) => v.includes("ZEROCLAW_PROVIDER=openrouter"))).toBe(true);
  });

  it("zeroclaw agent configure calls runServer", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    await result.agents.zeroclaw.configure?.("sk-or-v1-test", undefined, new Set());
    expect(runner.runServer).toHaveBeenCalled();
  });

  it("hermes agent envVars include OPENAI_BASE_URL", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const envVars = result.agents.hermes.envVars("sk-or-v1-test");
    expect(envVars.some((v: string) => v.includes("OPENAI_BASE_URL"))).toBe(true);
    expect(envVars.some((v: string) => v.includes("HERMES_YOLO_MODE"))).toBe(true);
  });

  it("hermes agent configure removes YOLO mode when not enabled", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    // Pass empty set (yolo-mode not in enabled steps)
    await result.agents.hermes.configure?.("sk-test", undefined, new Set());
    const calls = runner.runServer.mock.calls;
    const allCmds = calls.map((c: unknown[]) => String(c[0])).join(" ");
    expect(allCmds).toContain("HERMES_YOLO_MODE");
  });

  it("hermes agent configure keeps YOLO mode when enabled", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    // Pass set with yolo-mode
    await result.agents.hermes.configure?.(
      "sk-test",
      undefined,
      new Set([
        "yolo-mode",
      ]),
    );
    // Should NOT call runServer to remove YOLO mode (no sed)
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("junie agent envVars include JUNIE_OPENROUTER_API_KEY", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const envVars = result.agents.junie.envVars("sk-or-v1-test");
    expect(envVars.some((v: string) => v.includes("JUNIE_OPENROUTER_API_KEY"))).toBe(true);
  });

  it("kilocode agent envVars include KILO_PROVIDER_TYPE", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const envVars = result.agents.kilocode.envVars("sk-or-v1-test");
    expect(envVars.some((v: string) => v.includes("KILO_PROVIDER_TYPE=openrouter"))).toBe(true);
  });

  it("opencode agent envVars include OPENROUTER_API_KEY", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const envVars = result.agents.opencode.envVars("sk-or-v1-test");
    expect(envVars.some((v: string) => v.includes("OPENROUTER_API_KEY"))).toBe(true);
  });

  it("all agents have launchCmd returning non-empty string", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    for (const agent of Object.values(result.agents)) {
      const cmd = agent.launchCmd();
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
    }
  });

  it("all agents have a cloudInitTier", () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    for (const agent of Object.values(result.agents)) {
      expect([
        "minimal",
        "node",
        "full",
      ]).toContain(agent.cloudInitTier);
    }
  });

  it("openclaw agent configure sets up config", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    await result.agents.openclaw.configure?.("sk-or-v1-test", "openrouter/auto", new Set());
    // Should have called uploadFile for the config
    expect(runner.uploadFile).toHaveBeenCalled();
  });

  it("openclaw agent preLaunch starts gateway", async () => {
    const runner = {
      runServer: mock(() => Promise.resolve()),
      uploadFile: mock(() => Promise.resolve()),
      downloadFile: mock(() => Promise.resolve()),
    };
    const result = createCloudAgents(runner);
    const openclaw = result.agents.openclaw;
    expect(openclaw.preLaunch).toBeDefined();
    await openclaw.preLaunch?.();
    expect(runner.runServer).toHaveBeenCalled();
  });
});

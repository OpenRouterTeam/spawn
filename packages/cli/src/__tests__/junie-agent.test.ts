/**
 * junie-agent.test.ts — Unit tests for the Junie CLI agent configuration.
 *
 * Verifies that:
 * - The junie agent is registered in createCloudAgents
 * - envVars returns JUNIE_OPENROUTER_API_KEY and OPENROUTER_API_KEY
 * - launchCmd includes 'junie'
 * - cloudInitTier is 'node' (npm-installed agent)
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// ── Suppress stderr output from logStep/logError during tests ────────────────

let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ── Import module under test ──────────────────────────────────────────────────
// agent-setup.ts doesn't import oauth, so no mock needed.

const { createCloudAgents } = await import("../shared/agent-setup");

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockRunner() {
  return {
    runServer: mock(() => Promise.resolve()),
    uploadFile: mock(() => Promise.resolve()),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Junie agent config", () => {
  it("is registered in createCloudAgents", () => {
    const { agents } = createCloudAgents(createMockRunner());
    expect(agents["junie"]).toBeDefined();
    expect(agents["junie"].name).toBe("Junie");
  });

  it("resolveAgent finds junie by name", () => {
    const { resolveAgent } = createCloudAgents(createMockRunner());
    const agent = resolveAgent("junie");
    expect(agent.name).toBe("Junie");
  });

  it("resolveAgent finds junie case-insensitively", () => {
    const { resolveAgent } = createCloudAgents(createMockRunner());
    const agent = resolveAgent("JUNIE");
    expect(agent.name).toBe("Junie");
  });

  it("envVars sets JUNIE_OPENROUTER_API_KEY", () => {
    const { agents } = createCloudAgents(createMockRunner());
    const vars = agents["junie"].envVars("sk-or-v1-test-key");
    const junieKey = vars.find((v) => v.startsWith("JUNIE_OPENROUTER_API_KEY="));
    expect(junieKey).toBe("JUNIE_OPENROUTER_API_KEY=sk-or-v1-test-key");
  });

  it("envVars sets OPENROUTER_API_KEY", () => {
    const { agents } = createCloudAgents(createMockRunner());
    const vars = agents["junie"].envVars("sk-or-v1-test-key");
    const orKey = vars.find((v) => v.startsWith("OPENROUTER_API_KEY="));
    expect(orKey).toBe("OPENROUTER_API_KEY=sk-or-v1-test-key");
  });

  it("launchCmd includes junie", () => {
    const { agents } = createCloudAgents(createMockRunner());
    const cmd = agents["junie"].launchCmd();
    expect(cmd).toContain("junie");
  });

  it("cloudInitTier is node", () => {
    const { agents } = createCloudAgents(createMockRunner());
    expect(agents["junie"].cloudInitTier).toBe("node");
  });
});

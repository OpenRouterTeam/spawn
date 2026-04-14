/**
 * hermes-dashboard.test.ts — Verifies that startHermesDashboard() produces a
 * deploy script that starts `hermes dashboard` as a session-scoped background
 * process bound to 127.0.0.1:9119, with a port-ready wait loop and graceful
 * handling of an already-running dashboard.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

// ── Mock @clack/prompts (must be before importing agent-setup) ──────────
mockClackPrompts();

// ── Import the function under test ──────────────────────────────────────
const { startHermesDashboard } = await import("../shared/agent-setup");

import type { CloudRunner } from "../shared/agent-setup";

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockRunner(): {
  runner: CloudRunner;
  capturedScript: () => string;
} {
  let script = "";
  const runner: CloudRunner = {
    runServer: mock(async (cmd: string) => {
      script = cmd;
    }),
    uploadFile: mock(async () => {}),
    downloadFile: mock(async () => {}),
  };
  return {
    runner,
    capturedScript: () => script,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("startHermesDashboard", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let capturedScript: string;

  beforeEach(async () => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const { runner, capturedScript: getScript } = createMockRunner();
    await startHermesDashboard(runner);
    capturedScript = getScript();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("launches `hermes dashboard` bound to 127.0.0.1:9119 with --no-open", () => {
    // Subcommand matches hermes_cli/main.py (cmd_dashboard).
    expect(capturedScript).toContain("dashboard --port 9119 --host 127.0.0.1 --no-open");
    // Should NOT try to open a browser on the remote VM.
    expect(capturedScript).toContain("--no-open");
  });

  it("checks all three port-probe fallbacks (ss, /dev/tcp, nc) for Debian/Ubuntu compatibility", () => {
    expect(capturedScript).toContain("ss -tln");
    expect(capturedScript).toContain("/dev/tcp/127.0.0.1/9119");
    expect(capturedScript).toContain("nc -z 127.0.0.1 9119");
  });

  it("uses setsid/nohup to detach the dashboard from the session's TTY", () => {
    expect(capturedScript).toContain("setsid");
    expect(capturedScript).toContain("nohup");
    // Output and stdin plumbed so the bg process survives SSH disconnect.
    expect(capturedScript).toContain("/tmp/hermes-dashboard.log");
    expect(capturedScript).toContain("< /dev/null");
  });

  it("no-ops if the dashboard is already running on :9119", () => {
    // Skip re-launch if portCheck already succeeds.
    expect(capturedScript).toContain("Hermes dashboard already running");
  });

  it("sources ~/.spawnrc and exports the hermes venv PATH before launching", () => {
    expect(capturedScript).toContain("source ~/.spawnrc");
    expect(capturedScript).toContain("$HOME/.hermes/hermes-agent/venv/bin");
    expect(capturedScript).toContain("$HOME/.local/bin");
  });

  it("waits for the port to come up with a bounded timeout", () => {
    expect(capturedScript).toContain("elapsed -lt 60");
    expect(capturedScript).toContain("Hermes dashboard ready");
  });

  it("is NOT a systemd service — dashboard is session-scoped, not persistent", () => {
    // Opposite of startGateway: we deliberately do not install a systemd unit.
    expect(capturedScript).not.toContain("systemctl daemon-reload");
    expect(capturedScript).not.toContain("systemctl enable");
    expect(capturedScript).not.toContain("/etc/systemd/system/");
    expect(capturedScript).not.toContain("crontab");
  });
});

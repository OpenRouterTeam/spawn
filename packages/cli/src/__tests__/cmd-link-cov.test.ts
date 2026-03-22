/**
 * cmd-link-cov.test.ts — Additional coverage for commands/link.ts
 *
 * Covers paths not exercised in cmd-link.test.ts:
 * - auto-detect cloud via IMDS
 * - SSH user validation failure
 * - confirm dialog rejection
 * - "which" binary detection fallback
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { asyncTryCatch } from "@openrouter/spawn-shared";
import { mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const CANCEL_SYMBOL = Symbol("cancel");
let confirmValue: unknown = true;
let selectValue: unknown = "claude";

const clack = mockClackPrompts({
  confirm: mock(async () => confirmValue),
  select: mock(async () => selectValue),
  isCancel: (val: unknown) => val === CANCEL_SYMBOL,
});

// ── Import module under test ────────────────────────────────────────────────
const { cmdLink } = await import("../commands/link.js");

// ── Helpers ────────────────────────────────────────────────────────────────

const TCP_REACHABLE = async () => true;
const TCP_UNREACHABLE = async () => false;
const SSH_NO_DETECT = () => null;

const SSH_DETECT_CLOUD_HETZNER = (_host: string, _user: string, _keys: string[], cmd: string) => {
  if (cmd.includes("curl")) {
    return "hetzner";
  }
  return null;
};

const SSH_DETECT_AGENT_VIA_WHICH = (_host: string, _user: string, _keys: string[], cmd: string) => {
  // ps aux returns nothing, but which finds the binary
  if (cmd.includes("ps aux")) {
    return null;
  }
  if (cmd.includes("which")) {
    return "/usr/local/bin/claude\nclaude";
  }
  return null;
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cmdLink (additional coverage)", () => {
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `spawn-link-cov-${Date.now()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;

    confirmValue = true;
    selectValue = "claude";

    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logInfo.mockReset();
    clack.logStep.mockReset();
    clack.spinnerStart.mockReset();
    clack.spinnerStop.mockReset();
    clack.outro.mockReset();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    process.env.SPAWN_HOME = savedSpawnHome;
    processExitSpy.mockRestore();
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    }
  });

  it("auto-detects cloud from IMDS metadata", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "1.2.3.4",
        "--agent",
        "claude",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_DETECT_CLOUD_HETZNER,
      },
    );

    const records = loadHistory();
    expect(records.length).toBe(1);
    expect(records[0].cloud).toBe("hetzner");
  });

  it("detects agent via which binary fallback", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "10.0.0.2",
        "--cloud",
        "hetzner",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_DETECT_AGENT_VIA_WHICH,
      },
    );

    const records = loadHistory();
    expect(records.length).toBe(1);
    expect(records[0].agent).toBe("claude");
  });

  it("exits with error for invalid SSH user", async () => {
    await asyncTryCatch(() =>
      cmdLink(
        [
          "link",
          "1.2.3.4",
          "--agent",
          "claude",
          "--cloud",
          "hetzner",
          "--user",
          "root; rm -rf /",
        ],
        {
          tcpCheck: TCP_REACHABLE,
          sshCommand: SSH_NO_DETECT,
        },
      ),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Invalid SSH user"));
  });

  it("saves record in non-interactive mode (skips confirm)", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "1.2.3.4",
        "--agent",
        "claude",
        "--cloud",
        "hetzner",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_NO_DETECT,
      },
    );

    // Non-interactive mode skips confirm and saves directly
    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Deployment linked"));
    const records = loadHistory();
    const thisRecord = records.find(
      (r: {
        connection?: {
          ip?: string;
        };
      }) => r.connection?.ip === "1.2.3.4",
    );
    expect(thisRecord).toBeDefined();
  });

  it("uses short flags for cloud and agent", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "5.6.7.8",
        "-a",
        "codex",
        "-c",
        "sprite",
        "-u",
        "ubuntu",
        "--name",
        "my-box",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_NO_DETECT,
      },
    );

    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Deployment linked"));
    const records = loadHistory();
    const rec = records.find((r: { name?: string }) => r.name === "my-box");
    expect(rec).toBeDefined();
    expect(rec?.agent).toBe("codex");
    expect(rec?.cloud).toBe("sprite");
    expect(rec?.connection?.user).toBe("ubuntu");
  });

  it("skips detection spinner when both agent and cloud are provided via flags", async () => {
    await cmdLink(
      [
        "link",
        "1.2.3.4",
        "--agent",
        "claude",
        "--cloud",
        "hetzner",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_NO_DETECT,
      },
    );

    // Detection spinner should not have been started with "Auto-detecting" message
    const spinnerCalls = clack.spinnerStart.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(spinnerCalls.some((msg: string) => msg.includes("Auto-detecting"))).toBe(false);
  });

  it("shows TCP unreachable error", async () => {
    await asyncTryCatch(() =>
      cmdLink(
        [
          "link",
          "192.168.99.99",
          "--agent",
          "claude",
          "--cloud",
          "hetzner",
          "--user",
          "root",
        ],
        {
          tcpCheck: TCP_UNREACHABLE,
          sshCommand: SSH_NO_DETECT,
        },
      ),
    );

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("not reachable"));
  });

  it("exits with error for invalid IP address", async () => {
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    await asyncTryCatch(() =>
      cmdLink(
        [
          "link",
          "not-an-ip!@#",
        ],
        {
          tcpCheck: TCP_REACHABLE,
          sshCommand: SSH_NO_DETECT,
        },
      ),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
  });

  it("runs detection spinner when cloud not provided", async () => {
    await cmdLink(
      [
        "link",
        "1.2.3.4",
        "--agent",
        "claude",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_DETECT_CLOUD_HETZNER,
      },
    );

    const spinnerCalls = clack.spinnerStart.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(spinnerCalls.some((msg: string) => msg.includes("Auto-detecting"))).toBe(true);
  });

  it("generates default name from agent and IP when no --name flag", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "10.0.0.1",
        "--agent",
        "claude",
        "--cloud",
        "hetzner",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_NO_DETECT,
      },
    );

    const records = loadHistory();
    const rec = records.find(
      (r: {
        connection?: {
          ip?: string;
        };
      }) => r.connection?.ip === "10.0.0.1",
    );
    expect(rec).toBeDefined();
    expect(rec?.name).toBe("claude-10-0-0-1");
  });
});

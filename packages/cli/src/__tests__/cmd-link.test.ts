/**
 * cmd-link.test.ts — Tests for the `spawn link` command.
 *
 * Uses DI (options.tcpCheck, options.sshCommand) to avoid real network calls.
 * Follows the same pattern as cmd-fix.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { asyncTryCatch } from "@openrouter/spawn-shared";
import { mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock (must be at module top level) ───────────────────────
const clack = mockClackPrompts();

// ── Import module under test ───────────────────────────────────────────────
const { cmdLink } = await import("../commands/link.js");

// ── Helpers ────────────────────────────────────────────────────────────────

const TCP_REACHABLE = async () => true;
const TCP_UNREACHABLE = async () => false;
const SSH_NO_DETECT = () => null;
const SSH_DETECT_CLAUDE = (_host: string, _user: string, _keys: string[], cmd: string) => {
  if (cmd.includes("ps aux")) {
    return "claude";
  }
  return null;
};

// ── Test Setup ─────────────────────────────────────────────────────────────

describe("cmdLink", () => {
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `spawn-link-test-${Date.now()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;

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

  it("exits with error when no IP address is provided", async () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    await asyncTryCatch(() =>
      cmdLink([
        "link",
      ]),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    consoleErrorSpy.mockRestore();
  });

  it("exits with error when the IP is unreachable", async () => {
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

  it("saves a spawn record when agent and cloud are provided via flags", async () => {
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

    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Deployment linked"));

    const records = loadHistory();
    expect(records.length).toBe(1);
    expect(records[0].agent).toBe("claude");
    expect(records[0].cloud).toBe("hetzner");
    expect(records[0].connection?.ip).toBe("1.2.3.4");
    expect(records[0].connection?.user).toBe("root");
  });

  it("auto-detects agent from running processes", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "10.0.0.1",
        "--cloud",
        "hetzner",
        "--user",
        "root",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_DETECT_CLAUDE,
      },
    );

    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Deployment linked"));

    const records = loadHistory();
    expect(records.length).toBe(1);
    expect(records[0].agent).toBe("claude");
  });

  it("generates a default name from agent and IP", async () => {
    const { loadHistory } = await import("../history.js");

    await cmdLink(
      [
        "link",
        "192.168.1.50",
        "--agent",
        "openclaw",
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
    expect(records.length).toBe(1);
    expect(records[0].name).toBe("openclaw-192-168-1-50");
  });

  it("uses --name flag when specified", async () => {
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
        "--name",
        "my-dev-box",
      ],
      {
        tcpCheck: TCP_REACHABLE,
        sshCommand: SSH_NO_DETECT,
      },
    );

    const records = loadHistory();
    expect(records.length).toBe(1);
    expect(records[0].name).toBe("my-dev-box");
  });

  it("exits with error in non-interactive mode when agent not detected", async () => {
    await asyncTryCatch(() =>
      cmdLink(
        [
          "link",
          "1.2.3.4",
          "--cloud",
          "hetzner",
          "--user",
          "root",
        ],
        {
          tcpCheck: TCP_REACHABLE,
          sshCommand: SSH_NO_DETECT,
        },
      ),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("auto-detect agent"));
  });

  it("exits with error in non-interactive mode when cloud not detected", async () => {
    await asyncTryCatch(() =>
      cmdLink(
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
          sshCommand: SSH_NO_DETECT,
        },
      ),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("auto-detect cloud"));
  });

  it("exits with error for an invalid IP address", async () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    await asyncTryCatch(() =>
      cmdLink(
        [
          "link",
          "not-an-ip",
          "--agent",
          "claude",
          "--cloud",
          "hetzner",
        ],
        {
          tcpCheck: TCP_REACHABLE,
          sshCommand: SSH_NO_DETECT,
        },
      ),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    consoleErrorSpy.mockRestore();
  });
});

// shared/ssh.ts — Shared SSH wait utility with TCP pre-check and stderr capture

import { logInfo, logStep, logError } from "./ui";
import { connect } from "node:net";
import { spawnSync as nodeSpawnSync } from "node:child_process";

// ─── Shared SSH Options ──────────────────────────────────────────────────────

/** Base SSH options shared across all clouds (array form for Bun.spawn). */
export const SSH_BASE_OPTS: string[] = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "GSSAPIAuthentication=no",
  "-o",
  "TCPKeepAlive=no",
  "-o",
  "BatchMode=yes",
];

/**
 * SSH options for interactive sessions (user-facing TTY).
 *
 * Differences from SSH_BASE_OPTS:
 * - No BatchMode (interactive sessions need TTY prompts to work)
 * - StrictHostKeyChecking=accept-new instead of =no (safer for reconnects)
 * - Compression=yes (reduces latency on slow/distant links)
 * - IPQoS=lowdelay (mark packets for low-latency QoS treatment)
 * - RequestTTY=yes (force TTY allocation for the session)
 * - EscapeChar=none (disable per-byte ~ escape scanning for faster keystroke echo)
 * - AddressFamily=inet (skip IPv6 resolution to avoid intermittent stalls)
 */
export const SSH_INTERACTIVE_OPTS: string[] = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "GSSAPIAuthentication=no",
  "-o",
  "TCPKeepAlive=no",
  "-o",
  "Compression=no",
  "-o",
  "IPQoS=lowdelay",
  "-o",
  "EscapeChar=none",
  "-o",
  "AddressFamily=inet",
  "-t",
];

// ─── Interactive Spawn ───────────────────────────────────────────────────────

/**
 * Spawn a child process for an interactive terminal session using spawnSync.
 *
 * Why spawnSync instead of Bun.spawn?
 * Bun's async event loop keeps polling fd 0 (stdin) even after
 * process.stdin.pause()/destroy(). With Bun.spawn + stdio:"inherit",
 * both the parent's event loop and the child (SSH) race for bytes on
 * the same fd, causing random keystroke drops.
 *
 * spawnSync blocks the event loop entirely, so the child process is the
 * sole reader of stdin. This matches the behavior of running SSH directly
 * from a shell.
 */
export function spawnInteractive(args: string[], env?: Record<string, string | undefined>): number {
  // Use Node's spawnSync (not Bun.spawnSync) — it's more battle-tested
  // with interactive TTY programs and properly handles SIGWINCH, job
  // control, and terminal I/O forwarding.
  const result = nodeSpawnSync(args[0], args.slice(1), {
    stdio: "inherit",
    env: env ?? process.env,
  });
  return result.status ?? 1;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Async sleep — shared across all cloud providers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill a child process with SIGTERM, then escalate to SIGKILL after a grace period.
 *
 * SSH processes stuck in network I/O can ignore SIGTERM indefinitely,
 * causing `await proc.exited` to hang forever. This helper ensures the
 * process is forcefully killed if it doesn't respond to SIGTERM.
 */
export function killWithTimeout(
  proc: {
    kill(signal?: number): void;
    readonly killed: boolean;
  },
  gracePeriodMs = 5000,
): void {
  try {
    proc.kill();
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!proc.killed) {
        proc.kill(9);
      }
    } catch {
      /* already dead */
    }
  }, gracePeriodMs);
}

// ─── TCP Pre-Check ───────────────────────────────────────────────────────────

/**
 * Probe whether a TCP port is open using node:net.
 * Returns true if the connection succeeds within `timeoutMs`, false otherwise.
 * This is much cheaper than a full SSH handshake attempt.
 */
export function tcpCheck(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({
      host,
      port,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

// ─── SSH Wait ────────────────────────────────────────────────────────────────

export interface WaitForSshOpts {
  host: string;
  user: string;
  /** Maximum total attempts across both phases. Default: 36 (~3 min). */
  maxAttempts?: number;
  /** Path to SSH identity file (e.g. ~/.ssh/id_ed25519). */
  sshKeyPath?: string;
  /** Extra SSH options appended after SSH_BASE_OPTS. */
  extraSshOpts?: string[];
}

/**
 * Two-phase SSH wait with resilience improvements:
 *
 * **Phase 1 (TCP probe):** Loop with cheap TCP probes until port 22 is open.
 *   Uses 2s intervals. Avoids the 10s ConnectTimeout overhead when sshd isn't
 *   even listening yet (VM still booting).
 *
 * **Phase 2 (SSH handshake):** Once port 22 is open, attempt full SSH `echo ok`.
 *   Uses 3s intervals. Captures stderr so the user sees the actual error reason.
 *
 * Total budget: ~`maxAttempts` attempts spread across both phases.
 * Effective timeout: ~3 min with defaults.
 */
export async function waitForSsh(opts: WaitForSshOpts): Promise<void> {
  const { host, user, sshKeyPath, extraSshOpts } = opts;
  const maxAttempts = opts.maxAttempts ?? 36;

  // Build SSH args
  const sshArgs: string[] = [
    ...SSH_BASE_OPTS,
  ];
  if (sshKeyPath) {
    sshArgs.push("-i", sshKeyPath);
  }
  if (extraSshOpts) {
    sshArgs.push(...extraSshOpts);
  }

  // ── Phase 1: TCP probe ────────────────────────────────────────────────────
  logStep("Waiting for SSH port to open...");
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const open = await tcpCheck(host, 22, 2000);
    if (open) {
      logInfo("SSH port 22 is open");
      break;
    }
    logStep(`SSH port closed (${attempt}/${maxAttempts})`);
    await sleep(2000);
  }

  if (attempt >= maxAttempts) {
    logError(`SSH port 22 never opened after ${maxAttempts} attempts`);
    throw new Error("SSH connectivity timeout — port 22 never opened");
  }

  // ── Phase 2: SSH handshake ────────────────────────────────────────────────
  logStep("Waiting for SSH handshake...");
  const remaining = maxAttempts - attempt;
  // At least 5 handshake attempts even if TCP phase used most of the budget
  const handshakeAttempts = Math.max(remaining, 5);

  for (let i = 1; i <= handshakeAttempts; i++) {
    try {
      const proc = Bun.spawn(
        [
          "ssh",
          ...sshArgs,
          `${user}@${host}`,
          "echo ok",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      if (exitCode === 0 && stdout.includes("ok")) {
        logInfo("SSH is ready");
        return;
      }

      // Show the actual SSH error reason dimly so users can debug
      const reason = stderr.trim();
      if (reason) {
        logStep(`SSH handshake failed (${i}/${handshakeAttempts}): ${reason}`);
      } else {
        logStep(`SSH handshake failed (${i}/${handshakeAttempts})`);
      }
    } catch {
      logStep(`SSH handshake error (${i}/${handshakeAttempts})`);
    }
    await sleep(3000);
  }

  logError(`SSH handshake failed after ${handshakeAttempts} attempts`);
  throw new Error("SSH connectivity timeout — handshake never succeeded");
}

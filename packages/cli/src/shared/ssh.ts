// shared/ssh.ts — Shared SSH wait utility with TCP pre-check and stderr capture

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { connect } from "node:net";
import { normalize } from "node:path/posix";
import { asyncTryCatch, tryCatch } from "./result.js";
import { promptForSshKey, setPreferredSshKeyPath } from "./ssh-keys.js";
import { logError, logInfo, logStep, logStepDone, logStepInline, logWarn } from "./ui.js";

// ─── Shared SSH Options ──────────────────────────────────────────────────────

/** Base SSH options shared across all clouds (array form for Bun.spawn).
 *
 * IdentitiesOnly=yes forces ssh to use only the keys passed via -i and ignore
 * agent-loaded identities. Without it, a user with several keys in ssh-agent
 * can hit the server's MaxAuthTries (default 6) before our -i key is offered,
 * producing a misleading "Permission denied (publickey)". */
export const SSH_BASE_OPTS: string[] = [
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
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
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
  "-o",
  "IdentitiesOnly=yes",
  "-t",
];

// ─── Remote Path Validation ─────────────────────────────────────────────────

/**
 * Validate a remote file path for use with scp/ssh file operations.
 *
 * Rejects path traversal (.. segments), argument injection (leading dashes),
 * and characters outside a safe allowlist. The `..` check is performed on the
 * RAW input before normalize() so that crafted paths like `/tmp/../../etc/passwd`
 * (which normalize to `/etc/passwd`) are still caught.
 *
 * @param remotePath - The raw remote path to validate
 * @param allowedCharsPattern - Optional regex for allowed characters
 *   (default: alphanumerics, `/`, `.`, `_`, `~`, `$`, `{`, `}`, `:`, `-`)
 * @returns The normalized path if valid
 * @throws Error if the path is unsafe
 */
export function validateRemotePath(remotePath: string, allowedCharsPattern: RegExp = /^[\w/.~${}:-]+$/): string {
  // 1. Check for ".." traversal in the RAW input BEFORE normalize() strips it
  if (remotePath.includes("..")) {
    throw new Error(`Invalid remote path: path traversal detected ("..") in: ${remotePath}`);
  }
  // 2. Reject empty paths
  if (!remotePath) {
    throw new Error("Invalid remote path: path must not be empty");
  }
  // 3. Normalize (resolve . segments, collapse slashes)
  const normalized = normalize(remotePath);
  // 4. Double-check normalized result for ".." (defense in depth)
  if (normalized.includes("..")) {
    throw new Error(`Invalid remote path: path traversal detected ("..") in normalized: ${normalized}`);
  }
  // 5. Character allowlist
  if (!allowedCharsPattern.test(normalized)) {
    throw new Error(`Invalid remote path: contains unsafe characters: ${remotePath}`);
  }
  // 6. Reject argument injection (segments starting with -)
  if (normalized.split("/").some((s) => s.startsWith("-"))) {
    throw new Error(`Invalid remote path: segments must not start with "-": ${remotePath}`);
  }
  return normalized;
}

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

  // Reset terminal state after the interactive session ends.
  // The remote agent's TUI (e.g. Claude Code) may leave the terminal in
  // raw mode or with altered attributes, causing garbled post-session output.
  if (process.stderr.isTTY) {
    process.stderr.write("\x1b[0m\x1b[?25h"); // reset attributes + show cursor
  }
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[0m\x1b[?25h");
  }
  // Restore sane terminal settings (cooked mode, echo, etc.)
  tryCatch(() =>
    nodeSpawnSync(
      "stty",
      [
        "sane",
      ],
      {
        stdio: "inherit",
      },
    ),
  );

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
  },
  gracePeriodMs = 5000,
): void {
  const r = tryCatch(() => proc.kill());
  if (!r.ok) {
    return;
  }
  const sigkillTimer = setTimeout(() => {
    tryCatch(() => proc.kill(9));
  }, gracePeriodMs);
  // Don't let this timer keep the event loop alive — the process may already
  // be dead from SIGTERM, so there's no reason to block exit for 5 seconds.
  sigkillTimer.unref();
}

// ─── TCP Pre-Check ───────────────────────────────────────────────────────────

/**
 * Probe whether a TCP port is open using node:net.
 * Returns true if the connection succeeds within `timeoutMs`, false otherwise.
 * This is much cheaper than a full SSH handshake attempt.
 */
function tcpCheck(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
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

// ─── SSH Tunnel ──────────────────────────────────────────────────────────

export interface SshTunnelHandle {
  localPort: number;
  stop: () => void;
  exited: Promise<number>;
}

/**
 * Start an SSH tunnel forwarding a remote port to localhost.
 * Tries local ports starting from `remotePort` up to `remotePort + 10`.
 * Throws if no port is available or the SSH connection fails immediately.
 */
export async function startSshTunnel(opts: {
  host: string;
  user: string;
  remotePort: number;
  localPort?: number;
  sshKeyOpts?: string[];
}): Promise<SshTunnelHandle> {
  const { host, user, remotePort, sshKeyOpts } = opts;

  // Find available local port
  let localPort = opts.localPort ?? remotePort;
  let found = false;
  for (let p = localPort; p <= localPort + 10; p++) {
    const inUse = await tcpCheck("127.0.0.1", p, 500);
    if (!inUse) {
      localPort = p;
      found = true;
      break;
    }
  }
  if (!found) {
    throw new Error(`No available local port in range ${remotePort}-${remotePort + 10}`);
  }

  const args = [
    "ssh",
    ...SSH_BASE_OPTS,
    ...(sshKeyOpts ?? []),
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
  ];

  const proc = Bun.spawn(args, {
    stdio: [
      "ignore",
      "ignore",
      "pipe",
    ],
  });

  // Wait briefly to detect immediate failures (bad auth, connection refused)
  await sleep(1500);

  if (proc.exitCode !== null) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`SSH tunnel failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`);
  }

  return {
    localPort,
    stop: () => killWithTimeout(proc),
    exited: proc.exited,
  };
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
/**
 * Pattern that matches the OpenSSH "Permission denied (publickey...)" error.
 * SSH prints this to stderr when the server rejects every public key the
 * client offered. We use it to decide whether to prompt the user for a
 * different key (vs. silently retrying through transient errors like TCP
 * resets during boot).
 *
 * Matches: "Permission denied (publickey)", "Permission denied (publickey,gssapi-keyex,...)"
 */
const PUBKEY_AUTH_FAILURE_RE = /Permission denied \(publickey/i;

/** Number of consecutive publickey-auth failures before we offer the picker. */
const AUTH_FAILURE_THRESHOLD = 2;

/**
 * Extract the current "-i <path>" identity files from a built SSH arg list.
 * Used so the picker can show which keys we already tried.
 */
function extractKeyPathsFromArgs(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-i") {
      paths.push(args[i + 1]);
    }
  }
  return paths;
}

/**
 * Replace every "-i <path>" pair in `args` with a single "-i <newPath>" pair.
 * Returns a new array; does not mutate the input.
 */
function replaceKeyPathInArgs(args: string[], newPath: string): string[] {
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-i" && i + 1 < args.length) {
      if (!replaced) {
        out.push("-i", newPath);
        replaced = true;
      }
      i++; // skip the path that followed -i
      continue;
    }
    out.push(args[i]);
  }
  if (!replaced) {
    out.push("-i", newPath);
  }
  return out;
}

/**
 * Run a single `ssh user@host echo ok` handshake attempt.
 * Returns either a success marker or the failure reason captured from stderr.
 */
async function attemptSshHandshake(
  sshArgs: string[],
  user: string,
  host: string,
): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
      threw: boolean;
    }
> {
  const result = await asyncTryCatch(async () => {
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
    // Per-process timeout: ConnectTimeout=10 only covers TCP connect, not
    // the full SSH handshake. If sshd accepts the connection but stalls
    // during key exchange or auth, the process hangs indefinitely. Kill it
    // after 30s so the retry loop can continue.
    const timer = setTimeout(() => killWithTimeout(proc), 30_000);
    const inner = await asyncTryCatch(async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return {
        stdout,
        stderr,
        exitCode,
      };
    });
    clearTimeout(timer);
    if (!inner.ok) {
      throw inner.error;
    }
    return inner.data;
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: "",
      threw: true,
    };
  }
  if (result.data.exitCode === 0 && result.data.stdout.includes("ok")) {
    return {
      ok: true,
    };
  }
  return {
    ok: false,
    reason: result.data.stderr.trim(),
    threw: false,
  };
}

export async function waitForSsh(opts: WaitForSshOpts): Promise<void> {
  const { host, user, sshKeyPath, extraSshOpts } = opts;
  const maxAttempts = opts.maxAttempts ?? 36;

  // Build SSH args
  let sshArgs: string[] = [
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
  let tcpOpen = false;
  while (attempt < maxAttempts) {
    attempt += 1;
    const open = await tcpCheck(host, 22, 2000);
    if (open) {
      tcpOpen = true;
      logStepDone();
      logInfo("SSH port 22 is open");
      break;
    }
    if (attempt % 5 === 0 || attempt === 1) {
      logStepInline(`Waiting for SSH port... (${attempt}/${maxAttempts} attempts)`);
    }
    await sleep(2000);
  }

  if (!tcpOpen) {
    logStepDone();
    logError(`SSH port 22 never opened after ${maxAttempts} attempts`);
    throw new Error("SSH connectivity timeout — port 22 never opened");
  }

  // ── Phase 2: SSH handshake ────────────────────────────────────────────────
  logStep("Waiting for SSH handshake...");
  const remaining = maxAttempts - attempt;
  // At least 5 handshake attempts even if TCP phase used most of the budget
  const handshakeAttempts = Math.max(remaining, 5);

  // Track consecutive publickey rejections so we can offer the picker without
  // pestering the user during transient connection-refused/timeout failures
  // that have nothing to do with key selection.
  let consecutiveAuthFailures = 0;
  let totalAuthFailures = 0;
  let pickerOffered = false;
  // Path of any user-picked key (mid-loop or final fallback). Persisted as a
  // saved preference once it leads to a successful handshake.
  let userPickedKey: string | null = null;

  /**
   * Persist the chosen key as a saved preference, but only if the user
   * actually picked one. Best-effort — failures are surfaced as warnings
   * inside `setPreferredSshKeyPath` itself.
   */
  function persistChosenKey(): void {
    if (userPickedKey) {
      setPreferredSshKeyPath(userPickedKey);
      logInfo(`Saved SSH key preference for future spawn runs: ${userPickedKey}`);
    }
  }

  for (let i = 1; i <= handshakeAttempts; i++) {
    const result = await attemptSshHandshake(sshArgs, user, host);
    if (result.ok) {
      logInfo("SSH is ready");
      persistChosenKey();
      return;
    }

    // Surface the actual SSH error reason so users can debug.
    if (result.threw) {
      logStep(`SSH handshake error (${i}/${handshakeAttempts})`);
    } else if (result.reason) {
      logStep(`SSH handshake failed (${i}/${handshakeAttempts}): ${result.reason}`);
    } else {
      logStep(`SSH handshake failed (${i}/${handshakeAttempts})`);
    }

    // Track auth failures for picker eligibility
    if (!result.threw && result.reason && PUBKEY_AUTH_FAILURE_RE.test(result.reason)) {
      consecutiveAuthFailures++;
      totalAuthFailures++;
    } else {
      consecutiveAuthFailures = 0;
    }

    // Offer the mid-loop picker once per call after enough consecutive
    // auth failures. Skip if non-interactive, the user already saw it, or
    // we've used most of our budget (no point swapping keys with one
    // attempt left — the final fallback will catch that case).
    const attemptsLeft = handshakeAttempts - i;
    if (
      !pickerOffered &&
      consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD &&
      attemptsLeft >= 1 &&
      process.env.SPAWN_NON_INTERACTIVE !== "1"
    ) {
      pickerOffered = true;
      const triedKeys = extractKeyPathsFromArgs(sshArgs);
      logWarn("SSH keeps rejecting the offered keys (Permission denied).");
      const chosen = await promptForSshKey(triedKeys);
      if (chosen) {
        logInfo(`Switching to SSH key: ${chosen}`);
        sshArgs = replaceKeyPathInArgs(sshArgs, chosen);
        userPickedKey = chosen;
        consecutiveAuthFailures = 0;
      }
    }

    await sleep(3000);
  }

  // ── Final fallback ────────────────────────────────────────────────────────
  // If the entire retry budget is exhausted AND every failure we saw was
  // public-key auth (or the user dismissed the mid-loop picker), give them
  // ONE more chance to point spawn at the right key. This catches the case
  // where the user's whole `~/.ssh` set of guesses doesn't match the key
  // the cloud provider actually has registered.
  if (totalAuthFailures > 0 && process.env.SPAWN_NON_INTERACTIVE !== "1") {
    logWarn(`SSH handshake failed after ${handshakeAttempts} attempts — every offered key was rejected.`);
    const triedKeys = extractKeyPathsFromArgs(sshArgs);
    const chosen = await promptForSshKey(triedKeys);
    if (chosen) {
      sshArgs = replaceKeyPathInArgs(sshArgs, chosen);
      userPickedKey = chosen;
      logInfo(`Trying one more handshake with: ${chosen}`);
      const finalResult = await attemptSshHandshake(sshArgs, user, host);
      if (finalResult.ok) {
        logInfo("SSH is ready");
        persistChosenKey();
        return;
      }
      if (finalResult.reason) {
        logError(`SSH handshake failed with picked key: ${finalResult.reason}`);
      }
    }
  }

  logError(`SSH handshake failed after ${handshakeAttempts} attempts`);
  throw new Error("SSH connectivity timeout — handshake never succeeded");
}

/**
 * Wait for SSH availability on a snapshot-booted VM (no cloud-init needed).
 * Used by cloud modules that support snapshot-based provisioning (Hetzner, DigitalOcean).
 */
export async function waitForSshSnapshotBoot(ip: string, extraSshOpts: string[]): Promise<void> {
  await waitForSsh({
    host: ip,
    user: "root",
    maxAttempts: 36,
    extraSshOpts,
  });
  logInfo("SSH available (snapshot boot — skipping cloud-init)");
}

// commands/link.ts — spawn link: reconnect an existing cloud deployment to spawn
//
// Lets users re-register a running remote VM by IP address, so that
// spawn list/delete/fix all work seamlessly on the re-connected server.

import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { generateSpawnId, saveSpawnRecord } from "../history.js";
import { agentKeys, cloudKeys, loadManifest } from "../manifest.js";
import { validateConnectionIP, validateUsername } from "../security.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS, spawnInteractive } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { getErrorMessage, handleCancel, isInteractiveTTY } from "./shared.js";

// ─── TCP check ───────────────────────────────────────────────────────────────

function defaultTcpCheck(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
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

// ─── Remote detection ────────────────────────────────────────────────────────

/** Run a command via SSH and return trimmed stdout, or null on failure. */
function defaultSshCommand(host: string, user: string, keyOpts: string[], cmd: string): string | null {
  const result = spawnSync(
    "ssh",
    [
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `${user}@${host}`,
      cmd,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout?.trim() || null;
}

const KNOWN_AGENTS = [
  "claude",
  "openclaw",
  "codex",
  "opencode",
  "kilocode",
  "hermes",
  "junie",
  "pi",
  "cursor",
] as const;
type KnownAgent = (typeof KNOWN_AGENTS)[number];

/** Map manifest agent key → CLI binary name (only where they differ). */
const AGENT_BINARY: Partial<Record<KnownAgent, string>> = {
  cursor: "agent",
};

/** Get the CLI binary name for an agent (defaults to the agent key itself). */
function agentBinary(agent: KnownAgent): string {
  return AGENT_BINARY[agent] ?? agent;
}

/** Auto-detect which agent is installed/running on the remote host. */
function detectAgent(host: string, user: string, keyOpts: string[], runCmd: SshCommandFn): string | null {
  // First: check running processes
  // Note: cursor's binary is "agent" which is too generic for ps grep, so it's
  // detected only via the installed-binary check below.
  const psCmd =
    "ps aux 2>/dev/null | grep -oE 'claude(-code)?|openclaw|codex|opencode|kilocode|hermes|junie|pi' | grep -v grep | head -1 || true";
  const psOut = runCmd(host, user, keyOpts, psCmd);
  if (psOut) {
    const match = KNOWN_AGENTS.find((b: KnownAgent) => psOut.includes(b));
    if (match) {
      return match;
    }
  }

  // Second: check installed binaries — one SSH call per agent to avoid shell injection
  for (const agent of KNOWN_AGENTS) {
    const whichOut = runCmd(host, user, keyOpts, `command -v ${agentBinary(agent)}`);
    if (whichOut) {
      return agent;
    }
  }

  return null;
}

/** Auto-detect which cloud provider is hosting the remote server. */
function detectCloud(host: string, user: string, keyOpts: string[], runCmd: SshCommandFn): string | null {
  // Check IMDS metadata endpoints — each cloud provider exposes its own
  const detectCmd = [
    "if curl -sf --max-time 1 http://169.254.169.254/hetzner/v1/metadata/instance-id >/dev/null 2>&1; then echo hetzner",
    "elif curl -sf --max-time 1 http://169.254.169.254/latest/meta-data/instance-id >/dev/null 2>&1; then echo aws",
    "elif curl -sf --max-time 1 http://169.254.169.254/metadata/v1/id >/dev/null 2>&1; then echo digitalocean",
    "elif curl -sf --max-time 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/id >/dev/null 2>&1; then echo gcp",
    "fi",
  ].join("; ");

  return runCmd(host, user, keyOpts, detectCmd);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Parse and validate a positional IP address from args, returning null if absent. */
function parseIpArg(args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional[0] ?? null;
}

/** Extract --flag value pairs from args, returning [value, remainingArgs]. */
function extractFlag(
  args: string[],
  flags: string[],
): [
  string | undefined,
  string[],
] {
  const idx = args.findIndex((a) => flags.includes(a));
  if (idx === -1) {
    return [
      undefined,
      args,
    ];
  }
  const val = args[idx + 1];
  if (!val || val.startsWith("-")) {
    return [
      undefined,
      args,
    ];
  }
  const rest = [
    ...args,
  ];
  rest.splice(idx, 2);
  return [
    val,
    rest,
  ];
}

// ─── Dependency injection types ───────────────────────────────────────────────

export type TcpCheckFn = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
export type SshCommandFn = (host: string, user: string, keyOpts: string[], cmd: string) => string | null;

export interface LinkOptions {
  /** Override TCP reachability check (injectable for tests). */
  tcpCheck?: TcpCheckFn;
  /** Override SSH command runner (injectable for tests). */
  sshCommand?: SshCommandFn;
}

// ─── Main command ─────────────────────────────────────────────────────────────

/**
 * spawn link <ip> [--agent <agent>] [--cloud <cloud>] [--user <user>] [--name <name>]
 *
 * Re-registers an existing cloud deployment in spawn's local state so that
 * spawn list, spawn delete, spawn fix, etc. all work on it.
 */
export async function cmdLink(args: string[], options?: LinkOptions): Promise<void> {
  const tcpCheckFn = options?.tcpCheck ?? defaultTcpCheck;
  const sshCommandFn = options?.sshCommand ?? defaultSshCommand;

  // ── Parse flags ────────────────────────────────────────────────────────────
  let remaining = [
    ...args.slice(1),
  ]; // remove "link" command itself
  const [cloudFlag, r1] = extractFlag(remaining, [
    "--cloud",
    "-c",
  ]);
  remaining = r1;
  const [agentFlag, r2] = extractFlag(remaining, [
    "--agent",
    "-a",
  ]);
  remaining = r2;
  const [userFlag, r3] = extractFlag(remaining, [
    "--user",
    "-u",
  ]);
  remaining = r3;
  const [nameFlag, r4] = extractFlag(remaining, [
    "--name",
  ]);
  remaining = r4;

  // ── Get IP from positional arg ─────────────────────────────────────────────
  const ip = parseIpArg(remaining);

  if (!ip) {
    console.error(pc.red("Error: spawn link requires an IP address"));
    console.error(`\nUsage: ${pc.cyan("spawn link <ip>")}`);
    console.error(`       ${pc.cyan("spawn link 152.32.1.1 --agent claude --cloud hetzner")}`);
    process.exit(1);
  }

  // ── Validate IP ────────────────────────────────────────────────────────────
  const ipValidation = tryCatch(() => validateConnectionIP(ip));
  if (!ipValidation.ok) {
    console.error(pc.red(`Invalid IP address: ${pc.bold(ip)}`));
    console.error(`\n${getErrorMessage(ipValidation.error)}`);
    process.exit(1);
  }

  p.intro(`${pc.bold("spawn link")} — reconnect an existing deployment`);

  // ── Determine SSH user ─────────────────────────────────────────────────────
  let sshUser = userFlag ?? "root";

  if (!userFlag && isInteractiveTTY()) {
    const userInput = await p.text({
      message: `SSH user for ${pc.cyan(ip)}`,
      placeholder: "root",
      defaultValue: "root",
    });
    if (p.isCancel(userInput)) {
      handleCancel();
    }
    sshUser = userInput || "root";
  }

  // Validate SSH user
  const userValidation = tryCatch(() => validateUsername(sshUser));
  if (!userValidation.ok) {
    p.log.error(`Invalid SSH user: ${sshUser}`);
    p.log.info("Username must be lowercase letters, digits, underscores, or hyphens (e.g. root, ubuntu, ec2-user)");
    process.exit(1);
  }

  // ── Check connectivity ─────────────────────────────────────────────────────
  const connectSpinner = p.spinner({
    output: process.stderr,
  });
  connectSpinner.start(`Checking connectivity to ${pc.cyan(ip)}...`);

  const reachable = await tcpCheckFn(ip, 22, 10000);
  if (!reachable) {
    connectSpinner.stop(`Cannot reach ${ip} on port 22`);
    p.log.error(`SSH port 22 is not reachable at ${pc.bold(ip)}.`);
    p.log.info("Make sure the server is running and port 22 is open.");
    p.log.info(`Try manually: ${pc.cyan(`ssh root@${ip}`)}`);
    process.exit(1);
  }

  connectSpinner.stop(`${ip} is reachable`);

  // ── Get SSH keys ───────────────────────────────────────────────────────────
  const keysResult = await asyncTryCatch(() => ensureSshKeys());
  const keyOpts = keysResult.ok ? getSshKeyOpts(keysResult.data) : [];

  // ── Auto-detect agent and cloud ────────────────────────────────────────────
  let detectedAgent: string | null = agentFlag ?? null;
  let detectedCloud: string | null = cloudFlag ?? null;

  const needsDetection = !detectedAgent || !detectedCloud;

  if (needsDetection) {
    const detectSpinner = p.spinner({
      output: process.stderr,
    });
    detectSpinner.start("Auto-detecting agent and cloud provider...");

    if (!detectedAgent) {
      detectedAgent = detectAgent(ip, sshUser, keyOpts, sshCommandFn);
    }
    if (!detectedCloud) {
      detectedCloud = detectCloud(ip, sshUser, keyOpts, sshCommandFn);
    }

    const agentStatus = detectedAgent ?? "unknown";
    const cloudStatus = detectedCloud ?? "unknown";
    detectSpinner.stop(`Detected: agent=${agentStatus}, cloud=${cloudStatus}`);
  }

  // ── Load manifest for validation and picker ────────────────────────────────
  const manifestResult = await asyncTryCatch(() => loadManifest());
  const manifest = manifestResult.ok ? manifestResult.data : null;

  // ── Prompt for agent if not detected ──────────────────────────────────────
  if (!detectedAgent) {
    if (!isInteractiveTTY()) {
      p.log.error("Could not auto-detect agent. Use --agent <agent> to specify it.");
      p.log.info(`Example: ${pc.cyan(`spawn link ${ip} --agent claude`)}`);
      if (manifest) {
        const agents = agentKeys(manifest);
        p.log.info(`Available agents: ${agents.join(", ")}`);
      }
      process.exit(1);
    }

    const agentPickOptions =
      manifest && Object.keys(manifest.agents).length > 0
        ? agentKeys(manifest).map((key) => ({
            value: key,
            label: manifest.agents[key]?.name ?? key,
            hint: key,
          }))
        : [
            {
              value: "claude",
              label: "Claude Code",
              hint: "claude",
            },
          ];

    const agentPick = await p.select({
      message: "Which agent is running on this server?",
      options: agentPickOptions,
    });

    if (p.isCancel(agentPick)) {
      handleCancel();
    }

    detectedAgent = agentPick;
  }

  // ── Prompt for cloud if not detected ──────────────────────────────────────
  if (!detectedCloud) {
    if (!isInteractiveTTY()) {
      p.log.error("Could not auto-detect cloud provider. Use --cloud <cloud> to specify it.");
      p.log.info(`Example: ${pc.cyan(`spawn link ${ip} --cloud hetzner`)}`);
      if (manifest) {
        const clouds = cloudKeys(manifest).filter((c) => c !== "local");
        p.log.info(`Available clouds: ${clouds.join(", ")}`);
      }
      process.exit(1);
    }

    const cloudPickOptions =
      manifest && Object.keys(manifest.clouds).length > 0
        ? cloudKeys(manifest)
            .filter((key) => key !== "local")
            .map((key) => ({
              value: key,
              label: manifest.clouds[key]?.name ?? key,
              hint: key,
            }))
        : [];
    cloudPickOptions.push({
      value: "other",
      label: "Other / Unknown",
      hint: "other",
    });

    const cloudPick = await p.select({
      message: "Which cloud provider is this server on?",
      options: cloudPickOptions,
    });

    if (p.isCancel(cloudPick)) {
      handleCancel();
    }

    detectedCloud = cloudPick;
  }

  // ── Confirm details ────────────────────────────────────────────────────────
  const safeIpSegment = ip.replace(/\./g, "-");
  const spawnName = nameFlag ?? `${detectedAgent}-${safeIpSegment}`;

  if (isInteractiveTTY()) {
    const agentLabel = manifest?.agents[detectedAgent]?.name ?? detectedAgent;
    const cloudLabel = manifest?.clouds[detectedCloud]?.name ?? detectedCloud;

    p.log.info(`  IP:    ${ip}`);
    p.log.info(`  User:  ${sshUser}`);
    p.log.info(`  Agent: ${agentLabel}`);
    p.log.info(`  Cloud: ${cloudLabel}`);
    p.log.info(`  Name:  ${spawnName}`);

    const confirmed = await p.confirm({
      message: "Register this deployment?",
      initialValue: true,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.outro("Aborted.");
      return;
    }
  }

  // ── Save to history ────────────────────────────────────────────────────────
  const record = {
    id: generateSpawnId(),
    agent: detectedAgent,
    cloud: detectedCloud,
    timestamp: new Date().toISOString(),
    name: spawnName,
    connection: {
      ip,
      user: sshUser,
      cloud: detectedCloud,
    },
  };

  const saveResult = tryCatch(() => saveSpawnRecord(record));
  if (!saveResult.ok) {
    p.log.error(`Failed to save deployment: ${getErrorMessage(saveResult.error)}`);
    process.exit(1);
  }

  p.log.success(`Deployment linked! Run ${pc.cyan("spawn list")} to see it.`);

  // ── Offer to connect immediately ───────────────────────────────────────────
  if (isInteractiveTTY()) {
    const connectNow = await p.confirm({
      message: "Connect now?",
      initialValue: true,
    });

    if (!p.isCancel(connectNow) && connectNow) {
      p.log.step(`Connecting to ${ip}...`);
      const sshArgs = [
        "ssh",
        ...SSH_INTERACTIVE_OPTS,
        ...keyOpts,
        `${sshUser}@${ip}`,
      ];
      const exitCode = spawnInteractive(sshArgs);
      if (exitCode !== 0) {
        p.log.warn(`SSH exited with code ${exitCode}. The server is still linked.`);
        p.log.info(`Try manually: ${pc.cyan(`ssh ${sshUser}@${ip}`)}`);
      }
    }
  }

  p.outro(`Linked as ${spawnName}. Run ${pc.cyan("spawn list")} to manage it.`);
}

import type { VMConnection } from "../history.js";
import type { Manifest } from "../manifest.js";
import type { SshTunnelHandle } from "../shared/ssh.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  validateConnectionIP,
  validateLaunchCmd,
  validatePreLaunchCmd,
  validateServerIdentifier,
  validateUsername,
} from "../security.js";
import { getHistoryPath } from "../shared/paths.js";
import { asyncTryCatchIf, isOperationalError, tryCatch } from "../shared/result.js";
import { SSH_INTERACTIVE_OPTS, spawnInteractive, startSshTunnel } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { logWarn, openBrowser, shellQuote } from "../shared/ui.js";
import { getErrorMessage } from "./shared.js";

/** Execute a shell command and resolve/reject on process close/error */
async function runInteractiveCommand(
  cmd: string,
  args: string[],
  failureMsg: string,
  manualCmd: string,
): Promise<void> {
  const r = tryCatch(() =>
    spawnInteractive([
      cmd,
      ...args,
    ]),
  );
  if (!r.ok) {
    p.log.error(`Failed to connect: ${getErrorMessage(r.error)}`);
    p.log.info(`Try manually: ${pc.cyan(manualCmd)}`);
    throw r.error;
  }
  const code = r.data;
  if (code !== 0) {
    throw new Error(`${failureMsg} with exit code ${code}`);
  }
}

/** Connect to an existing VM via SSH */
export async function cmdConnect(connection: VMConnection): Promise<void> {
  // SECURITY: Validate all connection parameters before use
  // This prevents command injection if the history file is corrupted or tampered with
  const connectValidation = tryCatch(() => {
    validateConnectionIP(connection.ip);
    validateUsername(connection.user);
    if (connection.server_name) {
      validateServerIdentifier(connection.server_name);
    }
    if (connection.server_id) {
      validateServerIdentifier(connection.server_id);
    }
  });
  if (!connectValidation.ok) {
    p.log.error(`Security validation failed: ${getErrorMessage(connectValidation.error)}`);
    p.log.info("Your spawn history file may be corrupted or tampered with.");
    p.log.info(`Location: ${getHistoryPath()}`);
    p.log.info("To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'");
    process.exit(1);
  }

  // Handle Sprite console connections
  if (connection.ip === "sprite-console" && connection.server_name) {
    p.log.step(`Connecting to sprite ${pc.bold(connection.server_name)}...`);
    return runInteractiveCommand(
      "sprite",
      [
        "console",
        "-s",
        connection.server_name,
      ],
      "Sprite console connection failed",
      `sprite console -s ${connection.server_name}`,
    );
  }

  // Handle SSH connections
  p.log.step(`Connecting to ${pc.bold(connection.ip)}...`);
  const sshCmd = `ssh ${connection.user}@${connection.ip}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  return runInteractiveCommand(
    "ssh",
    [
      ...SSH_INTERACTIVE_OPTS,
      ...keyOpts,
      `${connection.user}@${connection.ip}`,
    ],
    "SSH connection failed",
    sshCmd,
  );
}

/** SSH into a VM and launch the agent directly */
export async function cmdEnterAgent(
  connection: VMConnection,
  agentKey: string,
  manifest: Manifest | null,
): Promise<void> {
  // SECURITY: Validate all connection parameters before use
  const enterValidation = tryCatch(() => {
    validateConnectionIP(connection.ip);
    validateUsername(connection.user);
    if (connection.server_name) {
      validateServerIdentifier(connection.server_name);
    }
    if (connection.server_id) {
      validateServerIdentifier(connection.server_id);
    }
    if (connection.launch_cmd) {
      validateLaunchCmd(connection.launch_cmd);
    }
  });
  if (!enterValidation.ok) {
    p.log.error(`Security validation failed: ${getErrorMessage(enterValidation.error)}`);
    p.log.info("Your spawn history file may be corrupted or tampered with.");
    p.log.info(`Location: ${getHistoryPath()}`);
    p.log.info("To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'");
    process.exit(1);
  }

  const agentDef = manifest?.agents?.[agentKey];

  // Prefer the launch command stored at spawn time (captures dynamic state),
  // fall back to manifest definition, then to agent key as last resort
  const storedCmd = connection.launch_cmd;
  let remoteCmd: string;
  if (storedCmd) {
    // Stored command already includes source ~/.spawnrc, PATH setup, etc.
    remoteCmd = storedCmd;
  } else {
    const launchCmd = agentDef?.launch ?? agentKey;
    const preLaunch = agentDef?.pre_launch;
    // Validate pre_launch and launch separately — pre_launch may contain
    // shell redirections (>, 2>&1) and backgrounding (&) that are invalid
    // in a launch command but valid for background daemon setup (#2474)
    if (preLaunch) {
      validatePreLaunchCmd(preLaunch);
    }
    validateLaunchCmd(`source ~/.spawnrc 2>/dev/null; ${launchCmd}`);
    const parts = [
      "source ~/.spawnrc 2>/dev/null",
    ];
    if (preLaunch) {
      parts.push(preLaunch);
    }
    parts.push(launchCmd);
    remoteCmd = parts.reduce((acc, part) => {
      if (!acc) {
        return part;
      }
      const sep = acc.trimEnd().endsWith("&") ? " " : "; ";
      return acc + sep + part;
    }, "");
  }

  const agentName = agentDef?.name || agentKey;

  // Handle Sprite console connections
  if (connection.ip === "sprite-console" && connection.server_name) {
    p.log.step(`Entering ${pc.bold(agentName)} on sprite ${pc.bold(connection.server_name)}...`);
    return runInteractiveCommand(
      "sprite",
      [
        "console",
        "-s",
        connection.server_name,
        "--",
        "bash",
        "-lc",
        remoteCmd,
      ],
      `Failed to enter ${agentName}`,
      `sprite console -s ${connection.server_name} -- bash -lc '${remoteCmd}'`,
    );
  }

  // Re-establish SSH tunnel for web dashboard if tunnel metadata was persisted at spawn time
  let tunnelHandle: SshTunnelHandle | undefined;
  const tunnelPort = connection.metadata?.tunnel_remote_port;
  if (tunnelPort && connection.ip !== "sprite-console") {
    const tunnelResult = await asyncTryCatchIf(isOperationalError, async () => {
      const keys = await ensureSshKeys();
      tunnelHandle = await startSshTunnel({
        host: connection.ip,
        user: connection.user,
        remotePort: Number(tunnelPort),
        sshKeyOpts: getSshKeyOpts(keys),
      });
      const urlTemplate = connection.metadata?.tunnel_browser_url_template;
      if (urlTemplate) {
        const url = urlTemplate.replace("__PORT__", String(tunnelHandle.localPort));
        openBrowser(url);
      }
    });
    if (!tunnelResult.ok) {
      logWarn("Web dashboard tunnel failed — dashboard unavailable this session");
    }
  }

  // Standard SSH connection with agent launch
  p.log.step(`Entering ${pc.bold(agentName)} on ${pc.bold(connection.ip)}...`);
  const quotedRemoteCmd = shellQuote(remoteCmd);
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  await runInteractiveCommand(
    "ssh",
    [
      ...SSH_INTERACTIVE_OPTS,
      ...keyOpts,
      `${connection.user}@${connection.ip}`,
      "--",
      `bash -lc ${quotedRemoteCmd}`,
    ],
    `Failed to enter ${agentName}`,
    `ssh -t ${connection.user}@${connection.ip} -- bash -lc ${quotedRemoteCmd}`,
  );
  if (tunnelHandle) {
    tunnelHandle.stop();
  }
}

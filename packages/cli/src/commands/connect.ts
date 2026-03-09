import type { VMConnection } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import { getHistoryPath } from "../history.js";
import { validateConnectionIP, validateLaunchCmd, validateServerIdentifier, validateUsername } from "../security.js";
import { wrapWithTmux } from "../shared/orchestrate.js";
import { SSH_INTERACTIVE_OPTS, spawnInteractive } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { getErrorMessage } from "./shared.js";

/** Execute a shell command and resolve/reject on process close/error */
async function runInteractiveCommand(
  cmd: string,
  args: string[],
  failureMsg: string,
  manualCmd: string,
): Promise<void> {
  let code: number;
  try {
    code = spawnInteractive([
      cmd,
      ...args,
    ]);
  } catch (err) {
    p.log.error(`Failed to connect: ${getErrorMessage(err)}`);
    p.log.info(`Try manually: ${pc.cyan(manualCmd)}`);
    throw err;
  }
  if (code !== 0) {
    throw new Error(`${failureMsg} with exit code ${code}`);
  }
}

/** Connect to an existing VM via SSH */
export async function cmdConnect(connection: VMConnection): Promise<void> {
  // SECURITY: Validate all connection parameters before use
  // This prevents command injection if the history file is corrupted or tampered with
  try {
    validateConnectionIP(connection.ip);
    validateUsername(connection.user);
    if (connection.server_name) {
      validateServerIdentifier(connection.server_name);
    }
    if (connection.server_id) {
      validateServerIdentifier(connection.server_id);
    }
  } catch (err) {
    p.log.error(`Security validation failed: ${getErrorMessage(err)}`);
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
  try {
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
  } catch (err) {
    p.log.error(`Security validation failed: ${getErrorMessage(err)}`);
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

  // Standard SSH connection with agent launch (wrapped in tmux for session persistence)
  p.log.step(`Entering ${pc.bold(agentName)} on ${pc.bold(connection.ip)}...`);
  const tmuxCmd = wrapWithTmux(remoteCmd);
  const escapedTmuxCmd = tmuxCmd.replace(/'/g, "'\\''");
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  return runInteractiveCommand(
    "ssh",
    [
      ...SSH_INTERACTIVE_OPTS,
      ...keyOpts,
      `${connection.user}@${connection.ip}`,
      "--",
      `bash -lc '${escapedTmuxCmd}'`,
    ],
    `Failed to enter ${agentName}`,
    `ssh -t ${connection.user}@${connection.ip}`,
  );
}

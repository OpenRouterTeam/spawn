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
  validateTunnelPort,
  validateTunnelUrl,
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

async function openDaytonaDashboard(connection: VMConnection): Promise<boolean> {
  if (connection.cloud !== "daytona") {
    return false;
  }

  const metadata = connection.metadata;
  const remotePort = metadata?.tunnel_remote_port;
  if (!remotePort || !connection.server_id) {
    return false;
  }

  const template = metadata?.tunnel_browser_url_template;
  const urlSuffix = template ? template.replace("http://localhost:__PORT__", "") : "";
  const { getSignedPreviewBrowserUrl } = await import("../daytona/daytona.js");
  const url = await getSignedPreviewBrowserUrl(connection.server_id, Number.parseInt(remotePort, 10), urlSuffix);
  openBrowser(url);
  return true;
}

/** Connect to an existing VM via SSH */
export async function cmdConnect(connection: VMConnection): Promise<void> {
  const validateDaytona = connection.cloud === "daytona" ? await import("../daytona/daytona.js") : null;

  // SECURITY: Validate all connection parameters before use
  // This prevents command injection if the history file is corrupted or tampered with
  const connectValidation = tryCatch(() => {
    if (validateDaytona) {
      validateDaytona.validateDaytonaConnection(connection);
      return;
    }

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

  if (connection.cloud === "daytona" && connection.server_id) {
    p.log.step(`Connecting to Daytona sandbox ${pc.bold(connection.server_name || connection.server_id)}...`);
    const { buildInteractiveSshArgs } = await import("../daytona/daytona.js");
    const args = await buildInteractiveSshArgs(connection.server_id);
    return runInteractiveCommand(
      args[0],
      args.slice(1),
      "Daytona SSH connection failed",
      `spawn connect ${connection.server_name || connection.server_id}`,
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
  const validateDaytona = connection.cloud === "daytona" ? await import("../daytona/daytona.js") : null;

  // SECURITY: Validate all connection parameters before use
  const enterValidation = tryCatch(() => {
    if (validateDaytona) {
      validateDaytona.validateDaytonaConnection(connection);
    } else {
      validateConnectionIP(connection.ip);
      validateUsername(connection.user);
      if (connection.server_name) {
        validateServerIdentifier(connection.server_name);
      }
      if (connection.server_id) {
        validateServerIdentifier(connection.server_id);
      }
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

  // Handle Sprite connections — use `sprite exec -tty` to run a command interactively.
  // `sprite console` does NOT accept arguments; it is a pure interactive shell.
  if (connection.ip === "sprite-console" && connection.server_name) {
    p.log.step(`Entering ${pc.bold(agentName)} on sprite ${pc.bold(connection.server_name)}...`);
    return runInteractiveCommand(
      "sprite",
      [
        "exec",
        "-s",
        connection.server_name,
        "-tty",
        "--",
        "bash",
        "-lc",
        remoteCmd,
      ],
      `Failed to enter ${agentName}`,
      `sprite exec -s ${connection.server_name} -tty -- bash -lc '${remoteCmd}'`,
    );
  }

  if (connection.cloud === "daytona" && connection.server_id) {
    await openDaytonaDashboard(connection);
    p.log.step(
      `Entering ${pc.bold(agentName)} on Daytona sandbox ${pc.bold(connection.server_name || connection.server_id)}...`,
    );
    const { buildInteractiveSshArgs } = await import("../daytona/daytona.js");
    const args = await buildInteractiveSshArgs(connection.server_id, remoteCmd);
    return runInteractiveCommand(
      args[0],
      args.slice(1),
      `Failed to enter ${agentName}`,
      `spawn enter ${connection.server_name || connection.server_id}`,
    );
  }

  // Re-establish SSH tunnel for web dashboard if tunnel metadata was persisted at spawn time
  let tunnelHandle: SshTunnelHandle | undefined;
  const tunnelPort = connection.metadata?.tunnel_remote_port;
  if (tunnelPort && connection.ip !== "sprite-console") {
    // SECURITY: Validate tunnel metadata before use (prevent phishing via tampered history)
    const tunnelValidation = tryCatch(() => {
      validateTunnelPort(tunnelPort);
      const tpl = connection.metadata?.tunnel_browser_url_template;
      if (tpl) {
        validateTunnelUrl(tpl);
      }
    });
    if (!tunnelValidation.ok) {
      p.log.error(`Security validation failed: ${getErrorMessage(tunnelValidation.error)}`);
      p.log.info("Your spawn history file may be corrupted or tampered with.");
      p.log.info(`Location: ${getHistoryPath()}`);
      p.log.info("To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'");
      process.exit(1);
    }

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

/** Open the web dashboard for a VM by establishing an SSH tunnel and launching the browser.
 *  Blocks until the user presses Enter, then tears down the tunnel. */
export async function cmdOpenDashboard(connection: VMConnection): Promise<void> {
  if (connection.cloud === "daytona") {
    const { validateDaytonaConnection } = await import("../daytona/daytona.js");
    const validation = tryCatch(() => validateDaytonaConnection(connection));
    if (!validation.ok) {
      p.log.error(`Security validation failed: ${getErrorMessage(validation.error)}`);
      return;
    }
    const opened = await openDaytonaDashboard(connection);
    if (!opened) {
      p.log.error("No dashboard metadata found for this Daytona sandbox.");
      return;
    }
    p.log.success("Opened Daytona preview URL in your browser.");
    return;
  }

  const validation = tryCatch(() => {
    validateConnectionIP(connection.ip);
    validateUsername(connection.user);
  });
  if (!validation.ok) {
    p.log.error(`Security validation failed: ${getErrorMessage(validation.error)}`);
    return;
  }

  const tunnelPort = connection.metadata?.tunnel_remote_port;
  const urlTemplate = connection.metadata?.tunnel_browser_url_template;
  if (!tunnelPort) {
    p.log.error("No dashboard tunnel info found for this server.");
    return;
  }

  // SECURITY: Validate tunnel metadata before use (prevent phishing via tampered history)
  const tunnelValidation = tryCatch(() => {
    validateTunnelPort(tunnelPort);
    if (urlTemplate) {
      validateTunnelUrl(urlTemplate);
    }
  });
  if (!tunnelValidation.ok) {
    p.log.error(`Security validation failed: ${getErrorMessage(tunnelValidation.error)}`);
    p.log.info("Your spawn history file may be corrupted or tampered with.");
    p.log.info(`Location: ${getHistoryPath()}`);
    p.log.info("To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'");
    return;
  }

  p.log.step("Opening SSH tunnel to dashboard...");
  const keys = await ensureSshKeys();
  const tunnelResult = await asyncTryCatchIf(isOperationalError, () =>
    startSshTunnel({
      host: connection.ip,
      user: connection.user,
      remotePort: Number(tunnelPort),
      sshKeyOpts: getSshKeyOpts(keys),
    }),
  );
  if (!tunnelResult.ok) {
    p.log.error("Failed to open SSH tunnel to dashboard.");
    return;
  }

  const handle = tunnelResult.data;
  if (urlTemplate) {
    const url = urlTemplate.replace("__PORT__", String(handle.localPort));
    openBrowser(url);
    p.log.success(`Dashboard opened at ${pc.cyan(url)}`);
  } else {
    p.log.success(`Dashboard tunnel open on localhost:${handle.localPort}`);
  }

  p.log.info("Press Enter to close the dashboard tunnel.");
  await new Promise<void>((resolve) => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  handle.stop();
  p.log.step("Dashboard tunnel closed.");
}

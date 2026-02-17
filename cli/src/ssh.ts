/**
 * SSH utilities — TypeScript equivalent of shared/common.sh SSH helpers.
 *
 * Replaces: generic_ssh_wait, ssh_run_server, ssh_upload_file,
 *           ssh_interactive_session, ssh_verify_connectivity
 */
import { spawn, type SpawnOptions } from "child_process";
import type { ServerInfo } from "./cloud-provider.js";

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
  "-o", "ConnectTimeout=10",
];

/** Run a command on a remote server via SSH. Returns stdout. */
export async function sshRun(server: ServerInfo, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...SSH_OPTS, `${server.user}@${server.ip}`, command];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`SSH command failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

/** Upload a file to a remote server via SCP. */
export async function scpUpload(
  server: ServerInfo,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [...SSH_OPTS, localPath, `${server.user}@${server.ip}:${remotePath}`];
    const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SCP upload failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

/** Start an interactive SSH session (hands control to the terminal). */
export async function sshInteractive(server: ServerInfo, command?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [...SSH_OPTS, "-t", `${server.user}@${server.ip}`];
    if (command) args.push(command);
    const opts: SpawnOptions = { stdio: "inherit" };
    const child = spawn("ssh", args, opts);
    child.on("close", (code) => {
      if (code === 0 || code === 130) resolve(); // 130 = Ctrl-C
      else reject(new Error(`SSH session exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

/** Wait for SSH to become available on a server. Retries with backoff. */
export async function waitForSSH(
  server: ServerInfo,
  timeoutSeconds = 120,
): Promise<void> {
  const startTime = Date.now();
  const deadline = startTime + timeoutSeconds * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      await sshRun(server, "echo ok");
      return;
    } catch {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (Date.now() + 5000 > deadline) {
        throw new Error(
          `SSH not reachable after ${elapsed}s (${attempt} attempts). ` +
          `Server: ${server.ip}`,
        );
      }
      // Backoff: 2s, 3s, 5s, 5s, 5s...
      const delay = Math.min(2000 + attempt * 1000, 5000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Wait for cloud-init to complete on a server. */
export async function waitForCloudInit(
  server: ServerInfo,
  timeoutSeconds = 120,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      const status = await sshRun(
        server,
        "cloud-init status --format json 2>/dev/null || echo '{\"status\": \"done\"}'",
      );
      if (status.includes('"done"') || status.includes('"disabled"')) {
        return;
      }
    } catch {
      // SSH may not be ready yet
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(`Cloud-init did not complete within ${timeoutSeconds}s`);
}

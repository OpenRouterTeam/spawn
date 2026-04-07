// shared/ssh-runner.ts — Generic SSH-based CloudRunner for use by `spawn fix`
// and other commands that need to run commands on an existing VM.

import type { CloudRunner } from "./agent-setup.js";

import { asyncTryCatch } from "./result.js";
import { killWithTimeout, SSH_BASE_OPTS, validateRemotePath } from "./ssh.js";
import { shellQuote } from "./ui.js";

/**
 * Create a CloudRunner backed by SSH to an existing VM.
 *
 * This is a generic version of the cloud-specific runners (hetzner, aws, sprite).
 * It takes explicit connection parameters instead of reading from cloud state.
 */
export function makeSshRunner(ip: string, user: string, keyOpts: string[]): CloudRunner {
  return {
    async runServer(cmd: string, timeoutSecs?: number): Promise<void> {
      if (!cmd || /\0/.test(cmd)) {
        throw new Error("Invalid command: must be non-empty and must not contain null bytes");
      }
      const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH" && bash -c ${shellQuote(cmd)}`;

      const proc = Bun.spawn(
        [
          "ssh",
          ...SSH_BASE_OPTS,
          ...keyOpts,
          `${user}@${ip}`,
          fullCmd,
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );

      const timeout = (timeoutSecs || 300) * 1000;
      const timer = setTimeout(() => killWithTimeout(proc), timeout);

      const runResult = await asyncTryCatch(async () => {
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

      if (!runResult.ok) {
        throw runResult.error;
      }
      if (runResult.data.exitCode !== 0) {
        const stderr = runResult.data.stderr.trim();
        throw new Error(stderr || `Command exited with code ${runResult.data.exitCode}`);
      }
    },

    async uploadFile(localPath: string, remotePath: string): Promise<void> {
      const expandedRemote = remotePath.replace(/^\$HOME\//, "~/");
      const normalizedRemote = validateRemotePath(expandedRemote, /^[a-zA-Z0-9/_.~-]+$/);

      const proc = Bun.spawn(
        [
          "scp",
          ...SSH_BASE_OPTS,
          ...keyOpts,
          localPath,
          `${user}@${ip}:${normalizedRemote}`,
        ],
        {
          stdio: [
            "ignore",
            "inherit",
            "inherit",
          ],
        },
      );
      const timer = setTimeout(() => killWithTimeout(proc), 120_000);
      const result = await asyncTryCatch(() => proc.exited);
      clearTimeout(timer);

      if (!result.ok) {
        throw result.error;
      }
      if (result.data !== 0) {
        throw new Error(`upload_file failed for ${remotePath}`);
      }
    },

    async downloadFile(remotePath: string, localPath: string): Promise<void> {
      const expandedRemote = remotePath.replace(/^\$HOME\//, "~/");
      const normalizedRemote = validateRemotePath(expandedRemote, /^[a-zA-Z0-9/_.~-]+$/);

      const proc = Bun.spawn(
        [
          "scp",
          ...SSH_BASE_OPTS,
          ...keyOpts,
          `${user}@${ip}:${normalizedRemote}`,
          localPath,
        ],
        {
          stdio: [
            "ignore",
            "inherit",
            "inherit",
          ],
        },
      );
      const timer = setTimeout(() => killWithTimeout(proc), 120_000);
      const result = await asyncTryCatch(() => proc.exited);
      clearTimeout(timer);

      if (!result.ok) {
        throw result.error;
      }
      if (result.data !== 0) {
        throw new Error(`download_file failed for ${remotePath}`);
      }
    },
  };
}

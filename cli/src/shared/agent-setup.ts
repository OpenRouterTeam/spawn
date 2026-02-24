// shared/agent-setup.ts — Shared agent helpers + definitions for SSH-based clouds
// Cloud-agnostic: receives runServer/uploadFile via CloudRunner interface.

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logInfo, logWarn, logError, logStep, prompt, jsonEscape, withRetry, Ok, Err, type Result } from "./ui";
import { hasMessage } from "./type-guards";
import type { AgentConfig } from "./agents";

/**
 * Wrap an SSH-based async operation into a Result for use with withRetry.
 * - Transient SSH/connection errors → Err (retryable)
 * - Timeouts → throw (non-retryable: command may have already run)
 * - Everything else → throw (non-retryable: unknown failure)
 */
export async function wrapSshCall(op: Promise<void>): Promise<Result<void>> {
  try {
    await op;
    return Ok(undefined);
  } catch (err) {
    const msg = hasMessage(err) ? err.message : String(err);
    // Timeouts are NOT retryable — the command may have completed on the
    // remote but we lost the connection before seeing the exit code.
    if (msg.includes("timed out") || msg.includes("timeout")) {
      throw err;
    }
    // All other SSH errors (connection refused, reset, etc.) are retryable.
    return Err(new Error(msg));
  }
}

// Re-export so cloud modules can re-export from here
export type { AgentConfig };
export { generateEnvConfig } from "./agents";

// ─── CloudRunner interface ──────────────────────────────────────────────────

export interface CloudRunner {
  runServer(cmd: string, timeoutSecs?: number): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
}

// ─── Install helpers ────────────────────────────────────────────────────────

export async function installAgent(
  runner: CloudRunner,
  agentName: string,
  installCmd: string,
  timeoutSecs?: number,
): Promise<void> {
  logStep(`Installing ${agentName}...`);
  try {
    await withRetry(`${agentName} install`, () => wrapSshCall(runner.runServer(installCmd, timeoutSecs)), 2, 10);
  } catch {
    logError(`${agentName} installation failed`);
    throw new Error(`${agentName} install failed`);
  }
  logInfo(`${agentName} installation completed`);
}

/**
 * Upload a config file to the remote machine via a temp file and mv.
 */
export async function uploadConfigFile(runner: CloudRunner, content: string, remotePath: string): Promise<void> {
  const tmpFile = join(tmpdir(), `spawn_config_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpFile, content, {
    mode: 0o600,
  });

  try {
    await withRetry(
      "config upload",
      () =>
        wrapSshCall(
          (async () => {
            const tempRemote = `/tmp/spawn_config_${Date.now()}`;
            await runner.uploadFile(tmpFile, tempRemote);
            await runner.runServer(
              `mkdir -p $(dirname "${remotePath}") && chmod 600 '${tempRemote}' && mv '${tempRemote}' "${remotePath}"`,
            );
          })(),
        ),
      2,
      5,
    );
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

export async function installClaudeCode(runner: CloudRunner): Promise<void> {
  logStep("Installing Claude Code...");

  const claudePath = "$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin";
  const pathSetup = `for rc in ~/.bashrc ~/.zshrc; do grep -q '.claude/local/bin' "$rc" 2>/dev/null || printf '\\n# Claude Code PATH\\nexport PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"\\n' >> "$rc"; done`;
  const finalize = `claude install --force 2>/dev/null || true; ${pathSetup}`;

  const script = [
    `export PATH="${claudePath}:$PATH"`,
    `if [ -f ~/.bash_profile ] && grep -q 'spawn:env\\|Claude Code PATH\\|spawn:path' ~/.bash_profile 2>/dev/null; then rm -f ~/.bash_profile; fi`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `echo "==> Installing Claude Code (method 1/2: curl installer)..."`,
    "curl -fsSL https://claude.ai/install.sh | bash || true",
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    "if ! command -v node >/dev/null 2>&1; then curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s install 22 || true; fi",
    `echo "==> Installing Claude Code (method 2/2: npm)..."`,
    "npm install -g @anthropic-ai/claude-code || true",
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    "exit 1",
  ].join("\n");

  try {
    await runner.runServer(script, 300);
    logInfo("Claude Code installed");
  } catch {
    logError("Claude Code installation failed");
    throw new Error("Claude Code install failed");
  }
}

export async function setupClaudeCodeConfig(runner: CloudRunner, apiKey: string): Promise<void> {
  logStep("Configuring Claude Code...");

  const escapedKey = jsonEscape(apiKey);
  const settingsJson = `{
  "theme": "dark",
  "editor": "vim",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": ${escapedKey}
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  }
}`;
  const globalState = `{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}`;

  const settingsB64 = Buffer.from(settingsJson).toString("base64");
  const stateB64 = Buffer.from(globalState).toString("base64");

  await runner.runServer(
    `mkdir -p ~/.claude && printf '%s' '${settingsB64}' | base64 -d > ~/.claude/settings.json && chmod 600 ~/.claude/settings.json && printf '%s' '${stateB64}' | base64 -d > ~/.claude.json && chmod 600 ~/.claude.json && touch ~/.claude/CLAUDE.md`,
  );
  logInfo("Claude Code configured");
}

// ─── GitHub Auth ─────────────────────────────────────────────────────────────

let githubAuthRequested = false;
let githubToken = "";

export async function promptGithubAuth(): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) {
    return;
  }
  process.stderr.write("\n");
  const choice = await prompt("Set up GitHub CLI (gh) on this machine? (y/N): ");
  if (/^[Yy]$/.test(choice)) {
    githubAuthRequested = true;
    if (process.env.GITHUB_TOKEN) {
      githubToken = process.env.GITHUB_TOKEN;
    } else {
      try {
        const result = Bun.spawnSync(
          [
            "gh",
            "auth",
            "token",
          ],
          {
            stdio: [
              "ignore",
              "pipe",
              "ignore",
            ],
          },
        );
        if (result.exitCode === 0) {
          githubToken = new TextDecoder().decode(result.stdout).trim();
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export async function offerGithubAuth(runner: CloudRunner): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) {
    return;
  }
  if (!githubAuthRequested) {
    return;
  }

  let ghCmd = "curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/github-auth.sh | bash";
  let localTmpFile = "";
  if (githubToken) {
    const escaped = githubToken.replace(/'/g, "'\\''");
    localTmpFile = join(tmpdir(), `gh_token_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    writeFileSync(localTmpFile, `export GITHUB_TOKEN='${escaped}'`, {
      mode: 0o600,
    });
    const remoteTmpFile = `/tmp/gh_token_${Date.now()}`;
    try {
      await runner.uploadFile(localTmpFile, remoteTmpFile);
      ghCmd = `. ${remoteTmpFile} && rm -f ${remoteTmpFile} && ${ghCmd}`;
    } catch {
      try {
        unlinkSync(localTmpFile);
      } catch {
        /* ignore */
      }
      localTmpFile = "";
    }
  }

  logStep("Installing and authenticating GitHub CLI...");
  try {
    await runner.runServer(ghCmd);
  } catch {
    logWarn("GitHub CLI setup failed (non-fatal, continuing)");
  } finally {
    if (localTmpFile) {
      try {
        unlinkSync(localTmpFile);
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Codex CLI Config ────────────────────────────────────────────────────────

export async function setupCodexConfig(runner: CloudRunner, _apiKey: string): Promise<void> {
  logStep("Configuring Codex CLI for OpenRouter...");
  const config = `model = "openai/gpt-5-codex"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "chat"
`;
  await uploadConfigFile(runner, config, "$HOME/.codex/config.toml");
}

// ─── OpenClaw Config ─────────────────────────────────────────────────────────

export async function setupOpenclawConfig(runner: CloudRunner, apiKey: string, modelId: string): Promise<void> {
  logStep("Configuring openclaw...");
  await runner.runServer("mkdir -p ~/.openclaw");

  const gatewayToken = crypto.randomUUID().replace(/-/g, "");
  const escapedKey = jsonEscape(apiKey);
  const escapedToken = jsonEscape(gatewayToken);
  const escapedModel = jsonEscape(modelId);

  const config = `{
  "env": {
    "OPENROUTER_API_KEY": ${escapedKey}
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": ${escapedToken}
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": ${escapedModel}
      }
    }
  }
}`;
  await uploadConfigFile(runner, config, "$HOME/.openclaw/openclaw.json");
}

export async function setupOpenclawBatched(
  runner: CloudRunner,
  envContent: string,
  apiKey: string,
  modelId: string,
): Promise<void> {
  logStep("Setting up OpenClaw (install check + env + config)...");

  const envB64 = Buffer.from(envContent).toString("base64");

  const gatewayToken = crypto.randomUUID().replace(/-/g, "");
  const configJson = JSON.stringify({
    env: {
      OPENROUTER_API_KEY: apiKey,
    },
    gateway: {
      mode: "local",
      auth: {
        token: gatewayToken,
      },
    },
    agents: {
      defaults: {
        model: {
          primary: modelId,
        },
      },
    },
  });
  const configB64 = Buffer.from(configJson).toString("base64");

  const script = [
    'echo "==> Checking openclaw..."',
    'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
    "if command -v openclaw >/dev/null 2>&1; then",
    '  echo "    openclaw found at $(command -v openclaw)"',
    "else",
    '  echo "    openclaw not found, installing..."',
    "  bun install -g openclaw",
    '  command -v openclaw || { echo "ERROR: openclaw install failed"; exit 1; }',
    "fi",
    'echo "==> Writing environment variables..."',
    `printf '%s' '${envB64}' | base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc`,
    "grep -q 'source ~/.spawnrc' ~/.bashrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.bashrc",
    "grep -q 'source ~/.spawnrc' ~/.zshrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.zshrc",
    'echo "==> Writing openclaw config..."',
    "mkdir -p ~/.openclaw",
    `printf '%s' '${configB64}' | base64 -d > ~/.openclaw/openclaw.json && chmod 600 ~/.openclaw/openclaw.json`,
    'echo "==> Setup complete"',
  ].join("\n");

  await runner.runServer(script);
  logInfo("OpenClaw setup complete (install + env + config)");
}

export async function startGateway(runner: CloudRunner): Promise<void> {
  logStep("Starting OpenClaw gateway daemon...");
  // Start the daemon AND wait for port 18789 in a single SSH session.
  // The polling loop doubles as a keepalive for flyctl.
  const script =
    "source ~/.spawnrc 2>/dev/null; " +
    "export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
    "if command -v setsid >/dev/null 2>&1; then setsid openclaw gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & " +
    "else nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & fi; " +
    "elapsed=0; while [ $elapsed -lt 60 ]; do " +
    'if (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || nc -z 127.0.0.1 18789 2>/dev/null; then echo "Gateway ready after ${elapsed}s"; exit 0; fi; ' +
    "printf '.'; sleep 1; elapsed=$((elapsed + 1)); " +
    "done; " +
    'echo "Gateway failed to start after 60s"; tail -20 /tmp/openclaw-gateway.log 2>/dev/null; exit 1';
  await runner.runServer(script);
  logInfo("OpenClaw gateway started");
}

// ─── ZeroClaw Config ─────────────────────────────────────────────────────────

export async function setupZeroclawConfig(runner: CloudRunner, _apiKey: string): Promise<void> {
  logStep("Configuring ZeroClaw for autonomous operation...");

  // Run onboard first to set up provider/key
  await runner.runServer(
    `source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.cargo/bin:$PATH"; zeroclaw onboard --api-key "\${OPENROUTER_API_KEY}" --provider openrouter`,
  );

  // Write autonomy config — equivalent to Claude Code's dangerouslySkipPermissions
  const config = `[security]
autonomy = "full"
supervised = false
allow_destructive = true

[shell]
policy = "allow_all"
`;
  await uploadConfigFile(runner, config, "$HOME/.zeroclaw/config.toml");
  logInfo("ZeroClaw configured for autonomous operation");
}

// ─── Swap Space Setup ─────────────────────────────────────────────────────────

/**
 * Ensure swap space exists on the remote machine.
 * Used before memory-intensive builds (e.g., Rust compilation) on
 * resource-constrained instances (512 MB RAM). Idempotent — skips if
 * swap is already configured. Non-fatal if sudo is unavailable.
 */
export async function ensureSwapSpace(runner: CloudRunner, sizeMb = 1024): Promise<void> {
  if (typeof sizeMb !== "number" || sizeMb <= 0 || !Number.isInteger(sizeMb)) {
    throw new Error(`Invalid swap size: ${sizeMb}`);
  }
  logStep(`Ensuring ${sizeMb} MB swap space for compilation...`);
  const script = [
    "if swapon --show 2>/dev/null | grep -q /swapfile; then",
    "  echo '==> Swap already configured, skipping'",
    "else",
    `  echo '==> Creating ${sizeMb} MB swap file...'`,
    `  sudo fallocate -l ${sizeMb}M /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=${sizeMb} status=none`,
    "  sudo chmod 600 /swapfile",
    "  sudo mkswap /swapfile >/dev/null",
    "  sudo swapon /swapfile",
    "  echo '==> Swap enabled'",
    "fi",
  ].join("\n");
  try {
    await runner.runServer(script);
    logInfo("Swap space ready");
  } catch {
    logWarn("Swap setup failed (non-fatal) — build may still succeed on larger instances");
  }
}

// ─── OpenCode Install Command ────────────────────────────────────────────────

export function openCodeInstallCmd(): string {
  return 'OC_ARCH=$(uname -m); case "$OC_ARCH" in aarch64) OC_ARCH=arm64;; x86_64) OC_ARCH=x64;; esac; OC_OS=$(uname -s | tr A-Z a-z); mkdir -p /tmp/opencode-install "$HOME/.opencode/bin" && curl -fsSL -o /tmp/opencode-install/oc.tar.gz "https://github.com/anomalyco/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz" && tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install && mv /tmp/opencode-install/opencode "$HOME/.opencode/bin/" && rm -rf /tmp/opencode-install && grep -q ".opencode/bin" "$HOME/.bashrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.bashrc"; grep -q ".opencode/bin" "$HOME/.zshrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.zshrc" 2>/dev/null; export PATH="$HOME/.opencode/bin:$PATH"';
}

// ─── Default Agent Definitions ───────────────────────────────────────────────

const ZEROCLAW_INSTALL_URL =
  "https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/bootstrap.sh";

export function createAgents(runner: CloudRunner): Record<string, AgentConfig> {
  return {
    claude: {
      name: "Claude Code",
      cloudInitTier: "minimal",
      preProvision: promptGithubAuth,
      install: () => installClaudeCode(runner),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
        `ANTHROPIC_AUTH_TOKEN=${apiKey}`,
        "ANTHROPIC_API_KEY=",
        "CLAUDE_CODE_SKIP_ONBOARDING=1",
        "CLAUDE_CODE_ENABLE_TELEMETRY=0",
      ],
      configure: (apiKey) => setupClaudeCodeConfig(runner, apiKey),
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude",
    },

    codex: {
      name: "Codex CLI",
      cloudInitTier: "node",
      install: () =>
        installAgent(
          runner,
          "Codex CLI",
          "mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global && npm install -g @openai/codex",
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
      ],
      configure: (apiKey) => setupCodexConfig(runner, apiKey),
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex",
    },

    openclaw: {
      name: "OpenClaw",
      cloudInitTier: "full",
      modelPrompt: true,
      modelDefault: "openrouter/auto",
      install: () => installAgent(runner, "openclaw", "source ~/.bashrc && bun install -g openclaw"),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        `ANTHROPIC_API_KEY=${apiKey}`,
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
      ],
      configure: (apiKey, modelId) => setupOpenclawConfig(runner, apiKey, modelId || "openrouter/auto"),
      preLaunch: () => startGateway(runner),
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH; openclaw tui",
    },

    opencode: {
      name: "OpenCode",
      cloudInitTier: "minimal",
      install: () => installAgent(runner, "OpenCode", openCodeInstallCmd()),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; opencode",
    },

    kilocode: {
      name: "Kilo Code",
      cloudInitTier: "node",
      install: () =>
        installAgent(
          runner,
          "Kilo Code",
          "mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global && npm install -g @kilocode/cli",
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "KILO_PROVIDER_TYPE=openrouter",
        `KILO_OPEN_ROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode",
    },

    zeroclaw: {
      name: "ZeroClaw",
      cloudInitTier: "minimal",
      install: async () => {
        // Add swap before building — low-memory instances (e.g., AWS nano 512 MB)
        // OOM during Rust compilation if --prefer-prebuilt falls back to source.
        await ensureSwapSpace(runner);
        await installAgent(
          runner,
          "ZeroClaw",
          `curl -LsSf ${ZEROCLAW_INSTALL_URL} | bash -s -- --install-rust --install-system-deps --prefer-prebuilt`,
          600, // 10 min: swap-backed compilation is slower than the 5-min default
        );
      },
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "ZEROCLAW_PROVIDER=openrouter",
      ],
      configure: (apiKey) => setupZeroclawConfig(runner, apiKey),
      launchCmd: () => "source ~/.cargo/env 2>/dev/null; source ~/.spawnrc 2>/dev/null; zeroclaw agent",
    },
  };
}

export function resolveAgent(agents: Record<string, AgentConfig>, name: string): AgentConfig {
  const agent = agents[name.toLowerCase()];
  if (!agent) {
    logError(`Unknown agent: ${name}`);
    logError(`Available agents: ${Object.keys(agents).join(", ")}`);
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}

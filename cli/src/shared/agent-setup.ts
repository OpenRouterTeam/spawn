// shared/agent-setup.ts — Shared agent helpers + definitions for SSH-based clouds
// Cloud-agnostic: receives runServer/uploadFile via CloudRunner interface.

import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  jsonEscape,
} from "./ui";
import type { AgentConfig } from "./agents";

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
    await runner.runServer(installCmd, timeoutSecs);
  } catch {
    logError(`${agentName} installation failed`);
    throw new Error(`${agentName} install failed`);
  }
  logInfo(`${agentName} installation completed`);
}

/**
 * Upload a config file to the remote machine via a temp file and mv.
 */
export async function uploadConfigFile(
  runner: CloudRunner,
  content: string,
  remotePath: string,
): Promise<void> {
  const tmpFile = join(tmpdir(), `spawn_config_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpFile, content, { mode: 0o600 });

  const tempRemote = `/tmp/spawn_config_${Date.now()}`;
  try {
    await runner.uploadFile(tmpFile, tempRemote);
    await runner.runServer(
      `mkdir -p $(dirname "${remotePath}") && chmod 600 '${tempRemote}' && mv '${tempRemote}' "${remotePath}"`,
    );
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

export async function installClaudeCode(runner: CloudRunner): Promise<void> {
  logStep("Installing Claude Code...");

  const claudePath = '$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin';
  const pathSetup = `for rc in ~/.bashrc ~/.zshrc; do grep -q '.claude/local/bin' "$rc" 2>/dev/null || printf '\\n# Claude Code PATH\\nexport PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"\\n' >> "$rc"; done`;
  const finalize = `claude install --force 2>/dev/null || true; ${pathSetup}`;

  const script = [
    `export PATH="${claudePath}:$PATH"`,
    `if [ -f ~/.bash_profile ] && grep -q 'spawn:env\\|Claude Code PATH\\|spawn:path' ~/.bash_profile 2>/dev/null; then rm -f ~/.bash_profile; fi`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `echo "==> Installing Claude Code (method 1/2: curl installer)..."`,
    `curl -fsSL https://claude.ai/install.sh | bash || true`,
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `if ! command -v node >/dev/null 2>&1; then apt-get update -y && apt-get install -y --no-install-recommends nodejs npm && npm install -g n && n 22 && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx || true; fi`,
    `echo "==> Installing Claude Code (method 2/2: npm)..."`,
    `npm install -g @anthropic-ai/claude-code || true`,
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `exit 1`,
  ].join('\n');

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
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) return;
  process.stderr.write("\n");
  const choice = await prompt("Set up GitHub CLI (gh) on this machine? (y/N): ");
  if (/^[Yy]$/.test(choice)) {
    githubAuthRequested = true;
    if (process.env.GITHUB_TOKEN) {
      githubToken = process.env.GITHUB_TOKEN;
    } else {
      try {
        const result = Bun.spawnSync(["gh", "auth", "token"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (result.exitCode === 0) {
          githubToken = new TextDecoder().decode(result.stdout).trim();
        }
      } catch { /* ignore */ }
    }
  }
}

export async function offerGithubAuth(runner: CloudRunner): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) return;
  if (!githubAuthRequested) return;

  let ghCmd = "curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/github-auth.sh | bash";
  let localTmpFile = "";
  if (githubToken) {
    const escaped = githubToken.replace(/'/g, "'\\''");
    localTmpFile = join(tmpdir(), `gh_token_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    writeFileSync(localTmpFile, `export GITHUB_TOKEN='${escaped}'`, { mode: 0o600 });
    const remoteTmpFile = `/tmp/gh_token_${Date.now()}`;
    try {
      await runner.uploadFile(localTmpFile, remoteTmpFile);
      ghCmd = `. ${remoteTmpFile} && rm -f ${remoteTmpFile} && ${ghCmd}`;
    } catch {
      try { unlinkSync(localTmpFile); } catch { /* ignore */ }
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
      try { unlinkSync(localTmpFile); } catch { /* ignore */ }
    }
  }
}

// ─── Codex CLI Config ────────────────────────────────────────────────────────

export async function setupCodexConfig(runner: CloudRunner, apiKey: string): Promise<void> {
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

export async function setupOpenclawConfig(
  runner: CloudRunner,
  apiKey: string,
  modelId: string,
): Promise<void> {
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

export async function startGateway(runner: CloudRunner): Promise<void> {
  logStep("Starting OpenClaw gateway daemon...");
  await runner.runServer(
    `source ~/.spawnrc 2>/dev/null; export PATH=$(npm prefix -g 2>/dev/null)/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; ` +
    `if command -v setsid >/dev/null 2>&1; then setsid openclaw gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & ` +
    `else nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & fi`,
  );
  logInfo("OpenClaw gateway started");
}

// ─── OpenCode Install Command ────────────────────────────────────────────────

export function openCodeInstallCmd(): string {
  return 'OC_ARCH=$(uname -m); case "$OC_ARCH" in aarch64) OC_ARCH=arm64;; x86_64) OC_ARCH=x64;; esac; OC_OS=$(uname -s | tr A-Z a-z); mkdir -p /tmp/opencode-install "$HOME/.opencode/bin" && curl -fsSL -o /tmp/opencode-install/oc.tar.gz "https://github.com/anomalyco/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz" && tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install && mv /tmp/opencode-install/opencode "$HOME/.opencode/bin/" && rm -rf /tmp/opencode-install && grep -q ".opencode/bin" "$HOME/.bashrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.bashrc"; grep -q ".opencode/bin" "$HOME/.zshrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.zshrc" 2>/dev/null; export PATH="$HOME/.opencode/bin:$PATH"';
}

// ─── Default Agent Definitions ───────────────────────────────────────────────

const ZEROCLAW_INSTALL_URL = "https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/install.sh";

export function createAgents(runner: CloudRunner): Record<string, AgentConfig> {
  return {
    claude: {
      name: "Claude Code",
      cloudInitTier: "node",
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
      install: () => installAgent(runner, "Codex CLI", "mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global && npm install -g @openai/codex"),
      envVars: (apiKey) => [`OPENROUTER_API_KEY=${apiKey}`],
      configure: (apiKey) => setupCodexConfig(runner, apiKey),
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex",
    },

    openclaw: {
      name: "OpenClaw",
      cloudInitTier: "full",
      modelPrompt: true,
      modelDefault: "openrouter/auto",
      install: () =>
        installAgent(runner, "openclaw", 'source ~/.bashrc && bun install -g openclaw'),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        `ANTHROPIC_API_KEY=${apiKey}`,
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
      ],
      configure: (apiKey, modelId) =>
        setupOpenclawConfig(runner, apiKey, modelId || "openrouter/auto"),
      preLaunch: () => startGateway(runner),
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; openclaw tui",
    },

    opencode: {
      name: "OpenCode",
      cloudInitTier: "minimal",
      install: () => installAgent(runner, "OpenCode", openCodeInstallCmd()),
      envVars: (apiKey) => [`OPENROUTER_API_KEY=${apiKey}`],
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; opencode",
    },

    kilocode: {
      name: "Kilo Code",
      cloudInitTier: "node",
      install: () => installAgent(runner, "Kilo Code", "mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global && npm install -g @kilocode/cli"),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "KILO_PROVIDER_TYPE=openrouter",
        `KILO_OPEN_ROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode",
    },

    zeroclaw: {
      name: "ZeroClaw",
      cloudInitTier: "minimal",
      install: () =>
        installAgent(
          runner,
          "ZeroClaw",
          `curl -LsSf ${ZEROCLAW_INSTALL_URL} | bash -s -- --install-rust --install-system-deps`,
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "ZEROCLAW_PROVIDER=openrouter",
      ],
      configure: async (apiKey) => {
        await runner.runServer(
          `source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.cargo/bin:$PATH"; zeroclaw onboard --api-key "\${OPENROUTER_API_KEY}" --provider openrouter`,
        );
      },
      launchCmd: () =>
        "source ~/.cargo/env 2>/dev/null; source ~/.spawnrc 2>/dev/null; zeroclaw agent",
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

// fly/lib/agents.ts — Agent configs + shared install/config helpers

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
import {
  runServer,
  uploadFile,
  runWithRetry,
} from "./fly";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  /** If true, prompt for model selection before provisioning. */
  modelPrompt?: boolean;
  /** Default model ID when modelPrompt is true. */
  modelDefault?: string;
  /** Pre-provision hook (runs before server creation, e.g., prompt for GitHub auth). */
  preProvision?: () => Promise<void>;
  /** Install the agent on the remote machine. */
  install: () => Promise<void>;
  /** Return env var pairs for .spawnrc. */
  envVars: (apiKey: string) => string[];
  /** Agent-specific configuration (settings files, etc.). */
  configure?: (apiKey: string, modelId?: string) => Promise<void>;
  /** Pre-launch hook (e.g., start gateway daemon). */
  preLaunch?: () => Promise<void>;
  /** Shell command to launch the agent interactively. */
  launchCmd: () => string;
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Generate env config content (shell export lines) for .spawnrc.
 * Values are single-quoted to prevent injection.
 */
export function generateEnvConfig(pairs: string[]): string {
  const lines = [
    "",
    "# [spawn:env]",
    "export IS_SANDBOX='1'",
  ];
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    // Validate env var name
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      logError(`SECURITY: Invalid environment variable name rejected: ${key}`);
      continue;
    }
    // Escape single quotes in value
    const escaped = value.replace(/'/g, "'\\''");
    lines.push(`export ${key}='${escaped}'`);
  }
  return lines.join("\n") + "\n";
}

async function installAgent(agentName: string, installCmd: string): Promise<void> {
  logStep(`Installing ${agentName}...`);
  // Wrap in a keepalive: run install in background, print a dot every 5s to
  // prevent fly machine exec from killing the SSH session on idle timeout.
  const keepalive = `{ ${installCmd}; } & PID=$!; while kill -0 $PID 2>/dev/null; do printf '.'; sleep 5; done; echo; wait $PID`;
  try {
    await runServer(keepalive);
  } catch {
    logError(`${agentName} installation failed`);
    logError("The agent could not be installed or verified on the server.");
    throw new Error(`${agentName} install failed`);
  }
  logInfo(`${agentName} installation completed`);
}

/**
 * Upload a config file to the remote machine via a temp file and mv.
 */
async function uploadConfigFile(
  content: string,
  remotePath: string,
): Promise<void> {
  const tmpFile = join(tmpdir(), `spawn_config_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpFile, content, { mode: 0o600 });

  const tempRemote = `/tmp/spawn_config_${Date.now()}`;
  try {
    await uploadFile(tmpFile, tempRemote);
    // Expand $HOME in remotePath on the remote side
    await runServer(
      `mkdir -p $(dirname "${remotePath}") && chmod 600 '${tempRemote}' && mv '${tempRemote}' "${remotePath}"`,
    );
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

async function installClaudeCode(): Promise<void> {
  logStep("Installing Claude Code...");

  // Batch the entire install into a single remote script to avoid multiple
  // round-trips that each risked 408 deadline_exceeded via fly machine exec.
  const claudePath = '$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin';
  const pathSetup = `for rc in ~/.bashrc ~/.zshrc; do grep -q '.claude/local/bin' "$rc" 2>/dev/null || printf '\\n# Claude Code PATH\\nexport PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"\\n' >> "$rc"; done`;
  const finalize = `claude install --force 2>/dev/null || true; ${pathSetup}`;

  const script = [
    `export PATH="${claudePath}:$PATH"`,
    // Clean up broken ~/.bash_profile from previous deployments
    `if [ -f ~/.bash_profile ] && grep -q 'spawn:env\\|Claude Code PATH\\|spawn:path' ~/.bash_profile 2>/dev/null; then rm -f ~/.bash_profile; fi`,
    // Already installed?
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    // Method 1: curl installer
    `echo "==> Installing Claude Code (method 1/2: curl installer)..."`,
    `curl -fsSL https://claude.ai/install.sh | bash || true`,
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    // Ensure Node.js for npm method (should already be installed by cloud-init)
    `if ! command -v node >/dev/null 2>&1; then apt-get update -y && apt-get install -y --no-install-recommends nodejs npm && npm install -g n && n 22 && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx || true; fi`,
    // Method 2: npm
    `echo "==> Installing Claude Code (method 2/2: npm)..."`,
    `npm install -g @anthropic-ai/claude-code || true`,
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    // All methods failed
    `exit 1`,
  ].join('\n');

  try {
    await runServer(script, 300);
    logInfo("Claude Code installed");
  } catch {
    logError("Claude Code installation failed");
    throw new Error("Claude Code install failed");
  }
}

function setupClaudeCodeConfig(apiKey: string): Promise<void> {
  return (async () => {
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
    // Inline base64 file writes in a single remote call instead of
    // separate mkdir + uploadFile + mv calls for each config file.
    const settingsB64 = Buffer.from(settingsJson).toString("base64");
    const stateB64 = Buffer.from(globalState).toString("base64");

    await runServer(
      `mkdir -p ~/.claude && printf '%s' '${settingsB64}' | base64 -d > ~/.claude/settings.json && chmod 600 ~/.claude/settings.json && printf '%s' '${stateB64}' | base64 -d > ~/.claude.json && chmod 600 ~/.claude.json && touch ~/.claude/CLAUDE.md`,
    );
    logInfo("Claude Code configured");
  })();
}

// ─── GitHub Auth ─────────────────────────────────────────────────────────────

let githubAuthRequested = false;
let githubToken = "";

async function promptGithubAuth(): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) return;
  process.stderr.write("\n");
  const choice = await prompt("Set up GitHub CLI (gh) on this machine? (y/N): ");
  if (/^[Yy]$/.test(choice)) {
    githubAuthRequested = true;
    // Capture local GitHub token
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

export async function offerGithubAuth(): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) return;
  if (!githubAuthRequested) return;

  let ghCmd = "curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/github-auth.sh | bash";
  let localTmpFile = "";
  if (githubToken) {
    const escaped = githubToken.replace(/'/g, "'\\''");
    // Write token to a local temp file with restricted permissions, then upload
    // to the remote machine. This prevents the token from appearing in process
    // argument lists (ps aux, /proc/*/cmdline) on either machine.
    localTmpFile = join(tmpdir(), `gh_token_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    writeFileSync(localTmpFile, `export GITHUB_TOKEN='${escaped}'`, { mode: 0o600 });
    const remoteTmpFile = `/tmp/gh_token_${Date.now()}`;
    try {
      await uploadFile(localTmpFile, remoteTmpFile);
      ghCmd = `. ${remoteTmpFile} && rm -f ${remoteTmpFile} && ${ghCmd}`;
    } catch {
      // Fallback: if upload fails, clean up and skip token injection
      try { unlinkSync(localTmpFile); } catch { /* ignore */ }
      localTmpFile = "";
    }
  }

  logStep("Installing and authenticating GitHub CLI...");
  try {
    await runServer(ghCmd);
  } catch {
    logWarn("GitHub CLI setup failed (non-fatal, continuing)");
  } finally {
    if (localTmpFile) {
      try { unlinkSync(localTmpFile); } catch { /* ignore */ }
    }
  }
}

// ─── Codex CLI Config ────────────────────────────────────────────────────────

async function setupCodexConfig(apiKey: string): Promise<void> {
  logStep("Configuring Codex CLI for OpenRouter...");
  const config = `model = "openai/gpt-5-codex"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "chat"
`;
  await uploadConfigFile(config, "$HOME/.codex/config.toml");
}

// ─── OpenClaw Config ─────────────────────────────────────────────────────────

async function setupOpenclawConfig(
  apiKey: string,
  modelId: string,
): Promise<void> {
  logStep("Configuring openclaw...");
  await runServer("mkdir -p ~/.openclaw");

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
  await uploadConfigFile(config, "$HOME/.openclaw/openclaw.json");
}

async function startGateway(): Promise<void> {
  logStep("Starting OpenClaw gateway daemon...");
  await runServer(
    `source ~/.spawnrc 2>/dev/null; export PATH=$(npm prefix -g 2>/dev/null)/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; ` +
    `if command -v setsid >/dev/null 2>&1; then setsid openclaw gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & ` +
    `else nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & fi`,
  );
  logInfo("OpenClaw gateway started");
}

// ─── OpenCode Install Command ────────────────────────────────────────────────

function openCodeInstallCmd(): string {
  return 'OC_ARCH=$(uname -m); case "$OC_ARCH" in aarch64) OC_ARCH=arm64;; x86_64) OC_ARCH=x64;; esac; OC_OS=$(uname -s | tr A-Z a-z); mkdir -p /tmp/opencode-install "$HOME/.opencode/bin" && curl -fsSL -o /tmp/opencode-install/oc.tar.gz "https://github.com/anomalyco/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz" && tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install && mv /tmp/opencode-install/opencode "$HOME/.opencode/bin/" && rm -rf /tmp/opencode-install && grep -q ".opencode/bin" "$HOME/.bashrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.bashrc"; grep -q ".opencode/bin" "$HOME/.zshrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.zshrc" 2>/dev/null; export PATH="$HOME/.opencode/bin:$PATH"';
}

// ─── Agent Definitions ───────────────────────────────────────────────────────

export const agents: Record<string, AgentConfig> = {
  claude: {
    name: "Claude Code",
    preProvision: promptGithubAuth,
    install: installClaudeCode,
    envVars: (apiKey) => [
      `OPENROUTER_API_KEY=${apiKey}`,
      "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
      `ANTHROPIC_AUTH_TOKEN=${apiKey}`,
      "ANTHROPIC_API_KEY=",
      "CLAUDE_CODE_SKIP_ONBOARDING=1",
      "CLAUDE_CODE_ENABLE_TELEMETRY=0",
    ],
    configure: (apiKey) => setupClaudeCodeConfig(apiKey),
    launchCmd: () =>
      "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude",
  },

  codex: {
    name: "Codex CLI",
    install: () => installAgent("Codex CLI", "npm install -g @openai/codex"),
    envVars: (apiKey) => [`OPENROUTER_API_KEY=${apiKey}`],
    configure: (apiKey) => setupCodexConfig(apiKey),
    launchCmd: () =>
      "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex",
  },

  openclaw: {
    name: "OpenClaw",
    modelPrompt: true,
    modelDefault: "openrouter/auto",
    install: () =>
      installAgent(
        "openclaw",
        'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" && bun install -g openclaw && command -v openclaw',
      ),
    envVars: (apiKey) => [
      `OPENROUTER_API_KEY=${apiKey}`,
      `ANTHROPIC_API_KEY=${apiKey}`,
      "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
    ],
    configure: (apiKey, modelId) =>
      setupOpenclawConfig(apiKey, modelId || "openrouter/auto"),
    preLaunch: startGateway,
    launchCmd: () =>
      "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; openclaw tui",
  },

  opencode: {
    name: "OpenCode",
    install: () => installAgent("OpenCode", openCodeInstallCmd()),
    envVars: (apiKey) => [`OPENROUTER_API_KEY=${apiKey}`],
    launchCmd: () =>
      "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; opencode",
  },

  kilocode: {
    name: "Kilo Code",
    install: () => installAgent("Kilo Code", "npm install -g @kilocode/cli"),
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
    install: () =>
      installAgent(
        "ZeroClaw",
        "curl -LsSf https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/install.sh | bash -s -- --install-rust --install-system-deps",
      ),
    envVars: (apiKey) => [
      `OPENROUTER_API_KEY=${apiKey}`,
      "ZEROCLAW_PROVIDER=openrouter",
    ],
    configure: async (apiKey) => {
      await runServer(
        `source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.cargo/bin:$PATH"; zeroclaw onboard --api-key "\${OPENROUTER_API_KEY}" --provider openrouter`,
      );
    },
    launchCmd: () =>
      "source ~/.cargo/env 2>/dev/null; source ~/.spawnrc 2>/dev/null; zeroclaw agent",
  },
};

export function resolveAgent(name: string): AgentConfig {
  const agent = agents[name.toLowerCase()];
  if (!agent) {
    logError(`Unknown agent: ${name}`);
    logError(`Available agents: ${Object.keys(agents).join(", ")}`);
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}

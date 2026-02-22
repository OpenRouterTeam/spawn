// local/agents.ts — Agent configs for local machine deployment

import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  jsonEscape,
} from "../shared/ui";
import { runLocal, uploadFile } from "./local";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  modelPrompt?: boolean;
  modelDefault?: string;
  install: () => Promise<void>;
  envVars: (apiKey: string) => string[];
  configure?: (apiKey: string, modelId?: string) => Promise<void>;
  preLaunch?: () => Promise<void>;
  launchCmd: () => string;
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

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
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      logError(`SECURITY: Invalid environment variable name rejected: ${key}`);
      continue;
    }
    const escaped = value.replace(/'/g, "'\\''");
    lines.push(`export ${key}='${escaped}'`);
  }
  return lines.join("\n") + "\n";
}

async function installAgent(agentName: string, installCmd: string): Promise<void> {
  logStep(`Installing ${agentName}...`);
  try {
    await runLocal(installCmd);
  } catch {
    logError(`${agentName} installation failed`);
    throw new Error(`${agentName} install failed`);
  }
  logInfo(`${agentName} installation completed`);
}

async function uploadConfigFile(
  content: string,
  localPath: string,
): Promise<void> {
  const tmpFile = join(tmpdir(), `spawn_config_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpFile, content, { mode: 0o600 });
  try {
    uploadFile(tmpFile, localPath);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

async function installClaudeCode(): Promise<void> {
  logStep("Installing Claude Code...");

  const claudePath = '$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin';
  const pathSetup = `for rc in ~/.bashrc ~/.zshrc; do grep -q '.claude/local/bin' "$rc" 2>/dev/null || printf '\\n# Claude Code PATH\\nexport PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"\\n' >> "$rc"; done`;
  const finalize = `claude install --force 2>/dev/null || true; ${pathSetup}`;

  const script = [
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `echo "==> Installing Claude Code (method 1/2: curl installer)..."`,
    `curl -fsSL https://claude.ai/install.sh | bash || true`,
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `echo "==> Installing Claude Code (method 2/2: npm)..."`,
    `npm install -g @anthropic-ai/claude-code || true`,
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `exit 1`,
  ].join('\n');

  try {
    await runLocal(script);
    logInfo("Claude Code installed");
  } catch {
    logError("Claude Code installation failed");
    throw new Error("Claude Code install failed");
  }
}

async function setupClaudeCodeConfig(apiKey: string): Promise<void> {
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

  await runLocal(
    `mkdir -p ~/.claude && touch ~/.claude/CLAUDE.md`,
  );
  await uploadConfigFile(settingsJson, "~/.claude/settings.json");
  await uploadConfigFile(globalState, "~/.claude.json");
  logInfo("Claude Code configured");
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
  await runLocal("mkdir -p ~/.codex");
  await uploadConfigFile(config, "~/.codex/config.toml");
}

// ─── OpenClaw Config ─────────────────────────────────────────────────────────

async function setupOpenclawConfig(
  apiKey: string,
  modelId: string,
): Promise<void> {
  logStep("Configuring openclaw...");
  await runLocal("mkdir -p ~/.openclaw");

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
  await uploadConfigFile(config, "~/.openclaw/openclaw.json");
}

async function startGateway(): Promise<void> {
  logStep("Starting OpenClaw gateway daemon...");
  await runLocal(
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
        'command -v bun &>/dev/null && bun install -g openclaw || npm install -g openclaw',
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
        "curl -LsSf https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/install.sh | bash -s -- --install-rust",
      ),
    envVars: (apiKey) => [
      `OPENROUTER_API_KEY=${apiKey}`,
      "ZEROCLAW_PROVIDER=openrouter",
    ],
    configure: async (apiKey) => {
      await runLocal(
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

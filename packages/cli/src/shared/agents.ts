// shared/agents.ts — AgentConfig interface + shared helpers (cloud-agnostic)

import { logError, shellQuote } from "./ui";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Cloud-init dependency tier: what packages to pre-install on the VM. */
export type CloudInitTier = "minimal" | "node" | "bun" | "full";

/** An optional post-provision setup step the user can toggle on/off. */
export interface OptionalStep {
  value: string;
  label: string;
  hint?: string;
  /** Env var that supplies data for this step (e.g. TELEGRAM_BOT_TOKEN). */
  dataEnvVar?: string;
  /** When true, step requires interactive input (e.g. QR scan) — skipped in headless. */
  interactive?: boolean;
}

export interface AgentConfig {
  name: string;
  /** Default model ID passed to configure() (no interactive prompt — override via MODEL_ID env var). */
  modelDefault?: string;
  /** Pre-provision hook (runs before server creation, e.g., prompt for GitHub auth). */
  preProvision?: () => Promise<void>;
  /** Install the agent on the remote machine. */
  install: () => Promise<void>;
  /** Return env var pairs for .spawnrc. */
  envVars: (apiKey: string) => string[];
  /** Agent-specific configuration (settings files, etc.). */
  configure?: (apiKey: string, modelId?: string, enabledSteps?: Set<string>) => Promise<void>;
  /** Pre-launch hook (e.g., start gateway daemon). */
  preLaunch?: () => Promise<void>;
  /** Optional tip or warning shown to the user just before the agent launches. */
  preLaunchMsg?: string;
  /** Shell command to launch the agent interactively. */
  launchCmd: () => string;
  /** Cloud-init dependency tier. Defaults to "full" if unset. */
  cloudInitTier?: CloudInitTier;
  /** Skip tarball install attempt (e.g., already using snapshot). */
  skipTarball?: boolean;
  /** SSH tunnel config for web dashboards. */
  tunnel?: TunnelConfig;
}

/** Configuration for SSH-tunneling a remote port to localhost. */
export interface TunnelConfig {
  remotePort: number;
  browserUrl?: (localPort: number) => string | undefined;
}

// ─── Agent Optional Steps (static metadata — no CloudRunner needed) ─────────

/** Extra setup steps for specific agents (merged with COMMON_STEPS). */
const AGENT_EXTRA_STEPS: Record<string, OptionalStep[]> = {
  openclaw: [
    {
      value: "browser",
      label: "Chrome browser",
      hint: "~400 MB — enables web tools",
    },
    {
      value: "telegram",
      label: "Telegram",
      hint: "connect via bot token from @BotFather",
      dataEnvVar: "TELEGRAM_BOT_TOKEN",
    },
  ],
};

/** Steps shown for every agent. */
const COMMON_STEPS: OptionalStep[] = [
  {
    value: "github",
    label: "GitHub CLI",
    hint: "install gh + authenticate on the remote server",
  },
  {
    value: "reuse-api-key",
    label: "Reuse saved OpenRouter key",
    hint: "off = create a fresh key via OAuth",
  },
];

/** Get the optional setup steps for a given agent (no CloudRunner required). */
export function getAgentOptionalSteps(agentName: string): OptionalStep[] {
  const extra = AGENT_EXTRA_STEPS[agentName];
  return extra
    ? [
        ...COMMON_STEPS,
        ...extra,
      ]
    : COMMON_STEPS;
}

/** Validate step names against the known steps for an agent.
 *  Returns valid and invalid step names separately. */
export function validateStepNames(
  agentName: string,
  steps: string[],
): {
  valid: string[];
  invalid: string[];
} {
  const known = new Set(getAgentOptionalSteps(agentName).map((s) => s.value));
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const step of steps) {
    if (known.has(step)) {
      valid.push(step);
    } else {
      invalid.push(step);
    }
  }
  return {
    valid,
    invalid,
  };
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
    "# Ensure agent binaries are in PATH on reconnect",
    'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.claude/local/bin:$PATH"',
  ];
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    // Validate env var name
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      logError(`SECURITY: Invalid environment variable name rejected: ${key}`);
      continue;
    }
    // Reject null bytes in value (defense-in-depth)
    if (/\0/.test(value)) {
      logError(`SECURITY: Null byte in environment variable value rejected: ${key}`);
      continue;
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return lines.join("\n") + "\n";
}

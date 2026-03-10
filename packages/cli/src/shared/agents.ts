// shared/agents.ts — AgentConfig interface + shared helpers (cloud-agnostic)

import { logError } from "./ui";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Cloud-init dependency tier: what packages to pre-install on the VM. */
export type CloudInitTier = "minimal" | "node" | "bun" | "full";

/** An optional post-provision setup step the user can toggle on/off. */
export interface OptionalStep {
  value: string;
  label: string;
  hint?: string;
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

/** Optional setup steps for each agent, keyed by agent name. */
const AGENT_OPTIONAL_STEPS: Record<string, OptionalStep[]> = {
  openclaw: [
    {
      value: "github",
      label: "GitHub CLI",
    },
    {
      value: "browser",
      label: "Chrome browser",
      hint: "~400 MB — enables web tools",
    },
  ],
};

const DEFAULT_OPTIONAL_STEPS: OptionalStep[] = [
  {
    value: "github",
    label: "GitHub CLI",
  },
];

/** Get the optional setup steps for a given agent (no CloudRunner required). */
export function getAgentOptionalSteps(agentName: string): OptionalStep[] {
  return AGENT_OPTIONAL_STEPS[agentName] ?? DEFAULT_OPTIONAL_STEPS;
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
    // Escape single quotes in value
    const escaped = value.replace(/'/g, "'\\''");
    lines.push(`export ${key}='${escaped}'`);
  }
  return lines.join("\n") + "\n";
}

// shared/agents.ts — AgentConfig interface + shared helpers (cloud-agnostic)

import { logError } from "./ui";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Cloud-init dependency tier: what packages to pre-install on the VM. */
export type CloudInitTier = "minimal" | "node" | "bun" | "full";

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
  /**
   * Batched setup: install + env + configure in a single SSH session.
   * When provided, orchestrate.ts calls this instead of the separate install / env / configure steps.
   */
  setup?: (envContent: string, apiKey: string, modelId?: string) => Promise<void>;
  /** Pre-launch hook (e.g., start gateway daemon). */
  preLaunch?: () => Promise<void>;
  /** Shell command to launch the agent interactively. */
  launchCmd: () => string;
  /** Cloud-init dependency tier. Defaults to "full" if unset. */
  cloudInitTier?: CloudInitTier;
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

// shared/cloud-init.ts — Tier-based cloud-init package selection

import type { CloudInitTier } from "./agents.js";

const MINIMAL = [
  "curl",
  "unzip",
  "git",
  "ca-certificates",
];

export function getPackagesForTier(tier: CloudInitTier = "full"): string[] {
  switch (tier) {
    case "minimal":
      return [
        ...MINIMAL,
      ];
    case "node":
      return [
        ...MINIMAL,
        "zsh",
        "build-essential",
      ];
    case "bun":
      return [
        ...MINIMAL,
        "zsh",
      ];
    case "full":
      return [
        ...MINIMAL,
        "zsh",
        "build-essential",
      ];
  }
}

/** Node 22 install via `n` bootstrapped directly from curl (no apt nodejs/npm). */
export const NODE_INSTALL_CMD =
  "curl --proto '=https' -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s install 22";

export function needsNode(tier: CloudInitTier = "full"): boolean {
  return tier === "node" || tier === "full";
}

export function needsBun(tier: CloudInitTier = "full"): boolean {
  return tier === "bun" || tier === "full";
}

/**
 * Determines whether cloud-init wait should be skipped in favor of SSH-only wait.
 * Extracted from the inline condition in hetzner/main.ts and gcp/main.ts.
 */
export function shouldSkipCloudInit(opts: {
  useDocker: boolean;
  snapshotId?: string | null | undefined;
  skipCloudInit?: boolean;
}): boolean {
  return opts.useDocker || opts.snapshotId != null || (opts.skipCloudInit ?? false);
}

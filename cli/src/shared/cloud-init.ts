// shared/cloud-init.ts — Tier-based cloud-init package selection

import type { CloudInitTier } from "./agents";

const MINIMAL = ["curl", "unzip", "git", "ca-certificates"];

export function getPackagesForTier(tier: CloudInitTier = "full"): string[] {
  switch (tier) {
    case "minimal": return [...MINIMAL];
    case "node":    return [...MINIMAL, "zsh", "nodejs", "npm", "build-essential"];
    case "bun":     return [...MINIMAL, "zsh"];
    case "full":    return [...MINIMAL, "zsh", "nodejs", "npm", "build-essential"];
  }
}

export function needsNodeUpgrade(tier: CloudInitTier = "full"): boolean {
  return tier === "node" || tier === "full";
}

export function needsBun(tier: CloudInitTier = "full"): boolean {
  return tier === "bun" || tier === "full";
}

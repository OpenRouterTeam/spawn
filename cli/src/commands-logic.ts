/**
 * Core command logic separated from side effects for testability.
 * This module exports pure functions that operate on data without
 * direct I/O or process spawning.
 */

import type { Manifest } from "./manifest.js";
import { agentKeys, cloudKeys, matrixStatus } from "./manifest.js";

/**
 * Get all clouds that have an implementation for a given agent
 */
export function getImplementedClouds(manifest: Manifest, agent: string): string[] {
  return cloudKeys(manifest).filter(
    (c: string): boolean => matrixStatus(manifest, c, agent) === "implemented"
  );
}

/**
 * Validate that an agent exists in the manifest
 */
export function validateAgentExists(manifest: Manifest, agent: string): boolean {
  return !!manifest.agents[agent];
}

/**
 * Validate that a cloud exists in the manifest
 */
export function validateCloudExists(manifest: Manifest, cloud: string): boolean {
  return !!manifest.clouds[cloud];
}

/**
 * Validate that an agent/cloud combination is implemented
 */
export function validateImplementation(
  manifest: Manifest,
  cloud: string,
  agent: string
): boolean {
  return matrixStatus(manifest, cloud, agent) === "implemented";
}

/**
 * Map agent/cloud keys to display options
 */
export function mapToSelectOptions<T extends { name: string; description: string }>(
  keys: string[],
  items: Record<string, T>
): Array<{ value: string; label: string; hint: string }> {
  return keys.map((key) => ({
    value: key,
    label: items[key].name,
    hint: items[key].description,
  }));
}

/**
 * Calculate column width for matrix display
 */
export function calculateColumnWidth(items: string[], minWidth: number, padding: number): number {
  let maxWidth = minWidth;
  for (const item of items) {
    const width = item.length + padding;
    if (width > maxWidth) {
      maxWidth = width;
    }
  }
  return maxWidth;
}

/**
 * Determine agent column width for matrix display
 */
export function calculateAgentColumnWidth(
  manifest: Manifest,
  agents: string[],
  minWidth: number,
  padding: number
): number {
  let width = minWidth;
  for (const a of agents) {
    const agentNameWidth = manifest.agents[a].name.length + padding;
    if (agentNameWidth > width) {
      width = agentNameWidth;
    }
  }
  return width;
}

/**
 * Determine cloud column width for matrix display
 */
export function calculateCloudColumnWidth(
  manifest: Manifest,
  clouds: string[],
  minWidth: number,
  padding: number
): number {
  let width = minWidth;
  for (const c of clouds) {
    const cloudNameWidth = manifest.clouds[c].name.length + padding;
    if (cloudNameWidth > width) {
      width = cloudNameWidth;
    }
  }
  return width;
}

/**
 * Get the implementation status of a cloud/agent combination
 */
export function getStatus(manifest: Manifest, cloud: string, agent: string): string {
  return matrixStatus(manifest, cloud, agent);
}

/**
 * Check if a manifest has any implemented combinations
 */
export function hasImplementedCombinations(manifest: Manifest): boolean {
  return Object.values(manifest.matrix).some((status) => status === "implemented");
}

/**
 * Get list of agents with at least one implementation
 */
export function getAgentsWithImplementations(manifest: Manifest): string[] {
  const agents = agentKeys(manifest);
  return agents.filter((agent) => getImplementedClouds(manifest, agent).length > 0);
}

/**
 * Get list of clouds with at least one implementation
 */
export function getCloudsWithImplementations(manifest: Manifest): string[] {
  const clouds = cloudKeys(manifest);
  return clouds.filter((cloud) =>
    agentKeys(manifest).some((agent) => matrixStatus(manifest, cloud, agent) === "implemented")
  );
}

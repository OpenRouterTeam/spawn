import type { Manifest } from "../manifest.js";

import pc from "picocolors";
import { agentKeys, cloudKeys, countImplemented, matrixStatus } from "../manifest.js";
import {
  getImplementedAgents,
  getImplementedClouds,
  groupByType,
  hasCloudCredentials,
  loadManifestWithSpinner,
  NAME_COLUMN_WIDTH,
  parseAuthEnvVars,
  printGroupedList,
  printInfoHeader,
  printQuickStart,
  prioritizeCloudsByCredentials,
  validateAndGetEntity,
} from "./shared.js";

// ── Matrix display ───────────────────────────────────────────────────────────

const MIN_AGENT_COL_WIDTH = 16;
const MIN_CLOUD_COL_WIDTH = 10;
const COL_PADDING = 2;
const COMPACT_NAME_WIDTH = 20;
const COMPACT_COUNT_WIDTH = 10;
const COMPACT_READY_WIDTH = 10;

export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

export function calculateColumnWidth(items: string[], minWidth: number): number {
  let maxWidth = minWidth;
  for (const item of items) {
    const width = item.length + COL_PADDING;
    if (width > maxWidth) {
      maxWidth = width;
    }
  }
  return maxWidth;
}

function renderMatrixHeader(
  clouds: string[],
  manifest: Manifest,
  agentColWidth: number,
  cloudColWidth: number,
): string {
  let header = "".padEnd(agentColWidth);
  for (const c of clouds) {
    header += pc.bold(manifest.clouds[c].name.padEnd(cloudColWidth));
  }
  return header;
}

function renderMatrixSeparator(clouds: string[], agentColWidth: number, cloudColWidth: number): string {
  let sep = "".padEnd(agentColWidth);
  for (const _ of clouds) {
    sep += pc.dim("-".repeat(cloudColWidth - COL_PADDING) + "  ");
  }
  return sep;
}

function renderMatrixRow(
  agent: string,
  clouds: string[],
  manifest: Manifest,
  agentColWidth: number,
  cloudColWidth: number,
): string {
  let row = pc.bold(manifest.agents[agent].name.padEnd(agentColWidth));
  for (const c of clouds) {
    const status = matrixStatus(manifest, c, agent);
    const icon = status === "implemented" ? "  +" : "  -";
    const colorFn = status === "implemented" ? pc.green : pc.dim;
    row += colorFn(icon.padEnd(cloudColWidth));
  }
  return row;
}

export function getMissingClouds(manifest: Manifest, agent: string, clouds: string[]): string[] {
  return clouds.filter((c) => matrixStatus(manifest, c, agent) !== "implemented");
}

function buildCompactListHeader(): string {
  return (
    pc.bold("Agent".padEnd(COMPACT_NAME_WIDTH)) +
    pc.bold("Clouds".padEnd(COMPACT_COUNT_WIDTH)) +
    pc.bold("Ready".padEnd(COMPACT_READY_WIDTH)) +
    pc.bold("Not yet available")
  );
}

function buildCompactListSeparator(): string {
  return pc.dim("-".repeat(COMPACT_NAME_WIDTH + COMPACT_COUNT_WIDTH + COMPACT_READY_WIDTH + 30));
}

function buildCompactListRow(manifest: Manifest, agent: string, clouds: string[]): string {
  const implClouds = getImplementedClouds(manifest, agent);
  const missing = getMissingClouds(manifest, agent, clouds);
  const countStr = `${implClouds.length}/${clouds.length}`;
  const colorFn = implClouds.length === clouds.length ? pc.green : pc.yellow;
  const readyCount = implClouds.filter((c) => hasCloudCredentials(manifest.clouds[c].auth)).length;
  const readyStr = readyCount > 0 ? pc.green(`${readyCount}`) : pc.dim("0");

  let line = pc.bold(manifest.agents[agent].name.padEnd(COMPACT_NAME_WIDTH));
  line += colorFn(countStr.padEnd(COMPACT_COUNT_WIDTH));
  line += readyStr + " ".repeat(COMPACT_READY_WIDTH - String(readyCount).length);

  if (missing.length === 0) {
    line += pc.green("-- all clouds supported");
  } else {
    line += pc.dim(missing.map((c) => manifest.clouds[c].name).join(", "));
  }

  return line;
}

function renderCompactList(manifest: Manifest, agents: string[], clouds: string[]): void {
  console.log();
  console.log(buildCompactListHeader());
  console.log(buildCompactListSeparator());

  for (const a of agents) {
    console.log(buildCompactListRow(manifest, a, clouds));
  }
}

function renderMatrixFooter(manifest: Manifest, agents: string[], clouds: string[], isCompact: boolean): void {
  const impl = countImplemented(manifest);
  const total = agents.length * clouds.length;
  console.log();
  if (isCompact) {
    console.log(`${pc.green("green")} = all clouds supported  ${pc.yellow("yellow")} = some clouds not yet available`);
    console.log(`${pc.bold("Ready")} = clouds where your credentials are detected`);
  } else {
    console.log(`${pc.green("+")} implemented  ${pc.dim("-")} not yet available`);
  }
  console.log(pc.green(`${impl}/${total} combinations implemented`));
  console.log(
    pc.dim(
      `Launch: ${pc.cyan("spawn <agent> <cloud>")}  |  Details: ${pc.cyan("spawn <agent>")} or ${pc.cyan("spawn <cloud>")}`,
    ),
  );
  console.log();
}

export async function cmdMatrix(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const agents = agentKeys(manifest);
  const clouds = cloudKeys(manifest);

  // Calculate column widths for grid view
  const agentColWidth = calculateColumnWidth(
    agents.map((a) => manifest.agents[a].name),
    MIN_AGENT_COL_WIDTH,
  );
  const cloudColWidth = calculateColumnWidth(
    clouds.map((c) => manifest.clouds[c].name),
    MIN_CLOUD_COL_WIDTH,
  );

  const gridWidth = agentColWidth + clouds.length * cloudColWidth;
  const termWidth = getTerminalWidth();

  // Use compact view if grid would be wider than the terminal
  const isCompact = gridWidth > termWidth;

  console.log();
  console.log(pc.bold("Availability Matrix") + pc.dim(` (${agents.length} agents, ${clouds.length} clouds)`));

  if (isCompact) {
    renderCompactList(manifest, agents, clouds);
  } else {
    console.log();
    console.log(renderMatrixHeader(clouds, manifest, agentColWidth, cloudColWidth));
    console.log(renderMatrixSeparator(clouds, agentColWidth, cloudColWidth));

    for (const a of agents) {
      console.log(renderMatrixRow(a, clouds, manifest, agentColWidth, cloudColWidth));
    }
  }

  renderMatrixFooter(manifest, agents, clouds, isCompact);
}

// ── Agent/Cloud lists ────────────────────────────────────────────────────────

export async function cmdAgents(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const allAgents = agentKeys(manifest);
  let totalReady = 0;
  console.log();
  console.log(pc.bold("Agents") + pc.dim(` (${allAgents.length} total)`));
  console.log();
  for (const key of allAgents) {
    const a = manifest.agents[key];
    const implClouds = getImplementedClouds(manifest, key);
    const readyCount = implClouds.filter((c) => hasCloudCredentials(manifest.clouds[c].auth)).length;
    if (readyCount > 0) {
      totalReady++;
    }
    const cloudStr = `${implClouds.length} cloud${implClouds.length !== 1 ? "s" : ""}`;
    const readyStr = readyCount > 0 ? `  ${pc.green(`${readyCount} ready`)}` : "";
    console.log(
      `  ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${a.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${cloudStr}  ${a.description}`)}${readyStr}`,
    );
  }
  console.log();
  if (totalReady > 0) {
    console.log(pc.dim(`  ${pc.green("ready")} = credentials detected for at least one cloud`));
  }
  console.log(
    pc.dim(`  Run ${pc.cyan("spawn <agent>")} for details, or ${pc.cyan("spawn <agent> <cloud>")} to launch.`),
  );
  console.log();
}

/** Format credential status indicator for a cloud in the list view */
function formatCredentialIndicatorLocal(auth: string): string {
  if (auth.toLowerCase() === "none") {
    return "";
  }
  return hasCloudCredentials(auth) ? `  ${pc.green("ready")}` : `  ${pc.yellow("needs")} ${pc.dim(auth)}`;
}

export async function cmdClouds(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const allAgents = agentKeys(manifest);
  const allClouds = cloudKeys(manifest);

  const byType = groupByType(allClouds, (key) => manifest.clouds[key].type);

  console.log();
  console.log(pc.bold("Cloud Providers") + pc.dim(` (${allClouds.length} total)`));

  let credCount = 0;
  for (const [type, keys] of Object.entries(byType)) {
    console.log();
    console.log(`  ${pc.dim(type)}`);
    for (const key of keys) {
      const c = manifest.clouds[key];
      const implCount = getImplementedAgents(manifest, key).length;
      const countStr = `${implCount}/${allAgents.length}`;
      if (hasCloudCredentials(c.auth)) {
        credCount++;
      }
      const credIndicator = formatCredentialIndicatorLocal(c.auth);
      console.log(
        `    ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${c.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.bold((c.price ?? "").padEnd(16))} ${pc.dim(`${countStr.padEnd(6)} ${c.description}`)}${credIndicator}`,
      );
    }
  }
  console.log();
  if (credCount > 0) {
    console.log(pc.dim(`  ${pc.green("ready")} = credentials detected  ${pc.yellow("needs")} = credentials not set`));
  } else {
    console.log(
      pc.dim(`  ${pc.yellow("needs")} = credentials not set (run ${pc.cyan("spawn <cloud>")} for setup instructions)`),
    );
  }
  console.log(
    pc.dim(
      `  Run ${pc.cyan("spawn <cloud>")} for setup instructions, or ${pc.cyan("spawn <agent> <cloud>")} to launch.`,
    ),
  );
  console.log();
}

// ── Agent Info ───────────────────────────────────────────────────────────────

function buildCloudCommandHint(agentKey: string, cloudKey: string, manifest: Manifest): string {
  const hint = `spawn ${agentKey} ${cloudKey}`;
  return hasCloudCredentials(manifest.clouds[cloudKey].auth) ? `${hint}  ${pc.green("(credentials detected)")}` : hint;
}

function printAgentCloudsList(
  sortedClouds: string[],
  manifest: Manifest,
  agentKey: string,
  allClouds: string[],
  credCount: number,
): void {
  console.log();
  console.log(pc.bold("Available clouds:") + pc.dim(` ${sortedClouds.length} of ${allClouds.length}`));
  if (credCount > 0) {
    console.log(pc.dim(`  ${credCount} cloud${credCount > 1 ? "s" : ""} with credentials detected (shown first)`));
  }
  console.log();

  if (sortedClouds.length === 0) {
    console.log(pc.dim("  No implemented clouds yet."));
    console.log();
    return;
  }

  const byType = groupByType(sortedClouds, (c) => manifest.clouds[c].type);
  printGroupedList(
    byType,
    (c) => manifest.clouds[c].name,
    (c) => buildCloudCommandHint(agentKey, c, manifest),
  );
  console.log();
}

export async function cmdAgentInfo(agent: string, preloadedManifest?: Manifest): Promise<void> {
  const [manifest, agentKey] = preloadedManifest
    ? [
        preloadedManifest,
        agent,
      ]
    : await validateAndGetEntity(agent, "agent");

  const agentDef = manifest.agents[agentKey];
  printInfoHeader(agentDef);
  if (agentDef.install) {
    console.log(pc.dim(`  Install: ${agentDef.install}`));
  }

  const allClouds = cloudKeys(manifest);
  const implClouds = getImplementedClouds(manifest, agentKey);

  // Prioritize clouds where the user already has credentials
  const { sortedClouds, credCount } = prioritizeCloudsByCredentials(implClouds, manifest);

  if (sortedClouds.length > 0) {
    const exampleCloud = sortedClouds[0];
    const cloudDef = manifest.clouds[exampleCloud];
    printQuickStart({
      auth: cloudDef.auth,
      authVars: parseAuthEnvVars(cloudDef.auth),
      cloudUrl: cloudDef.url,
      spawnCmd: `spawn ${agentKey} ${exampleCloud}`,
    });
  }

  printAgentCloudsList(sortedClouds, manifest, agentKey, allClouds, credCount);
}

// ── Cloud Info ───────────────────────────────────────────────────────────────

/** Print the list of implemented agents and any missing ones */
function printAgentList(manifest: Manifest, implAgents: string[], missingAgents: string[], cloudKey: string): void {
  if (implAgents.length === 0) {
    console.log(pc.dim("  No implemented agents yet."));
  } else {
    for (const agent of implAgents) {
      const a = manifest.agents[agent];
      console.log(
        `  ${pc.green(agent.padEnd(NAME_COLUMN_WIDTH))} ${a.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim("spawn " + agent + " " + cloudKey)}`,
      );
    }
  }

  if (missingAgents.length > 0 && missingAgents.length <= 5) {
    console.log();
    console.log(pc.dim(`  Not yet available: ${missingAgents.map((a) => manifest.agents[a].name).join(", ")}`));
  }
}

export async function cmdCloudInfo(cloud: string, preloadedManifest?: Manifest): Promise<void> {
  const [manifest, cloudKey] = preloadedManifest
    ? [
        preloadedManifest,
        cloud,
      ]
    : await validateAndGetEntity(cloud, "cloud");

  const c = manifest.clouds[cloudKey];
  printInfoHeader(c);
  if (c.price) {
    console.log(`  ${pc.bold(c.price)}`);
  }
  const credStatus = hasCloudCredentials(c.auth) ? pc.green("credentials detected") : pc.dim("no credentials set");
  console.log(pc.dim(`  Type: ${c.type}  |  Auth: ${c.auth}  |  `) + credStatus);

  const authVars = parseAuthEnvVars(c.auth);
  const implAgents = getImplementedAgents(manifest, cloudKey);
  const exampleAgent = implAgents[0];
  printQuickStart({
    auth: c.auth,
    authVars,
    cloudUrl: c.url,
    spawnCmd: exampleAgent ? `spawn ${exampleAgent} ${cloudKey}` : undefined,
  });

  const allAgents = agentKeys(manifest);
  const missingAgents = allAgents.filter((a) => !implAgents.includes(a));
  console.log();
  console.log(pc.bold("Available agents:") + pc.dim(` ${implAgents.length} of ${allAgents.length}`));
  console.log();

  printAgentList(manifest, implAgents, missingAgents, cloudKey);

  const { REPO } = await import("../manifest.js");
  console.log();
  console.log(pc.dim(`  Full setup guide: ${pc.cyan(`https://github.com/${REPO}/tree/main/sh/${cloudKey}`)}`));
  console.log();
}

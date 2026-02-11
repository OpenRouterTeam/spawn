import "./unicode-detect.js"; // Must be first: configures TERM before clack reads it
import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "child_process";
import {
  loadManifest,
  agentKeys,
  cloudKeys,
  matrixStatus,
  countImplemented,
  RAW_BASE,
  REPO,
  type Manifest,
} from "./manifest.js";
import pkg from "../package.json" with { type: "json" };
const VERSION = pkg.version;
import { validateIdentifier, validateScriptContent, validatePrompt } from "./security.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 10_000; // 10 seconds

export function getErrorMessage(err: unknown): string {
  // Use duck typing instead of instanceof to avoid prototype chain issues
  return err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
}

function handleCancel(): never {
  console.error(pc.red("Operation cancelled."));
  process.exit(0);
}

async function withSpinner<T>(msg: string, fn: () => Promise<T>, doneMsg?: string): Promise<T> {
  const s = p.spinner();
  s.start(msg);
  try {
    const result = await fn();
    s.stop(doneMsg ?? msg.replace(/\.{3}$/, ""));
    return result;
  } catch (err) {
    s.stop(pc.red("Failed"));
    throw err;
  }
}

async function loadManifestWithSpinner(): Promise<Manifest> {
  return withSpinner("Loading manifest...", loadManifest);
}

function validateNonEmptyString(value: string, fieldName: string, helpCommand: string): void {
  if (!value || value.trim() === "") {
    p.log.error(`${fieldName} is required but was not provided`);
    p.log.info(`Run ${pc.cyan(helpCommand)} to see all available ${fieldName.toLowerCase()}s.`);
    process.exit(1);
  }
}

function errorMessage(message: string): never {
  p.log.error(message);
  process.exit(1);
}

function mapToSelectOptions<T extends { name: string; description: string }>(
  keys: string[],
  items: Record<string, T>
): Array<{ value: string; label: string; hint: string }> {
  return keys.map((key) => ({
    value: key,
    label: items[key].name,
    hint: items[key].description,
  }));
}

export function getImplementedClouds(manifest: Manifest, agent: string): string[] {
  return cloudKeys(manifest).filter(
    (c: string): boolean => matrixStatus(manifest, c, agent) === "implemented"
  );
}

/** Levenshtein distance between two strings */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Find the closest match from a list of candidates (max distance 3) */
export function findClosestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= 3 ? best : null;
}

/**
 * Resolve user input to a valid agent key.
 * Tries: exact key -> case-insensitive key -> display name match (case-insensitive).
 * Returns the key if found, or null.
 */
export function resolveAgentKey(manifest: Manifest, input: string): string | null {
  if (manifest.agents[input]) return input;
  const lower = input.toLowerCase();
  for (const key of agentKeys(manifest)) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of agentKeys(manifest)) {
    if (manifest.agents[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

/**
 * Resolve user input to a valid cloud key.
 * Tries: exact key -> case-insensitive key -> display name match (case-insensitive).
 * Returns the key if found, or null.
 */
export function resolveCloudKey(manifest: Manifest, input: string): string | null {
  if (manifest.clouds[input]) return input;
  const lower = input.toLowerCase();
  for (const key of cloudKeys(manifest)) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of cloudKeys(manifest)) {
    if (manifest.clouds[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

function validateAgent(manifest: Manifest, agent: string): asserts agent is keyof typeof manifest.agents {
  if (!manifest.agents[agent]) {
    p.log.error(`Unknown agent: ${pc.bold(agent)}`);
    const keys = agentKeys(manifest);
    const suggestion = findClosestMatch(agent, keys);
    const nameSuggestion = findClosestMatch(agent, keys.map((k) => manifest.agents[k].name));
    if (suggestion) {
      p.log.info(`Did you mean ${pc.cyan(suggestion)}?`);
    } else if (nameSuggestion) {
      // Find the key for the matched display name
      const matchedKey = keys.find((k) => manifest.agents[k].name === nameSuggestion);
      if (matchedKey) {
        p.log.info(`Did you mean ${pc.cyan(matchedKey)} (${nameSuggestion})?`);
      }
    }
    p.log.info(`Run ${pc.cyan("spawn agents")} to see available agents.`);
    process.exit(1);
  }
}

// Validate and load agent - consolidates the pattern used by cmdRun and cmdAgentInfo
async function validateAndGetAgent(agent: string): Promise<[manifest: Manifest, agentKey: string]> {
  try {
    validateIdentifier(agent, "Agent name");
  } catch (err) {
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  validateNonEmptyString(agent, "Agent name", "spawn agents");
  const manifest = await loadManifestWithSpinner();
  validateAgent(manifest, agent);

  return [manifest, agent];
}

function validateCloud(manifest: Manifest, cloud: string): asserts cloud is keyof typeof manifest.clouds {
  if (!manifest.clouds[cloud]) {
    p.log.error(`Unknown cloud: ${pc.bold(cloud)}`);
    const keys = cloudKeys(manifest);
    const suggestion = findClosestMatch(cloud, keys);
    const nameSuggestion = findClosestMatch(cloud, keys.map((k) => manifest.clouds[k].name));
    if (suggestion) {
      p.log.info(`Did you mean ${pc.cyan(suggestion)}?`);
    } else if (nameSuggestion) {
      // Find the key for the matched display name
      const matchedKey = keys.find((k) => manifest.clouds[k].name === nameSuggestion);
      if (matchedKey) {
        p.log.info(`Did you mean ${pc.cyan(matchedKey)} (${nameSuggestion})?`);
      }
    }
    p.log.info(`Run ${pc.cyan("spawn clouds")} to see available clouds.`);
    process.exit(1);
  }
}

function validateImplementation(manifest: Manifest, cloud: string, agent: string): void {
  const status = matrixStatus(manifest, cloud, agent);
  if (status !== "implemented") {
    const agentName = manifest.agents[agent].name;
    const cloudName = manifest.clouds[cloud].name;
    p.log.error(`${agentName} on ${cloudName} is not yet implemented.`);

    const availableClouds = getImplementedClouds(manifest, agent);
    if (availableClouds.length > 0) {
      const examples = availableClouds.slice(0, 3).map((c) => `spawn ${agent} ${c}`);
      p.log.info(`${agentName} is available on ${availableClouds.length} cloud${availableClouds.length > 1 ? "s" : ""}. Try one of these instead:`);
      for (const cmd of examples) {
        p.log.info(`  ${pc.cyan(cmd)}`);
      }
      if (availableClouds.length > 3) {
        p.log.info(`Run ${pc.cyan(`spawn ${agent}`)} to see all ${availableClouds.length} options.`);
      }
    } else {
      p.log.info(`This agent has no implemented cloud providers yet.`);
      p.log.info(`Run ${pc.cyan("spawn list")} to see the full availability matrix.`);
    }
    process.exit(1);
  }
}

// ── Interactive ────────────────────────────────────────────────────────────────

export async function cmdInteractive(): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  const manifest = await loadManifestWithSpinner();

  const agents = agentKeys(manifest);
  const agentChoice = await p.select({
    message: "Select an agent",
    options: mapToSelectOptions(agents, manifest.agents),
  });
  if (p.isCancel(agentChoice)) handleCancel();

  const clouds = getImplementedClouds(manifest, agentChoice);

  if (clouds.length === 0) {
    p.log.error(`No clouds available for ${manifest.agents[agentChoice].name}`);
    p.log.info(`This agent has no implemented cloud providers yet.`);
    p.log.info(`Run ${pc.cyan("spawn list")} to see the full availability matrix.`);
    process.exit(1);
  }

  const cloudChoice = await p.select({
    message: "Select a cloud provider",
    options: mapToSelectOptions(clouds, manifest.clouds),
  });
  if (p.isCancel(cloudChoice)) handleCancel();

  const agentName = manifest.agents[agentChoice].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${agentChoice} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");

  await execScript(cloudChoice, agentChoice);
}

// ── Run ────────────────────────────────────────────────────────────────────────

export async function cmdRun(agent: string, cloud: string, prompt?: string): Promise<void> {
  // Try to resolve display names / casing before strict validation
  const manifest = await loadManifestWithSpinner();
  const resolvedAgent = resolveAgentKey(manifest, agent);
  const resolvedCloud = resolveCloudKey(manifest, cloud);
  if (resolvedAgent && resolvedAgent !== agent) {
    p.log.info(`Resolved "${agent}" to ${pc.cyan(resolvedAgent)}`);
    agent = resolvedAgent;
  }
  if (resolvedCloud && resolvedCloud !== cloud) {
    p.log.info(`Resolved "${cloud}" to ${pc.cyan(resolvedCloud)}`);
    cloud = resolvedCloud;
  }

  // SECURITY: Validate input arguments for injection attacks
  try {
    validateIdentifier(agent, "Agent name");
    validateIdentifier(cloud, "Cloud name");
    if (prompt) {
      validatePrompt(prompt);
    }
  } catch (err) {
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  validateNonEmptyString(agent, "Agent name", "spawn agents");
  validateNonEmptyString(cloud, "Cloud name", "spawn clouds");

  // Detect swapped arguments: user typed "spawn <cloud> <agent>" instead of "spawn <agent> <cloud>"
  if (!manifest.agents[agent] && manifest.clouds[agent] && manifest.agents[cloud]) {
    p.log.warn(`It looks like you swapped the agent and cloud arguments.`);
    p.log.info(`Running: ${pc.cyan(`spawn ${cloud} ${agent}`)}`);
    const tmp = agent;
    agent = cloud;
    cloud = tmp;
  }

  validateAgent(manifest, agent);
  validateCloud(manifest, cloud);
  validateImplementation(manifest, cloud, agent);

  const agentName = manifest.agents[agent].name;
  const cloudName = manifest.clouds[cloud].name;

  if (prompt) {
    p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)} with prompt...`);
  } else {
    p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}...`);
  }

  await execScript(cloud, agent, prompt);
}

export function getStatusDescription(status: number): string {
  return status === 404 ? "not found" : `HTTP ${status}`;
}

async function downloadScriptWithFallback(primaryUrl: string, fallbackUrl: string): Promise<string> {
  const s = p.spinner();
  s.start("Downloading spawn script...");

  try {
    const res = await fetch(primaryUrl);
    if (res.ok) {
      s.stop("Script downloaded");
      return res.text();
    }

    // Fallback to GitHub raw
    s.message("Trying fallback source...");
    const ghRes = await fetch(fallbackUrl);
    if (!ghRes.ok) {
      s.stop(pc.red("Download failed"));
      reportDownloadFailure(primaryUrl, fallbackUrl, res.status, ghRes.status);
      process.exit(1);
    }
    s.stop("Script downloaded (fallback)");
    return ghRes.text();
  } catch (err) {
    s.stop(pc.red("Download failed"));
    throw err;
  }
}

function reportDownloadFailure(primaryUrl: string, fallbackUrl: string, primaryStatus: number, fallbackStatus: number): void {
  p.log.error("Script download failed");
  console.error(`\nPrimary source (${primaryUrl}): ${getStatusDescription(primaryStatus)}`);
  console.error(`Fallback source (${fallbackUrl}): ${getStatusDescription(fallbackStatus)}`);

  if (primaryStatus === 404 && fallbackStatus === 404) {
    console.error("\nThis agent + cloud combination doesn't exist yet.");
    console.error(`\nWhat to do:`);
    console.error(`  1. Check the matrix: ${pc.cyan("spawn list")}`);
    console.error(`  2. Verify the combination is implemented (marked with +)`);
    console.error(`  3. Check for typos in agent or cloud name`);
  } else {
    console.error(`\nNetwork or server error - try again in a few moments.`);
  }
}

async function execScript(cloud: string, agent: string, prompt?: string): Promise<void> {
  const url = `https://openrouter.ai/lab/spawn/${cloud}/${agent}.sh`;
  const ghUrl = `${RAW_BASE}/${cloud}/${agent}.sh`;

  let scriptContent: string;
  try {
    scriptContent = await downloadScriptWithFallback(url, ghUrl);
  } catch (err) {
    p.log.error("Failed to download spawn script");
    console.error("\nError:", getErrorMessage(err));
    console.error("\nTroubleshooting:");
    console.error(`  1. Verify this combination exists: ${pc.cyan("spawn list")}`);
    console.error("  2. Check your internet connection");
    console.error(`  3. Try accessing the script directly: ${ghUrl}`);
    process.exit(1);
  }

  try {
    await runBash(scriptContent, prompt);
  } catch (err) {
    const errMsg = getErrorMessage(err);
    if (errMsg.includes("interrupted by user")) {
      // User pressed Ctrl+C - exit silently
      process.exit(130);
    }
    p.log.error("Spawn script failed");
    console.error("\nError:", errMsg);
    console.error("\nCommon causes:");
    console.error("  - Missing cloud provider credentials (API key, token, etc.)");
    console.error("  - Cloud provider API rate limit or quota exceeded");
    console.error("  - Missing local dependencies (SSH, curl, etc.)");
    console.error(`\nCheck the cloud provider README for setup instructions:`);
    console.error(`  ${pc.cyan(`https://github.com/${REPO}/tree/main/${cloud}`)}`);
    process.exit(1);
  }
}

function runBash(script: string, prompt?: string): Promise<void> {
  // SECURITY: Validate script content before execution
  validateScriptContent(script);

  // Set environment variables for non-interactive mode
  const env = { ...process.env };
  if (prompt) {
    env.SPAWN_PROMPT = prompt;
    env.SPAWN_MODE = "non-interactive";
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      stdio: "inherit",
      env,
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else {
        const msg = code === 130
          ? "Script interrupted by user (Ctrl+C)"
          : `Script exited with code ${code}`;
        reject(new Error(msg));
      }
    });
    child.on("error", reject);
  });
}

// ── List ───────────────────────────────────────────────────────────────────────

const MIN_AGENT_COL_WIDTH = 16;
const MIN_CLOUD_COL_WIDTH = 10;
const COL_PADDING = 2;
const NAME_COLUMN_WIDTH = 18;
const COMPACT_NAME_WIDTH = 20;
const COMPACT_COUNT_WIDTH = 10;

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

function renderMatrixHeader(clouds: string[], manifest: Manifest, agentColWidth: number, cloudColWidth: number): string {
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

function renderMatrixRow(agent: string, clouds: string[], manifest: Manifest, agentColWidth: number, cloudColWidth: number): string {
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

function renderCompactList(manifest: Manifest, agents: string[], clouds: string[]): void {
  const totalClouds = clouds.length;

  console.log();
  console.log(pc.bold("Agent".padEnd(COMPACT_NAME_WIDTH)) + pc.bold("Clouds".padEnd(COMPACT_COUNT_WIDTH)) + pc.bold("Not available on"));
  console.log(pc.dim("-".repeat(COMPACT_NAME_WIDTH + COMPACT_COUNT_WIDTH + 30)));

  for (const a of agents) {
    const implCount = getImplementedClouds(manifest, a).length;
    const missing = getMissingClouds(manifest, a, clouds);
    const countStr = `${implCount}/${totalClouds}`;
    const colorFn = implCount === totalClouds ? pc.green : pc.yellow;

    let line = pc.bold(manifest.agents[a].name.padEnd(COMPACT_NAME_WIDTH));
    line += colorFn(countStr.padEnd(COMPACT_COUNT_WIDTH));

    if (missing.length === 0) {
      line += pc.green("-- all clouds supported");
    } else {
      line += pc.dim(missing.map((c) => manifest.clouds[c].name).join(", "));
    }

    console.log(line);
  }
}

export async function cmdList(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const agents = agentKeys(manifest);
  const clouds = cloudKeys(manifest);

  // Calculate column widths for grid view
  const agentColWidth = calculateColumnWidth(
    agents.map((a) => manifest.agents[a].name),
    MIN_AGENT_COL_WIDTH
  );
  const cloudColWidth = calculateColumnWidth(
    clouds.map((c) => manifest.clouds[c].name),
    MIN_CLOUD_COL_WIDTH
  );

  const gridWidth = agentColWidth + clouds.length * cloudColWidth;
  const termWidth = getTerminalWidth();

  // Use compact view if grid would be wider than the terminal
  const isCompact = gridWidth > termWidth;
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

  const impl = countImplemented(manifest);
  const total = agents.length * clouds.length;
  console.log();
  if (!isCompact) {
    console.log(`${pc.green("+")} implemented  ${pc.dim("-")} not yet available`);
  }
  console.log(pc.green(`${impl}/${total} combinations implemented`));
  console.log(pc.dim(`Run ${pc.cyan("spawn <agent>")} or ${pc.cyan("spawn <cloud>")} for details.`));
  console.log();
}

// ── Agents ─────────────────────────────────────────────────────────────────────

export function getImplementedAgents(manifest: Manifest, cloud: string): string[] {
  return agentKeys(manifest).filter(
    (a: string): boolean => matrixStatus(manifest, cloud, a) === "implemented"
  );
}

export async function cmdAgents(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  console.log();
  console.log(pc.bold("Agents"));
  console.log();
  for (const key of agentKeys(manifest)) {
    const a = manifest.agents[key];
    const implCount = getImplementedClouds(manifest, key).length;
    console.log(`  ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${a.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${implCount} cloud${implCount !== 1 ? "s" : ""}  ${a.description}`)}`);
  }
  console.log();
  console.log(pc.dim(`  Run ${pc.cyan("spawn <agent>")} for details, or ${pc.cyan("spawn <agent> <cloud>")} to launch.`));
  console.log();
}

// ── Clouds ─────────────────────────────────────────────────────────────────────

export async function cmdClouds(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const allAgents = agentKeys(manifest);
  const allClouds = cloudKeys(manifest);

  // Group clouds by type for easier scanning
  const byType: Record<string, string[]> = {};
  for (const key of allClouds) {
    const type = manifest.clouds[key].type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(key);
  }

  console.log();
  console.log(pc.bold("Cloud Providers") + pc.dim(` (${allClouds.length} total)`));

  for (const [type, keys] of Object.entries(byType)) {
    console.log();
    console.log(`  ${pc.dim(type)}`);
    for (const key of keys) {
      const c = manifest.clouds[key];
      const implCount = getImplementedAgents(manifest, key).length;
      const countStr = `${implCount}/${allAgents.length}`;
      console.log(`    ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${c.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${countStr.padEnd(6)} ${c.description}`)}`);
    }
  }
  console.log();
  console.log(pc.dim(`  Run ${pc.cyan("spawn <cloud>")} for details, or ${pc.cyan("spawn <agent> <cloud>")} to launch.`));
  console.log();
}

// ── Agent Info ─────────────────────────────────────────────────────────────────

export async function cmdAgentInfo(agent: string): Promise<void> {
  const [manifest, agentKey] = await validateAndGetAgent(agent);

  const a = manifest.agents[agentKey];
  console.log();
  console.log(`${pc.bold(a.name)} ${pc.dim("--")} ${a.description}`);
  if (a.url) {
    console.log(pc.dim(`  ${a.url}`));
  }
  if (a.notes) {
    console.log(pc.dim(`  ${a.notes}`));
  }

  const allClouds = cloudKeys(manifest);
  const implClouds = getImplementedClouds(manifest, agentKey);
  console.log();
  console.log(pc.bold(`Available clouds:`) + pc.dim(` ${implClouds.length} of ${allClouds.length}`));
  console.log();

  if (implClouds.length === 0) {
    console.log(pc.dim("  No implemented clouds yet."));
    console.log();
    return;
  }

  // Group implemented clouds by type for easier scanning
  const byType: Record<string, string[]> = {};
  for (const cloud of implClouds) {
    const type = manifest.clouds[cloud].type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(cloud);
  }

  for (const [type, clouds] of Object.entries(byType)) {
    console.log(`  ${pc.dim(type)}`);
    for (const cloud of clouds) {
      const c = manifest.clouds[cloud];
      console.log(`    ${pc.green(cloud.padEnd(NAME_COLUMN_WIDTH))} ${c.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim("spawn " + agentKey + " " + cloud)}`);
    }
  }
  console.log();
}

// ── Cloud Info ─────────────────────────────────────────────────────────────────

// Validate and load cloud - consolidates the pattern used by cmdCloudInfo
async function validateAndGetCloud(cloud: string): Promise<[manifest: Manifest, cloudKey: string]> {
  try {
    validateIdentifier(cloud, "Cloud name");
  } catch (err) {
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  validateNonEmptyString(cloud, "Cloud name", "spawn clouds");
  const manifest = await loadManifestWithSpinner();
  validateCloud(manifest, cloud);

  return [manifest, cloud];
}

export async function cmdCloudInfo(cloud: string): Promise<void> {
  const [manifest, cloudKey] = await validateAndGetCloud(cloud);

  const c = manifest.clouds[cloudKey];
  console.log();
  console.log(`${pc.bold(c.name)} ${pc.dim("--")} ${c.description}`);
  console.log(pc.dim(`  Type: ${c.type}  |  Auth: ${c.auth}`));
  if (c.url) {
    console.log(pc.dim(`  ${c.url}`));
  }
  if (c.notes) {
    console.log(pc.dim(`  ${c.notes}`));
  }

  const allAgents = agentKeys(manifest);
  const implAgents = getImplementedAgents(manifest, cloudKey);
  const missingAgents = allAgents.filter((a) => !implAgents.includes(a));
  console.log();
  console.log(pc.bold(`Available agents:`) + pc.dim(` ${implAgents.length} of ${allAgents.length}`));
  console.log();

  if (implAgents.length === 0) {
    console.log(pc.dim("  No implemented agents yet."));
  } else {
    for (const agent of implAgents) {
      const a = manifest.agents[agent];
      console.log(`  ${pc.green(agent.padEnd(NAME_COLUMN_WIDTH))} ${a.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim("spawn " + agent + " " + cloudKey)}`);
    }
  }

  if (missingAgents.length > 0 && missingAgents.length <= 5) {
    console.log();
    console.log(pc.dim(`  Not yet available: ${missingAgents.map((a) => manifest.agents[a].name).join(", ")}`));
  }

  console.log();
  console.log(pc.dim(`  Setup: ${pc.cyan(`https://github.com/${REPO}/tree/main/${cloudKey}`)}`));
  console.log();
}

// ── Update ─────────────────────────────────────────────────────────────────────

export async function cmdUpdate(): Promise<void> {
  const s = p.spinner();
  s.start("Checking for updates...");

  try {
    const res = await fetch(`${RAW_BASE}/cli/package.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error("fetch failed");
    const remotePkg = (await res.json()) as { version: string };
    const remoteVersion = remotePkg.version;

    if (remoteVersion === VERSION) {
      s.stop(`Already up to date ${pc.dim(`(v${VERSION})`)}`);
      return;
    }

    s.stop(`Updating: v${VERSION} -> v${remoteVersion}`);

    const { execSync } = await import("child_process");
    try {
      execSync(`curl -fsSL ${RAW_BASE}/cli/install.sh | bash`, {
        stdio: "inherit",
        shell: "/bin/bash",
      });
      console.log();
      p.log.success(`Updated to v${remoteVersion}`);
      p.log.info("Restart your command to use the new version.");
    } catch {
      p.log.error("Auto-update failed. Update manually:");
      console.log();
      console.log(
        `  ${pc.cyan(`curl -fsSL ${RAW_BASE}/cli/install.sh | bash`)}`
      );
      console.log();
    }
  } catch (err) {
    s.stop(pc.red("Failed to check for updates"));
    console.error("Error:", getErrorMessage(err));
    console.error(`\nTroubleshooting:`);
    console.error(`  1. Check your internet connection`);
    console.error(`  2. Try again in a few moments`);
    console.error(`  3. Update manually: ${pc.cyan(`curl -fsSL ${RAW_BASE}/cli/install.sh | bash`)}`);
  }
}

// ── Help ───────────────────────────────────────────────────────────────────────

export function cmdHelp(): void {
  console.log(`
${pc.bold("spawn")} -- Launch any AI coding agent on any cloud

${pc.bold("USAGE")}
  spawn                              Interactive agent + cloud picker
  spawn <agent> <cloud>              Launch agent on cloud directly
  spawn <agent> <cloud> --prompt "text"
                                     Execute agent with prompt (non-interactive)
  spawn <agent> <cloud> --prompt-file <file>
                                     Execute agent with prompt from file
  spawn <agent>                      Show available clouds for agent
  spawn <cloud>                      Show available agents for cloud
  spawn list                         Full matrix table (alias: ls)
  spawn agents                       List all agents with descriptions
  spawn clouds                       List all cloud providers
  spawn update                       Check for CLI updates
  spawn version                      Show version
  spawn help                         Show this help message

${pc.bold("EXAMPLES")}
  spawn                              ${pc.dim("# Pick interactively")}
  spawn claude sprite                ${pc.dim("# Launch Claude Code on Sprite")}
  spawn aider hetzner                ${pc.dim("# Launch Aider on Hetzner Cloud")}
  spawn claude sprite --prompt "Fix all linter errors"
                                     ${pc.dim("# Execute Claude with prompt and exit")}
  spawn aider sprite -p "Add tests"  ${pc.dim("# Short form of --prompt")}
  spawn claude sprite --prompt-file instructions.txt
                                     ${pc.dim("# Read prompt from file")}
  spawn claude                       ${pc.dim("# Show which clouds support Claude")}
  spawn hetzner                      ${pc.dim("# Show which agents run on Hetzner")}
  spawn list                         ${pc.dim("# See the full agent x cloud matrix")}

${pc.bold("AUTHENTICATION")}
  All agents use OpenRouter for LLM access. Get your API key at:
  ${pc.cyan("https://openrouter.ai/settings/keys")}

  For non-interactive use, set environment variables:
  ${pc.dim("OPENROUTER_API_KEY")}=sk-or-v1-... spawn claude sprite

  Each cloud provider has its own auth requirements.
  Run ${pc.cyan("spawn <agent> <cloud>")} to see specific instructions.

${pc.bold("INSTALL")}
  curl -fsSL ${RAW_BASE}/cli/install.sh | bash

${pc.bold("TROUBLESHOOTING")}
  ${pc.dim("*")} Script not found: Run ${pc.cyan("spawn list")} to verify the combination exists
  ${pc.dim("*")} Missing credentials: Check cloud-specific READMEs in the repo
  ${pc.dim("*")} Update issues: Try ${pc.cyan("spawn update")} or reinstall manually
  ${pc.dim("*")} Garbled unicode: Set ${pc.cyan("SPAWN_NO_UNICODE=1")} for ASCII-only output
  ${pc.dim("*")} Slow startup: Set ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")} to skip auto-update

${pc.bold("MORE INFO")}
  Repository:  https://github.com/${REPO}
  OpenRouter:  https://openrouter.ai
`);
}

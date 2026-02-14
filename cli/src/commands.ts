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
  isStaleCache,
  RAW_BASE,
  REPO,
  type Manifest,
} from "./manifest.js";
import pkg from "../package.json" with { type: "json" };
const VERSION = pkg.version;
import { validateIdentifier, validateScriptContent, validatePrompt } from "./security.js";
import { saveSpawnRecord, filterHistory, clearHistory, type SpawnRecord } from "./history.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 10_000; // 10 seconds

export function getErrorMessage(err: unknown): string {
  // Use duck typing instead of instanceof to avoid prototype chain issues
  return err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
}

function handleCancel(): never {
  p.outro(pc.dim("Cancelled."));
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

export async function loadManifestWithSpinner(): Promise<Manifest> {
  const manifest = await withSpinner("Loading manifest...", loadManifest);
  if (isStaleCache()) {
    p.log.warn("Using cached manifest (offline). Data may be outdated.");
  }
  return manifest;
}

function validateNonEmptyString(value: string, fieldName: string, helpCommand: string): void {
  if (!value || value.trim() === "") {
    p.log.error(`${fieldName} is required but was not provided`);
    p.log.info(`Run ${pc.cyan(helpCommand)} to see all available ${fieldName.toLowerCase()}s.`);
    process.exit(1);
  }
}

function mapToSelectOptions<T extends { name: string; description: string }>(
  keys: string[],
  items: Record<string, T>,
  hintOverrides?: Record<string, string>
): Array<{ value: string; label: string; hint: string }> {
  return keys.map((key) => ({
    value: key,
    label: items[key].name,
    hint: hintOverrides?.[key] ?? items[key].description,
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
 * Find the closest matching key by checking both keys and display names.
 * Returns the key (not display name) of the best match, or null if no match within distance 3.
 */
export function findClosestKeyByNameOrKey(
  input: string,
  keys: string[],
  getName: (key: string) => string
): string | null {
  let bestKey: string | null = null;
  let bestDist = Infinity;
  const lower = input.toLowerCase();

  for (const key of keys) {
    const keyDist = levenshtein(lower, key.toLowerCase());
    if (keyDist < bestDist) {
      bestDist = keyDist;
      bestKey = key;
    }
    const nameDist = levenshtein(lower, getName(key).toLowerCase());
    if (nameDist < bestDist) {
      bestDist = nameDist;
      bestKey = key;
    }
  }
  return bestDist <= 3 ? bestKey : null;
}

/**
 * Resolve user input to a valid entity key (agent or cloud).
 * Tries: exact key -> case-insensitive key -> display name match (case-insensitive).
 * Returns the key if found, or null.
 */
function resolveEntityKey(manifest: Manifest, input: string, kind: "agent" | "cloud"): string | null {
  const collection = getEntityCollection(manifest, kind);
  if (collection[input]) return input;
  const keys = getEntityKeys(manifest, kind);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of keys) {
    if (collection[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

export function resolveAgentKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "agent");
}

export function resolveCloudKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "cloud");
}

interface EntityDef { label: string; labelPlural: string; listCmd: string; opposite: string }
const ENTITY_DEFS: Record<"agent" | "cloud", EntityDef> = {
  agent: { label: "agent", labelPlural: "agents", listCmd: "spawn agents", opposite: "cloud provider" },
  cloud: { label: "cloud", labelPlural: "clouds", listCmd: "spawn clouds", opposite: "agent" },
};

function getEntityCollection(manifest: Manifest, kind: "agent" | "cloud") {
  return kind === "agent" ? manifest.agents : manifest.clouds;
}

function getEntityKeys(manifest: Manifest, kind: "agent" | "cloud") {
  return kind === "agent" ? agentKeys(manifest) : cloudKeys(manifest);
}

/** Suggest a typo correction by fuzzy-matching against a set of keys */
function suggestTypoCorrection(
  value: string,
  manifest: Manifest,
  kind: "agent" | "cloud"
): string | null {
  const collection = getEntityCollection(manifest, kind);
  const keys = getEntityKeys(manifest, kind);
  return findClosestKeyByNameOrKey(value, keys, (k) => collection[k].name);
}

/** Report validation error for an entity and return false, or return true if valid */
export function checkEntity(manifest: Manifest, value: string, kind: "agent" | "cloud"): boolean {
  const def = ENTITY_DEFS[kind];
  const collection = getEntityCollection(manifest, kind);
  if (collection[value]) return true;

  p.log.error(`Unknown ${def.label}: ${pc.bold(value)}`);

  const oppositeKind = kind === "agent" ? "cloud" : "agent";
  const oppositeDef = ENTITY_DEFS[oppositeKind];
  const oppositeCollection = getEntityCollection(manifest, oppositeKind);

  // Check if user provided an entity of the wrong kind
  if (oppositeCollection[value]) {
    p.log.info(`"${value}" is ${kind === "agent" ? "a cloud provider" : "an agent"}, not ${kind === "agent" ? "an agent" : "a cloud provider"}.`);
    p.log.info(`Usage: ${pc.cyan("spawn <agent> <cloud>")}`);
    p.log.info(`Run ${pc.cyan(def.listCmd)} to see available ${def.labelPlural}.`);
    return false;
  }

  // Check for typo matches in the same kind
  const match = suggestTypoCorrection(value, manifest, kind);
  if (match) {
    p.log.info(`Did you mean ${pc.cyan(match)} (${collection[match].name})?`);
    p.log.info(`  ${pc.cyan(`spawn ${match}`)}`);
    p.log.info(`Run ${pc.cyan(def.listCmd)} to see available ${def.labelPlural}.`);
    return false;
  }

  // Check for typo matches in the opposite kind (swapped arguments with typo)
  const oppositeMatch = suggestTypoCorrection(value, manifest, oppositeKind);
  if (oppositeMatch) {
    p.log.info(`"${pc.bold(value)}" looks like ${oppositeDef.label} ${pc.cyan(oppositeMatch)} (${oppositeCollection[oppositeMatch].name}).`);
    p.log.info(`Did you swap the agent and cloud arguments?`);
    p.log.info(`Usage: ${pc.cyan("spawn <agent> <cloud>")}`);
    return false;
  }

  p.log.info(`Run ${pc.cyan(def.listCmd)} to see available ${def.labelPlural}.`);
  return false;
}

function validateEntity(manifest: Manifest, value: string, kind: "agent" | "cloud"): void {
  if (!checkEntity(manifest, value, kind)) {
    process.exit(1);
  }
}

async function validateAndGetEntity(value: string, kind: "agent" | "cloud"): Promise<[manifest: Manifest, key: string]> {
  const def = ENTITY_DEFS[kind];
  const capitalLabel = def.label.charAt(0).toUpperCase() + def.label.slice(1);
  try {
    validateIdentifier(value, `${capitalLabel} name`);
  } catch (err) {
    p.log.error(getErrorMessage(err));
    process.exit(1);
  }

  validateNonEmptyString(value, `${capitalLabel} name`, def.listCmd);
  const manifest = await loadManifestWithSpinner();
  validateEntity(manifest, value, kind);

  return [manifest, value];
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
      p.log.info(`Run ${pc.cyan("spawn matrix")} to see the full availability matrix.`);
    }
    process.exit(1);
  }
}

// ── Interactive ────────────────────────────────────────────────────────────────

/** Sort clouds by credential availability and build hint overrides for the picker */
export function prioritizeCloudsByCredentials(
  clouds: string[],
  manifest: Manifest
): { sortedClouds: string[]; hintOverrides: Record<string, string>; credCount: number } {
  const withCreds: string[] = [];
  const withoutCreds: string[] = [];
  for (const c of clouds) {
    if (hasCloudCredentials(manifest.clouds[c].auth)) {
      withCreds.push(c);
    } else {
      withoutCreds.push(c);
    }
  }

  const hintOverrides: Record<string, string> = {};
  for (const c of withCreds) {
    hintOverrides[c] = `credentials detected -- ${manifest.clouds[c].description}`;
  }

  return { sortedClouds: [...withCreds, ...withoutCreds], hintOverrides, credCount: withCreds.length };
}

/** Build hint overrides for the agent picker showing cloud count and credential readiness */
export function buildAgentPickerHints(manifest: Manifest): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const agent of agentKeys(manifest)) {
    const implClouds = getImplementedClouds(manifest, agent);
    if (implClouds.length === 0) {
      hints[agent] = "no clouds available yet";
      continue;
    }
    const readyCount = implClouds.filter(c => hasCloudCredentials(manifest.clouds[c].auth)).length;
    const cloudLabel = `${implClouds.length} cloud${implClouds.length !== 1 ? "s" : ""}`;
    if (readyCount > 0) {
      hints[agent] = `${cloudLabel}, ${readyCount} ready`;
    } else {
      hints[agent] = cloudLabel;
    }
  }
  return hints;
}

export async function cmdInteractive(): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  const manifest = await loadManifestWithSpinner();

  const agents = agentKeys(manifest);
  const agentHints = buildAgentPickerHints(manifest);
  const agentChoice = await p.select({
    message: "Select an agent",
    options: mapToSelectOptions(agents, manifest.agents, agentHints),
  });
  if (p.isCancel(agentChoice)) handleCancel();

  const clouds = getImplementedClouds(manifest, agentChoice);

  if (clouds.length === 0) {
    p.log.error(`No clouds available for ${manifest.agents[agentChoice].name}`);
    p.log.info(`This agent has no implemented cloud providers yet.`);
    p.log.info(`Run ${pc.cyan("spawn matrix")} to see the full availability matrix.`);
    process.exit(1);
  }

  const { sortedClouds, hintOverrides, credCount } = prioritizeCloudsByCredentials(clouds, manifest);

  if (credCount > 0) {
    p.log.info(`${credCount} cloud${credCount > 1 ? "s" : ""} with credentials detected (shown first)`);
  }

  const cloudChoice = await p.select({
    message: "Select a cloud provider",
    options: mapToSelectOptions(sortedClouds, manifest.clouds, hintOverrides),
  });
  if (p.isCancel(cloudChoice)) handleCancel();

  await preflightCredentialCheck(manifest, cloudChoice);

  const agentName = manifest.agents[agentChoice].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${agentChoice} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");

  await execScript(cloudChoice, agentChoice, undefined, getAuthHint(manifest, cloudChoice), manifest.clouds[cloudChoice].url);
}

// ── Run ────────────────────────────────────────────────────────────────────────

/** Resolve display names / casing and log if resolved to a different key */
function resolveAndLog(
  manifest: Manifest,
  agent: string,
  cloud: string
): { agent: string; cloud: string } {
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
  return { agent, cloud };
}

/** Detect and fix swapped arguments: "spawn <cloud> <agent>" -> "spawn <agent> <cloud>" */
function detectAndFixSwappedArgs(
  manifest: Manifest,
  agent: string,
  cloud: string
): { agent: string; cloud: string } {
  if (!manifest.agents[agent] && manifest.clouds[agent] && manifest.agents[cloud]) {
    p.log.info(`It looks like you swapped the agent and cloud arguments.`);
    p.log.info(`Running: ${pc.cyan(`spawn ${cloud} ${agent}`)}`);
    return { agent: cloud, cloud: agent };
  }
  return { agent, cloud };
}

/** Print a labeled section: bold header, body lines, then a blank line */
function printDryRunSection(title: string, lines: string[]): void {
  p.log.step(pc.bold(title));
  for (const line of lines) console.log(line);
  console.log();
}

function buildAgentLines(agentInfo: { name: string; description: string; install?: string; launch?: string }): string[] {
  const lines = [
    `  Name:        ${agentInfo.name}`,
    `  Description: ${agentInfo.description}`,
  ];
  if (agentInfo.install) lines.push(`  Install:     ${agentInfo.install}`);
  if (agentInfo.launch) lines.push(`  Launch:      ${agentInfo.launch}`);
  return lines;
}

function buildCloudLines(cloudInfo: { name: string; description: string; defaults?: Record<string, string> }): string[] {
  const lines = [
    `  Name:        ${cloudInfo.name}`,
    `  Description: ${cloudInfo.description}`,
  ];
  if (cloudInfo.defaults) {
    lines.push(`  Defaults:`);
    for (const [k, v] of Object.entries(cloudInfo.defaults)) {
      lines.push(`    ${k}: ${v}`);
    }
  }
  return lines;
}

/** Format a single credential env var as a status line (green if set, red if missing) */
export function formatCredStatusLine(varName: string, urlHint?: string): string {
  if (process.env[varName]) {
    return `  ${pc.green(varName)} ${pc.dim("-- set")}`;
  }
  const suffix = urlHint ? `  ${pc.dim(urlHint)}` : "";
  return `  ${pc.red(varName)} ${pc.dim("-- not set")}${suffix}`;
}

/** Build credential status lines for dry-run preview showing which env vars are set/missing */
function buildCredentialStatusLines(manifest: Manifest, cloud: string): string[] {
  const cloudAuth = manifest.clouds[cloud].auth;
  const authVars = parseAuthEnvVars(cloudAuth);
  const cloudUrl = manifest.clouds[cloud].url;

  const lines = [formatCredStatusLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys")];

  for (let i = 0; i < authVars.length; i++) {
    lines.push(formatCredStatusLine(authVars[i], i === 0 ? cloudUrl : undefined));
  }

  return lines;
}

function showDryRunPreview(manifest: Manifest, agent: string, cloud: string, prompt?: string): void {
  p.log.info(pc.bold("Dry run -- no resources will be provisioned\n"));

  printDryRunSection("Agent", buildAgentLines(manifest.agents[agent]));
  printDryRunSection("Cloud", buildCloudLines(manifest.clouds[cloud]));
  printDryRunSection("Script", [`  URL: ${RAW_BASE}/${cloud}/${agent}.sh`]);

  const env = manifest.agents[agent].env;
  if (env) {
    const envLines = Object.entries(env).map(([k, v]) => {
      const display = v.includes("OPENROUTER_API_KEY") ? "(from OpenRouter)" : v;
      return `  ${k}=${display}`;
    });
    printDryRunSection("Environment variables", envLines);
  }

  // Show credential readiness
  const credLines = buildCredentialStatusLines(manifest, cloud);
  printDryRunSection("Credentials", credLines);
  const allSet = credLines.every(l => l.includes("-- set"));
  if (!allSet) {
    p.log.warn("Some credentials are missing. Set them before launching.");
    p.log.info(`Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions.`);
    console.log();
  }

  if (prompt) {
    const preview = prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;
    const lines = [`  ${preview}`];
    if (prompt.length > 100) {
      lines.push(pc.dim(`  (${prompt.length} characters total)`));
    }
    printDryRunSection("Prompt", lines);
  }

  p.log.success("Dry run complete -- no resources were provisioned");
}

/** Validate inputs for injection attacks (SECURITY) and check they're non-empty */
function validateRunSecurity(agent: string, cloud: string, prompt?: string): void {
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
}

/** Validate agent and cloud exist in manifest, showing all errors before exiting */
function validateEntities(manifest: Manifest, agent: string, cloud: string): void {
  const agentValid = checkEntity(manifest, agent, "agent");
  const cloudValid = checkEntity(manifest, cloud, "cloud");
  if (!agentValid || !cloudValid) {
    process.exit(1);
  }
  validateImplementation(manifest, cloud, agent);
}

/** Build auth hint string from cloud auth field for error messages */
function getAuthHint(manifest: Manifest, cloud: string): string | undefined {
  const authVars = parseAuthEnvVars(manifest.clouds[cloud].auth);
  return authVars.length > 0 ? authVars.join(" + ") : undefined;
}

/** Check for missing credentials before running a script and warn the user.
 *  In interactive mode, asks for confirmation. In non-interactive mode, just warns. */
export async function preflightCredentialCheck(manifest: Manifest, cloud: string): Promise<void> {
  const cloudAuth = manifest.clouds[cloud].auth;
  if (cloudAuth.toLowerCase() === "none") return;

  const authVars = parseAuthEnvVars(cloudAuth);
  const missing: string[] = [];

  if (!process.env.OPENROUTER_API_KEY) {
    missing.push("OPENROUTER_API_KEY");
  }
  for (const v of authVars) {
    if (!process.env[v]) {
      missing.push(v);
    }
  }

  if (missing.length === 0) return;

  const cloudName = manifest.clouds[cloud].name;
  p.log.warn(`Missing credentials for ${cloudName}: ${missing.map(v => pc.cyan(v)).join(", ")}`);

  // Give context-specific guidance
  const onlyOpenRouter = missing.length === 1 && missing[0] === "OPENROUTER_API_KEY";
  if (onlyOpenRouter) {
    p.log.info(`The script will open your browser to authenticate with OpenRouter.`);
  } else {
    p.log.info(`Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions.`);
  }

  if (isInteractiveTTY()) {
    const confirmMsg = onlyOpenRouter
      ? "Continue? You'll authenticate via browser."
      : "Continue anyway? The script will prompt for missing credentials.";
    const shouldContinue = await p.confirm({
      message: confirmMsg,
      initialValue: true,
    });
    if (p.isCancel(shouldContinue) || !shouldContinue) {
      handleCancel();
    }
  }
}

export async function cmdRun(agent: string, cloud: string, prompt?: string, dryRun?: boolean): Promise<void> {
  const manifest = await loadManifestWithSpinner();
  ({ agent, cloud } = resolveAndLog(manifest, agent, cloud));

  validateRunSecurity(agent, cloud, prompt);
  ({ agent, cloud } = detectAndFixSwappedArgs(manifest, agent, cloud));
  validateEntities(manifest, agent, cloud);

  if (dryRun) {
    showDryRunPreview(manifest, agent, cloud, prompt);
    return;
  }

  await preflightCredentialCheck(manifest, cloud);

  const agentName = manifest.agents[agent].name;
  const cloudName = manifest.clouds[cloud].name;
  const suffix = prompt ? " with prompt..." : "...";
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}${suffix}`);

  await execScript(cloud, agent, prompt, getAuthHint(manifest, cloud), manifest.clouds[cloud].url);
}

export function getStatusDescription(status: number): string {
  return status === 404 ? "not found" : `HTTP ${status}`;
}

async function downloadScriptWithFallback(primaryUrl: string, fallbackUrl: string): Promise<string> {
  const s = p.spinner();
  s.start("Downloading spawn script...");

  try {
    const res = await fetch(primaryUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.ok) {
      s.stop("Script downloaded");
      return res.text();
    }

    // Fallback to GitHub raw
    s.message("Trying fallback source...");
    const ghRes = await fetch(fallbackUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
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
  if (primaryStatus === 404 && fallbackStatus === 404) {
    p.log.error("Script download failed (HTTP 404: not found)");
    console.error("\nThe script file could not be found.");
    console.error("This usually means the combination hasn't been published yet,");
    console.error("even though it may appear in the matrix.");
    console.error(`\nHow to fix:`);
    console.error(`  1. Verify the combination is implemented: ${pc.cyan("spawn matrix")}`);
    console.error(`  2. Try again later (the script may be deploying)`);
    console.error(`  3. Report the issue: ${pc.cyan(`https://github.com/${REPO}/issues`)}`);
  } else {
    p.log.error(`Script download failed`);
    console.error(`\nBoth download sources returned errors (HTTP ${primaryStatus} and ${fallbackStatus}).`);
    if (primaryStatus >= 500 || fallbackStatus >= 500) {
      console.error("The server may be experiencing temporary issues.");
    }
    console.error(`\nHow to fix:`);
    console.error(`  1. Wait a moment and try again`);
    console.error(`  2. Check GitHub status: ${pc.cyan("https://www.githubstatus.com")}`);
  }
}

function reportDownloadError(ghUrl: string, err: unknown): never {
  p.log.error("Script download failed (network error)");
  console.error("\nError:", getErrorMessage(err));
  console.error("\nHow to fix:");
  console.error("  1. Check your internet connection");
  console.error(`  2. Verify this combination exists: ${pc.cyan("spawn matrix")}`);
  console.error(`  3. Try accessing the script directly: ${ghUrl}`);
  process.exit(1);
}

/** Check which required env vars are set vs missing and return specific hints */
export function credentialHints(cloud: string, authHint?: string, verb = "Missing or invalid"): string[] {
  if (!authHint) {
    return [
      `  - ${verb} credentials (run ${pc.cyan(`spawn ${cloud}`)} for setup)`,
    ];
  }

  // Parse individual env var names from the auth hint (e.g. "HCLOUD_TOKEN" or "UPCLOUD_USERNAME + UPCLOUD_PASSWORD")
  const authVars = authHint.split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean);
  const allVars = [...authVars, "OPENROUTER_API_KEY"];

  const missing = allVars.filter(v => !process.env[v]);

  if (missing.length === 0) {
    // All credentials are set -- the issue is likely something else
    return [
      `  - Credentials appear to be set (${allVars.map(v => pc.cyan(v)).join(", ")})`,
      `    The error may be due to invalid or expired credentials`,
      `    Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions`,
    ];
  }

  // Show which specific vars are missing
  const lines: string[] = [];
  lines.push(`  - Missing credentials:`);
  for (const v of missing) {
    lines.push(`      ${pc.cyan(v)} -- not set`);
  }
  lines.push(`    Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions`);

  return lines;
}

function buildDashboardHint(dashboardUrl?: string): string {
  return dashboardUrl
    ? `  - Check your dashboard: ${pc.cyan(dashboardUrl)}`
    : "  - Check your cloud provider dashboard to stop or delete any unused servers";
}

interface SignalEntry {
  header: string;
  causes: string[];
  includeDashboard: boolean;
}

interface ExitCodeEntry {
  header: string;
  lines: string[];
  includeDashboard: boolean;
}

const EXIT_CODE_GUIDANCE: Record<number, ExitCodeEntry> = {
  130: {
    header: "Script was interrupted (Ctrl+C).",
    lines: ["Note: If a server was already created, it may still be running."],
    includeDashboard: true,
  },
  137: {
    header: "Script was killed (likely by the system due to timeout or out of memory).",
    lines: [
      "  - The server may not have enough RAM for this agent",
      "  - Try a larger instance size or a different cloud provider",
    ],
    includeDashboard: true,
  },
  255: {
    header: "SSH connection failed. Common causes:",
    lines: [
      "  - Server is still booting (wait a moment and retry)",
      "  - Firewall blocking SSH port 22",
      "  - Server was terminated before the session started",
    ],
    includeDashboard: false,
  },
  127: {
    header: "A required command was not found. Check that these are installed:",
    lines: ["  - bash, curl, ssh, jq"],
    includeDashboard: false,
  },
  126: {
    header: "A command was found but could not be executed (permission denied).",
    lines: [
      "  - A downloaded binary may lack execute permissions",
      "  - The script may require root/sudo access",
      `  - Report it if this persists: ${pc.cyan(`https://github.com/OpenRouterTeam/spawn/issues`)}`,
    ],
    includeDashboard: false,
  },
  2: {
    header: "Shell syntax or argument error. This is likely a bug in the script.",
    lines: [`  Report it at: ${pc.cyan(`https://github.com/OpenRouterTeam/spawn/issues`)}`],
    includeDashboard: false,
  },
  1: {
    header: "Common causes:",
    lines: [],
    includeDashboard: true,
  },
};

const SIGNAL_GUIDANCE: Record<string, SignalEntry> = {
  SIGKILL: {
    header: "Script was forcibly killed (SIGKILL). Common causes:",
    causes: [
      "  - Out of memory (OOM killer terminated the process)",
      "  - The server may not have enough RAM for this agent",
      "  - Try a larger instance size or a different cloud provider",
    ],
    includeDashboard: true,
  },
  SIGTERM: {
    header: "Script was terminated (SIGTERM). Common causes:",
    causes: [
      "  - The process was stopped by the system or a supervisor",
      "  - Server shutdown or reboot in progress",
      "  - Cloud provider terminated the instance (spot/preemptible instance or billing issue)",
    ],
    includeDashboard: true,
  },
  SIGINT: {
    header: "Script was interrupted (Ctrl+C).",
    causes: [
      "Note: If a server was already created, it may still be running.",
    ],
    includeDashboard: true,
  },
  SIGHUP: {
    header: "Script lost its terminal connection (SIGHUP). Common causes:",
    causes: [
      "  - SSH session disconnected or timed out",
      "  - Terminal window was closed during execution",
      "  - Try using a more stable connection or a terminal multiplexer (tmux/screen)",
    ],
    includeDashboard: false,
  },
};

export function getSignalGuidance(signal: string, dashboardUrl?: string): string[] {
  const entry = SIGNAL_GUIDANCE[signal];
  if (entry) {
    const lines = [entry.header, ...entry.causes];
    if (entry.includeDashboard) lines.push(buildDashboardHint(dashboardUrl));
    return lines;
  }
  return [
    `Script was killed by signal ${signal}.`,
    "  - The process was terminated by the system or another process",
    buildDashboardHint(dashboardUrl),
  ];
}

function optionalDashboardLine(dashboardUrl?: string): string[] {
  return dashboardUrl ? [`  - Check your dashboard: ${pc.cyan(dashboardUrl)}`] : [];
}

export function getScriptFailureGuidance(exitCode: number | null, cloud: string, authHint?: string, dashboardUrl?: string): string[] {
  const entry = exitCode !== null ? EXIT_CODE_GUIDANCE[exitCode] : null;

  if (!entry) {
    // Default/unknown exit code
    return [
      "Common causes:",
      ...credentialHints(cloud, authHint, "Missing"),
      "  - Cloud provider API rate limit or quota exceeded",
      "  - Missing local dependencies (SSH, curl, jq)",
      ...optionalDashboardLine(dashboardUrl),
    ];
  }

  const lines = [entry.header, ...entry.lines];

  // Special handling for exit code 127 (missing command)
  if (exitCode === 127) {
    lines.push(`  - Cloud-specific CLI tools (run ${pc.cyan(`spawn ${cloud}`)} for details)`);
  }

  // Special handling for exit code 1 (general error)
  if (exitCode === 1) {
    lines.push(...credentialHints(cloud, authHint));
    lines.push("  - Cloud provider API error (quota, rate limit, or region issue)");
    lines.push("  - Server provisioning failed (try again or pick a different region)");
  }

  if (entry.includeDashboard) {
    lines.push(buildDashboardHint(dashboardUrl));
  }

  return lines;
}

export function buildRetryCommand(agent: string, cloud: string, prompt?: string): string {
  if (!prompt) return `spawn ${agent} ${cloud}`;
  if (prompt.length <= 80) {
    const safe = prompt.replace(/"/g, '\\"');
    return `spawn ${agent} ${cloud} --prompt "${safe}"`;
  }
  // Long prompts: suggest --prompt-file instead of truncating into a broken command
  return `spawn ${agent} ${cloud} --prompt-file <your-prompt-file>`;
}

function reportScriptFailure(errMsg: string, cloud: string, agent: string, authHint?: string, prompt?: string, dashboardUrl?: string): never {
  p.log.error("Spawn script failed");
  console.error("\nError:", errMsg);

  const exitCodeMatch = errMsg.match(/exited with code (\d+)/);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;

  // Check for signal-killed messages (e.g. "killed by SIGKILL")
  const signalMatch = errMsg.match(/killed by (SIG\w+)/);
  const signal = signalMatch ? signalMatch[1] : null;

  const lines = signal
    ? getSignalGuidance(signal, dashboardUrl)
    : getScriptFailureGuidance(exitCode, cloud, authHint, dashboardUrl);
  console.error("");
  for (const line of lines) console.error(line);
  console.error("");
  console.error(`Retry: ${pc.cyan(buildRetryCommand(agent, cloud, prompt))}`);
  process.exit(1);
}

const MAX_RETRIES = 2;
const RETRY_DELAYS = [5, 10]; // seconds

export function isRetryableExitCode(errMsg: string): boolean {
  const exitCodeMatch = errMsg.match(/exited with code (\d+)/);
  if (!exitCodeMatch) return false;
  const code = parseInt(exitCodeMatch[1], 10);
  // Exit 255 = SSH connection failure (the standard SSH error exit code)
  return code === 255;
}

function handleUserInterrupt(errMsg: string, dashboardUrl?: string): void {
  if (!errMsg.includes("interrupted by user") && !errMsg.includes("killed by SIGINT")) return;
  console.error();
  p.log.warn("Script interrupted (Ctrl+C).");
  p.log.warn("If a server was already created, it may still be running.");
  if (dashboardUrl) {
    p.log.warn(`  Check your dashboard: ${pc.cyan(dashboardUrl)}`);
  } else {
    p.log.warn(`  Check your cloud provider dashboard to stop or delete any unused servers.`);
  }
  process.exit(130);
}

async function runWithRetries(script: string, prompt?: string, dashboardUrl?: string): Promise<string | undefined> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      await runBash(script, prompt);
      return undefined; // success
    } catch (err) {
      const errMsg = getErrorMessage(err);
      handleUserInterrupt(errMsg, dashboardUrl);

      if (attempt <= MAX_RETRIES && isRetryableExitCode(errMsg)) {
        const delay = RETRY_DELAYS[attempt - 1];
        p.log.warn(`Script failed (${errMsg}). Retrying in ${delay}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }

      return errMsg;
    }
  }
  return "Script failed after all retries";
}

async function execScript(cloud: string, agent: string, prompt?: string, authHint?: string, dashboardUrl?: string): Promise<void> {
  const url = `https://openrouter.ai/labs/spawn/${cloud}/${agent}.sh`;
  const ghUrl = `${RAW_BASE}/${cloud}/${agent}.sh`;

  let scriptContent: string;
  try {
    scriptContent = await downloadScriptWithFallback(url, ghUrl);
  } catch (err) {
    reportDownloadError(ghUrl, err);
  }

  // Record the spawn before execution (so it's logged even if the script fails midway)
  try {
    saveSpawnRecord({
      agent,
      cloud,
      timestamp: new Date().toISOString(),
      ...(prompt ? { prompt } : {}),
    });
  } catch {
    // Non-fatal: don't block the spawn if history write fails
  }

  const lastErr = await runWithRetries(scriptContent, prompt, dashboardUrl);
  if (lastErr) {
    reportScriptFailure(lastErr, cloud, agent, authHint, prompt, dashboardUrl);
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
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolve();
      else if (code !== null) {
        const msg = code === 130
          ? "Script interrupted by user (Ctrl+C)"
          : `Script exited with code ${code}`;
        reject(new Error(msg));
      } else {
        // code is null when killed by a signal (SIGKILL, SIGTERM, etc.)
        const sig = signal ?? "unknown signal";
        reject(new Error(`Script was killed by ${sig}`));
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

const COMPACT_READY_WIDTH = 10;

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
  const readyCount = implClouds.filter(c => hasCloudCredentials(manifest.clouds[c].auth)).length;
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
  console.log(pc.dim(`Launch: ${pc.cyan("spawn <agent> <cloud>")}  |  Details: ${pc.cyan("spawn <agent>")} or ${pc.cyan("spawn <cloud>")}`));
  console.log();
}

export async function cmdMatrix(): Promise<void> {
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

// ── List (History) ──────────────────────────────────────────────────────────────

/** Format an ISO timestamp as a human-readable relative time (e.g., "5 min ago", "2 days ago") */
export function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return "just now";
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays === 1) return "yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    // Fall back to absolute date for old entries
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return date;
  } catch {
    return iso;
  }
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

async function suggestFilterCorrection(
  filter: string,
  flag: string,
  keys: string[],
  resolveKey: (m: Manifest, input: string) => string | null,
  getDisplayName: (k: string) => string,
  manifest: Manifest,
): void {
  const resolved = resolveKey(manifest, filter);
  if (resolved && resolved !== filter) {
    p.log.info(`Did you mean ${pc.cyan(`spawn list ${flag} ${resolved}`)}?`);
  } else if (!resolved) {
    const match = findClosestKeyByNameOrKey(filter, keys, getDisplayName);
    if (match) {
      p.log.info(`Did you mean ${pc.cyan(`spawn list ${flag} ${match}`)}?`);
    }
  }
}

async function showEmptyListMessage(agentFilter?: string, cloudFilter?: string): Promise<void> {
  if (!agentFilter && !cloudFilter) {
    p.log.info("No spawns recorded yet.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to launch your first agent.`);
    return;
  }

  const parts: string[] = [];
  if (agentFilter) parts.push(`agent=${pc.bold(agentFilter)}`);
  if (cloudFilter) parts.push(`cloud=${pc.bold(cloudFilter)}`);
  p.log.info(`No spawns found matching ${parts.join(", ")}.`);

  try {
    const manifest = await loadManifest();
    if (agentFilter) {
      await suggestFilterCorrection(agentFilter, "-a", agentKeys(manifest), resolveAgentKey, (k) => manifest.agents[k].name, manifest);
    }
    if (cloudFilter) {
      await suggestFilterCorrection(cloudFilter, "-c", cloudKeys(manifest), resolveCloudKey, (k) => manifest.clouds[k].name, manifest);
    }
  } catch {
    // Manifest unavailable -- skip suggestions
  }

  const totalRecords = filterHistory();
  if (totalRecords.length > 0) {
    p.log.info(`Run ${pc.cyan("spawn list")} to see all ${totalRecords.length} recorded spawn${totalRecords.length !== 1 ? "s" : ""}.`);
  }
}

function showListFooter(records: SpawnRecord[], agentFilter?: string, cloudFilter?: string): void {
  const latest = records[0];
  console.log(`Rerun last: ${pc.cyan(buildRetryCommand(latest.agent, latest.cloud, latest.prompt))}`);

  if (agentFilter || cloudFilter) {
    const totalRecords = filterHistory();
    console.log(pc.dim(`Showing ${records.length} of ${totalRecords.length} spawn${totalRecords.length !== 1 ? "s" : ""}`));
    console.log(pc.dim(`Clear filter: ${pc.cyan("spawn list")}`));
  } else {
    console.log(pc.dim(`${records.length} spawn${records.length !== 1 ? "s" : ""} recorded`));
    console.log(pc.dim(`Filter: ${pc.cyan("spawn list -a <agent>")}  or  ${pc.cyan("spawn list -c <cloud>")}  |  Clear: ${pc.cyan("spawn list --clear")}`));
  }
  console.log();
}

/** Resolve an agent/cloud key to its display name, or return the key as-is */
export function resolveDisplayName(manifest: Manifest | null, key: string, kind: "agent" | "cloud"): string {
  if (!manifest) return key;
  const entry = kind === "agent" ? manifest.agents[key] : manifest.clouds[key];
  return entry ? entry.name : key;
}

function renderListTable(records: SpawnRecord[], manifest: Manifest | null): void {
  console.log();
  console.log(pc.bold("AGENT".padEnd(20)) + pc.bold("CLOUD".padEnd(20)) + pc.bold("WHEN"));
  console.log(pc.dim("-".repeat(60)));

  for (const r of records) {
    const relative = formatRelativeTime(r.timestamp);
    const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
    const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
    let line =
      pc.green(agentDisplay.padEnd(20)) +
      cloudDisplay.padEnd(20) +
      pc.dim(relative);
    if (r.prompt) {
      const preview = r.prompt.length > 40 ? r.prompt.slice(0, 40) + "..." : r.prompt;
      line += pc.dim(`  --prompt "${preview}"`);
    }
    console.log(line);
  }
  console.log();
}

function isInteractiveTTY(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/** Build a display label for a spawn record in the interactive picker */
export function buildRecordLabel(r: SpawnRecord, manifest: Manifest | null): string {
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  return `${agentDisplay} on ${cloudDisplay}`;
}

/** Build a hint string (relative timestamp + optional prompt preview) for the interactive picker */
export function buildRecordHint(r: SpawnRecord): string {
  const relative = formatRelativeTime(r.timestamp);
  if (r.prompt) {
    const preview = r.prompt.length > 30 ? r.prompt.slice(0, 30) + "..." : r.prompt;
    return `${relative}  --prompt "${preview}"`;
  }
  return relative;
}

/** Try to load manifest and resolve filter display names to keys.
 *  When a bare positional filter doesn't match an agent, try it as a cloud. */
async function resolveListFilters(
  agentFilter?: string,
  cloudFilter?: string
): Promise<{ manifest: Manifest | null; agentFilter?: string; cloudFilter?: string }> {
  let manifest: Manifest | null = null;
  try {
    manifest = await loadManifest();
  } catch {
    // Manifest unavailable -- show raw keys
  }

  if (manifest && agentFilter) {
    const resolved = resolveAgentKey(manifest, agentFilter);
    if (resolved) {
      agentFilter = resolved;
    } else if (!cloudFilter) {
      // Bare positional arg didn't match an agent -- try as a cloud filter
      const resolvedCloud = resolveCloudKey(manifest, agentFilter);
      if (resolvedCloud) {
        cloudFilter = resolvedCloud;
        agentFilter = undefined;
      }
    }
  }
  if (manifest && cloudFilter) {
    const resolved = resolveCloudKey(manifest, cloudFilter);
    if (resolved) cloudFilter = resolved;
  }

  return { manifest, agentFilter, cloudFilter };
}

/** Show interactive picker to select and rerun a previous spawn */
async function interactiveListPicker(records: SpawnRecord[], manifest: Manifest | null): Promise<void> {
  p.log.info(pc.dim(`Filter: ${pc.cyan("spawn list -a <agent>")} or ${pc.cyan("spawn list -c <cloud>")}  |  Clear: ${pc.cyan("spawn list --clear")}`));

  const options = records.map((r, i) => ({
    value: i,
    label: buildRecordLabel(r, manifest),
    hint: buildRecordHint(r),
  }));

  const choice = await p.select({
    message: `Select a spawn to rerun (${records.length} recorded)`,
    options,
  });
  if (p.isCancel(choice)) {
    handleCancel();
  }

  const selected = records[choice];
  p.log.step(`Rerunning ${pc.bold(buildRecordLabel(selected, manifest))}`);
  await cmdRun(selected.agent, selected.cloud, selected.prompt);
}

export async function cmdListClear(): Promise<void> {
  const records = filterHistory();
  if (records.length === 0) {
    p.log.info("No spawn history to clear.");
    return;
  }

  if (isInteractiveTTY()) {
    const shouldClear = await p.confirm({
      message: `Delete ${records.length} spawn record${records.length !== 1 ? "s" : ""} from history?`,
      initialValue: false,
    });
    if (p.isCancel(shouldClear) || !shouldClear) {
      handleCancel();
    }
  }

  const count = clearHistory();
  p.log.success(`Cleared ${count} spawn record${count !== 1 ? "s" : ""} from history.`);
}

export async function cmdList(agentFilter?: string, cloudFilter?: string): Promise<void> {
  const resolved = await resolveListFilters(agentFilter, cloudFilter);
  const manifest = resolved.manifest;
  agentFilter = resolved.agentFilter;
  cloudFilter = resolved.cloudFilter;

  const records = filterHistory(agentFilter, cloudFilter);

  if (records.length === 0) {
    await showEmptyListMessage(agentFilter, cloudFilter);
    return;
  }

  if (isInteractiveTTY()) {
    await interactiveListPicker(records, manifest);
    return;
  }

  renderListTable(records, manifest);
  showListFooter(records, agentFilter, cloudFilter);
}

// ── Agents ─────────────────────────────────────────────────────────────────────

export function getImplementedAgents(manifest: Manifest, cloud: string): string[] {
  return agentKeys(manifest).filter(
    (a: string): boolean => matrixStatus(manifest, cloud, a) === "implemented"
  );
}

/** Extract environment variable names from a cloud's auth field (e.g. "HCLOUD_TOKEN" or "UPCLOUD_USERNAME + UPCLOUD_PASSWORD") */
export function parseAuthEnvVars(auth: string): string[] {
  return auth
    .split(/\s*\+\s*/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z][A-Z0-9_]{3,}$/.test(s));
}

/** Format an auth env var line showing whether it's already set or needs to be exported */
function formatAuthVarLine(varName: string, urlHint?: string): string {
  if (process.env[varName]) {
    return `  ${pc.green(varName)} ${pc.dim("-- set")}`;
  }
  const hint = urlHint ? `  ${pc.dim(`# ${urlHint}`)}` : "";
  return `  ${pc.cyan(`export ${varName}=...`)}${hint}`;
}

/** Check if a cloud's required auth env vars are all set in the environment */
export function hasCloudCredentials(auth: string): boolean {
  const vars = parseAuthEnvVars(auth);
  if (vars.length === 0) return false;
  return vars.every((v) => !!process.env[v]);
}

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
    const readyCount = implClouds.filter(c => hasCloudCredentials(manifest.clouds[c].auth)).length;
    if (readyCount > 0) totalReady++;
    const cloudStr = `${implClouds.length} cloud${implClouds.length !== 1 ? "s" : ""}`;
    const readyStr = readyCount > 0 ? `  ${pc.green(`${readyCount} ready`)}` : "";
    console.log(`  ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${a.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${cloudStr}  ${a.description}`)}${readyStr}`);
  }
  console.log();
  if (totalReady > 0) {
    console.log(pc.dim(`  ${pc.green("ready")} = credentials detected for at least one cloud`));
  }
  console.log(pc.dim(`  Run ${pc.cyan("spawn <agent>")} for details, or ${pc.cyan("spawn <agent> <cloud>")} to launch.`));
  console.log();
}

// ── Clouds ─────────────────────────────────────────────────────────────────────

/** Format credential status indicator for a cloud in the list view */
function formatCredentialIndicator(auth: string): string {
  if (auth.toLowerCase() === "none") return "";
  return hasCloudCredentials(auth)
    ? `  ${pc.green("ready")}`
    : `  ${pc.yellow("needs")} ${pc.dim(auth)}`;
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
      if (hasCloudCredentials(c.auth)) credCount++;
      const credIndicator = formatCredentialIndicator(c.auth);
      console.log(`    ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${c.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${countStr.padEnd(6)} ${c.description}`)}${credIndicator}`);
    }
  }
  console.log();
  if (credCount > 0) {
    console.log(pc.dim(`  ${pc.green("ready")} = credentials detected  ${pc.yellow("needs")} = credentials not set`));
  } else {
    console.log(pc.dim(`  ${pc.yellow("needs")} = credentials not set (run ${pc.cyan("spawn <cloud>")} for setup instructions)`));
  }
  console.log(pc.dim(`  Run ${pc.cyan("spawn <cloud>")} for setup instructions, or ${pc.cyan("spawn <agent> <cloud>")} to launch.`));
  console.log();
}

// ── Info helpers ───────────────────────────────────────────────────────────────

/** Print name, description, url, and notes for a manifest entry */
function printInfoHeader(entry: { name: string; description: string; url?: string; notes?: string }): void {
  console.log();
  console.log(`${pc.bold(entry.name)} ${pc.dim("--")} ${entry.description}`);
  if (entry.url) console.log(pc.dim(`  ${entry.url}`));
  if (entry.notes) console.log(pc.dim(`  ${entry.notes}`));
}

/** Group keys by a classifier function (e.g., cloud type) */
function groupByType(keys: string[], getType: (key: string) => string): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const key of keys) {
    const type = getType(key);
    if (!byType[type]) byType[type] = [];
    byType[type].push(key);
  }
  return byType;
}

/** Print a grouped list of items with command hints */
function printGroupedList(
  byType: Record<string, string[]>,
  getName: (key: string) => string,
  getHint: (key: string) => string,
  indent: string = "  "
): void {
  for (const [type, keys] of Object.entries(byType)) {
    console.log(`${indent}${pc.dim(type)}`);
    for (const key of keys) {
      console.log(`${indent}  ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${getName(key).padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(getHint(key))}`);
    }
  }
}

// ── Agent Info ─────────────────────────────────────────────────────────────────

export async function cmdAgentInfo(agent: string, preloadedManifest?: Manifest): Promise<void> {
  const [manifest, agentKey] = preloadedManifest
    ? [preloadedManifest, agent]
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

  console.log();
  console.log(pc.bold(`Available clouds:`) + pc.dim(` ${sortedClouds.length} of ${allClouds.length}`));
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
    (c) => {
      const hint = `spawn ${agentKey} ${c}`;
      return hasCloudCredentials(manifest.clouds[c].auth) ? `${hint}  ${pc.green("(credentials detected)")}` : hint;
    }
  );
  console.log();
}

/** Print quick-start instructions showing credential status and example spawn command */
function printQuickStart(opts: {
  auth: string;
  authVars: string[];
  cloudUrl?: string;
  spawnCmd?: string;
}): void {
  const hasCreds = hasCloudCredentials(opts.auth);
  const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
  const allReady = hasOpenRouterKey && (hasCreds || opts.authVars.length === 0);

  console.log();
  if (allReady && opts.spawnCmd) {
    console.log(pc.bold("Quick start:") + "  " + pc.green("credentials detected -- ready to go"));
    console.log(`  ${pc.cyan(opts.spawnCmd)}`);
    return;
  }

  console.log(pc.bold("Quick start:"));
  console.log(formatAuthVarLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys"));
  if (opts.authVars.length > 0) {
    for (let i = 0; i < opts.authVars.length; i++) {
      console.log(formatAuthVarLine(opts.authVars[i], i === 0 ? opts.cloudUrl : undefined));
    }
  } else if (opts.auth.toLowerCase() !== "none") {
    console.log(`  ${pc.dim(`Auth: ${opts.auth}`)}`);
  }
  if (opts.spawnCmd) {
    console.log(`  ${pc.cyan(opts.spawnCmd)}`);
  }
}

// ── Cloud Info ─────────────────────────────────────────────────────────────────

/** Print the list of implemented agents and any missing ones */
function printAgentList(
  manifest: Manifest,
  implAgents: string[],
  missingAgents: string[],
  cloudKey: string
): void {
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
}

export async function cmdCloudInfo(cloud: string, preloadedManifest?: Manifest): Promise<void> {
  const [manifest, cloudKey] = preloadedManifest
    ? [preloadedManifest, cloud]
    : await validateAndGetEntity(cloud, "cloud");

  const c = manifest.clouds[cloudKey];
  printInfoHeader(c);
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
  console.log(pc.bold(`Available agents:`) + pc.dim(` ${implAgents.length} of ${allAgents.length}`));
  console.log();

  printAgentList(manifest, implAgents, missingAgents, cloudKey);

  console.log();
  console.log(pc.dim(`  Full setup guide: ${pc.cyan(`https://github.com/${REPO}/tree/main/${cloudKey}`)}`));
  console.log();
}

// ── Update ─────────────────────────────────────────────────────────────────────

async function fetchRemoteVersion(): Promise<string> {
  const res = await fetch(`${RAW_BASE}/cli/package.json`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const remotePkg = (await res.json()) as { version: string };
  return remotePkg.version;
}

const INSTALL_CMD = `curl -fsSL ${RAW_BASE}/cli/install.sh | bash`;

async function performUpdate(remoteVersion: string): Promise<void> {
  const { execSync } = await import("child_process");
  try {
    execSync(INSTALL_CMD, { stdio: "inherit", shell: "/bin/bash" });
    console.log();
    p.log.success(`Updated to v${remoteVersion}`);
    p.log.info("Run your spawn command again to use the new version.");
  } catch {
    p.log.error("Auto-update failed. Update manually:");
    console.log();
    console.log(`  ${pc.cyan(INSTALL_CMD)}`);
    console.log();
  }
}

export async function cmdUpdate(): Promise<void> {
  const s = p.spinner();
  s.start("Checking for updates...");

  try {
    const remoteVersion = await fetchRemoteVersion();

    if (remoteVersion === VERSION) {
      s.stop(`Already up to date ${pc.dim(`(v${VERSION})`)}`);
      return;
    }

    s.stop(`Updating: v${VERSION} -> v${remoteVersion}`);
    await performUpdate(remoteVersion);
  } catch (err) {
    s.stop(pc.red("Failed to check for updates") + pc.dim(` (current: v${VERSION})`));
    console.error("Error:", getErrorMessage(err));
    console.error(`\nHow to fix:`);
    console.error(`  1. Check your internet connection`);
    console.error(`  2. Try again in a few moments`);
    console.error(`  3. Update manually: ${pc.cyan(INSTALL_CMD)}`);
  }
}

// ── Help ───────────────────────────────────────────────────────────────────────

export function cmdHelp(): void {
  console.log(`
${pc.bold("spawn")} -- Launch any AI coding agent on any cloud

${pc.bold("USAGE")}
  spawn                              Interactive agent + cloud picker
  spawn <agent> <cloud>              Launch agent on cloud directly
  spawn <agent> <cloud> --dry-run    Preview what would be provisioned (or -n)
  spawn <agent> <cloud> --prompt "text"
                                     Execute agent with prompt (non-interactive)
  spawn <agent> <cloud> --prompt-file <file>  (or -f)
                                     Execute agent with prompt from file
  spawn <agent>                      Show available clouds for agent
  spawn <cloud>                      Show available agents for cloud
  spawn list                         Browse and rerun previous spawns (aliases: ls, history)
  spawn list <filter>                Filter history by agent or cloud name
  spawn list -a <agent>              Filter spawn history by agent (or --agent)
  spawn list -c <cloud>              Filter spawn history by cloud (or --cloud)
  spawn list --clear                 Clear all spawn history
  spawn matrix                       Full availability matrix (alias: m)
  spawn agents                       List all agents with descriptions
  spawn clouds                       List all cloud providers
  spawn update                       Check for CLI updates
  spawn version                      Show version (or --version, -v)
  spawn help                         Show this help message (or --help, -h)

${pc.bold("EXAMPLES")}
  spawn                              ${pc.dim("# Pick interactively")}
  spawn claude sprite                ${pc.dim("# Launch Claude Code on Sprite")}
  spawn aider hetzner                ${pc.dim("# Launch Aider on Hetzner Cloud")}
  spawn claude sprite --prompt "Fix all linter errors"
                                     ${pc.dim("# Execute Claude with prompt and exit")}
  spawn aider sprite -p "Add tests"  ${pc.dim("# Short form of --prompt")}
  spawn claude sprite -f instructions.txt
                                     ${pc.dim("# Read prompt from file (short for --prompt-file)")}
  spawn claude sprite --dry-run      ${pc.dim("# Preview without provisioning")}
  spawn claude                       ${pc.dim("# Show which clouds support Claude")}
  spawn hetzner                      ${pc.dim("# Show which agents run on Hetzner")}
  spawn list                         ${pc.dim("# Browse history and pick one to rerun")}
  spawn list claude                  ${pc.dim("# Filter history by agent name")}
  spawn matrix                       ${pc.dim("# See the full agent x cloud matrix")}

${pc.bold("AUTHENTICATION")}
  All agents use OpenRouter for LLM access. Get your API key at:
  ${pc.cyan("https://openrouter.ai/settings/keys")}

  For non-interactive use, set environment variables:
  ${pc.dim("OPENROUTER_API_KEY")}=sk-or-v1-... spawn claude sprite

  Each cloud provider has its own auth requirements.
  Run ${pc.cyan("spawn <cloud>")} to see setup instructions for a specific provider.

${pc.bold("INSTALL")}
  curl -fsSL ${RAW_BASE}/cli/install.sh | bash

${pc.bold("TROUBLESHOOTING")}
  ${pc.dim("*")} Script not found: Run ${pc.cyan("spawn matrix")} to verify the combination exists
  ${pc.dim("*")} Missing credentials: Run ${pc.cyan("spawn <cloud>")} to see setup instructions
  ${pc.dim("*")} Update issues: Try ${pc.cyan("spawn update")} or reinstall manually
  ${pc.dim("*")} Garbled unicode: Set ${pc.cyan("SPAWN_NO_UNICODE=1")} for ASCII-only output
  ${pc.dim("*")} Missing unicode over SSH: Set ${pc.cyan("SPAWN_UNICODE=1")} to force unicode on
  ${pc.dim("*")} Slow startup: Set ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")} to skip auto-update

${pc.bold("ENVIRONMENT VARIABLES")}
  ${pc.cyan("OPENROUTER_API_KEY")}        OpenRouter API key (all agents require this)
  ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")}   Skip auto-update check on startup
  ${pc.cyan("SPAWN_NO_UNICODE=1")}        Force ASCII output (no unicode symbols)
  ${pc.cyan("SPAWN_UNICODE=1")}           Force Unicode output (override auto-detection)
  ${pc.cyan("SPAWN_HOME")}                Override spawn data directory (default: ~/.spawn)
  ${pc.cyan("SPAWN_DEBUG=1")}             Show debug output (unicode detection, etc.)

${pc.bold("MORE INFO")}
  Repository:  https://github.com/${REPO}
  OpenRouter:  https://openrouter.ai
`);
}

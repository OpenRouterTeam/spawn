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
import { saveSpawnRecord, filterHistory, type SpawnRecord } from "./history.js";

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
  return withSpinner("Loading manifest...", loadManifest);
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
    p.log.info(`Run ${pc.cyan("spawn matrix")} to see the full availability matrix.`);
    process.exit(1);
  }

  const { sortedClouds, hintOverrides, credCount } = prioritizeCloudsByCredentials(clouds, manifest);

  if (credCount > 0) {
    p.log.info(`${credCount} cloud${credCount > 1 ? "s" : ""} with credentials detected`);
  }

  const cloudChoice = await p.select({
    message: "Select a cloud provider",
    options: mapToSelectOptions(sortedClouds, manifest.clouds, hintOverrides),
  });
  if (p.isCancel(cloudChoice)) handleCancel();

  const agentName = manifest.agents[agentChoice].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${agentChoice} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");

  await execScript(cloudChoice, agentChoice, undefined, getAuthHint(manifest, cloudChoice));
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

  if (prompt) {
    printDryRunSection("Prompt", [`  ${prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt}`]);
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

  const agentName = manifest.agents[agent].name;
  const cloudName = manifest.clouds[cloud].name;
  const suffix = prompt ? " with prompt..." : "...";
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}${suffix}`);

  await execScript(cloud, agent, prompt, getAuthHint(manifest, cloud));
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
    p.log.error(`Script download failed (HTTP ${primaryStatus}/${fallbackStatus})`);
    console.error(`\nBoth download sources returned errors.`);
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

function credentialHints(cloud: string, authHint?: string, verb = "Missing or invalid"): string[] {
  if (authHint) {
    return [
      `  - ${verb} credentials (need ${pc.cyan(authHint)} + ${pc.cyan("OPENROUTER_API_KEY")})`,
      `    Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions`,
    ];
  }
  return [
    `  - ${verb} credentials (run ${pc.cyan(`spawn ${cloud}`)} for setup)`,
  ];
}

export function getScriptFailureGuidance(exitCode: number | null, cloud: string, authHint?: string): string[] {
  switch (exitCode) {
    case 130:
      return [
        "Script was interrupted (Ctrl+C).",
        "Note: If a server was already created, it may still be running.",
        "  Check your cloud provider dashboard to stop or delete any unused servers.",
      ];
    case 137:
      return [
        "Script was killed (likely by the system due to timeout or out of memory).",
        "  - The server may not have enough RAM for this agent",
        "  - Try a larger instance size or a different cloud provider",
        "  - Check your cloud provider dashboard to stop or delete any unused servers",
      ];
    case 255:
      return [
        "SSH connection failed. Common causes:",
        "  - Server is still booting (wait a moment and retry)",
        "  - Firewall blocking SSH port 22",
        "  - Server was terminated before the session started",
      ];
    case 127:
      return [
        "A required command was not found. Check that these are installed:",
        "  - bash, curl, ssh, jq",
        `  - Cloud-specific CLI tools (run ${pc.cyan(`spawn ${cloud}`)} for details)`,
      ];
    case 126:
      return [
        "A command was found but could not be executed (permission denied).",
        "  - A downloaded binary may lack execute permissions",
        "  - The script may require root/sudo access",
        `  - Report it if this persists: ${pc.cyan(`https://github.com/OpenRouterTeam/spawn/issues`)}`,
      ];
    case 2:
      return [
        "Shell syntax or argument error. This is likely a bug in the script.",
        `  Report it at: ${pc.cyan(`https://github.com/OpenRouterTeam/spawn/issues`)}`,
      ];
    case 1:
      return [
        "Common causes:",
        ...credentialHints(cloud, authHint),
        "  - Cloud provider API error (quota, rate limit, or region issue)",
        "  - Server provisioning failed (try again or pick a different region)",
      ];
    default:
      return [
        "Common causes:",
        ...credentialHints(cloud, authHint, "Missing"),
        "  - Cloud provider API rate limit or quota exceeded",
        "  - Missing local dependencies (SSH, curl, jq)",
      ];
  }
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

function reportScriptFailure(errMsg: string, cloud: string, agent: string, authHint?: string, prompt?: string): never {
  p.log.error("Spawn script failed");
  console.error("\nError:", errMsg);

  const exitCodeMatch = errMsg.match(/exited with code (\d+)/);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;

  const lines = getScriptFailureGuidance(exitCode, cloud, authHint);
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

async function execScript(cloud: string, agent: string, prompt?: string, authHint?: string): Promise<void> {
  const url = `https://openrouter.ai/lab/spawn/${cloud}/${agent}.sh`;
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

  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      await runBash(scriptContent, prompt);
      return; // success
    } catch (err) {
      const errMsg = getErrorMessage(err);
      if (errMsg.includes("interrupted by user")) {
        console.error();
        p.log.warn("Script interrupted (Ctrl+C).");
        p.log.warn("If a server was already created, it may still be running.");
        p.log.warn(`  Check your cloud provider dashboard to stop or delete any unused servers.`);
        process.exit(130);
      }
      lastErr = errMsg;

      // Only retry for potentially transient failures
      if (attempt <= MAX_RETRIES && isRetryableExitCode(errMsg)) {
        const delay = RETRY_DELAYS[attempt - 1];
        p.log.warn(`Script failed (${errMsg}). Retrying in ${delay}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }

      // Non-retryable or out of retries
      break;
    }
  }

  reportScriptFailure(lastErr!, cloud, agent, authHint, prompt);
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
  console.log(pc.bold("Agent".padEnd(COMPACT_NAME_WIDTH)) + pc.bold("Clouds".padEnd(COMPACT_COUNT_WIDTH)) + pc.bold("Not yet available"));
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

function renderMatrixFooter(manifest: Manifest, agents: string[], clouds: string[], isCompact: boolean): void {
  const impl = countImplemented(manifest);
  const total = agents.length * clouds.length;
  console.log();
  if (isCompact) {
    console.log(`${pc.green("green")} = all clouds supported  ${pc.yellow("yellow")} = some clouds not yet available`);
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

function formatTimestamp(iso: string): string {
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
  if (latest.prompt) {
    const shortPrompt = latest.prompt.length > 30 ? latest.prompt.slice(0, 30) + "..." : latest.prompt;
    // Escape double quotes so the suggested command is valid shell
    const safePrompt = shortPrompt.replace(/"/g, '\\"');
    console.log(`Rerun last: ${pc.cyan(`spawn ${latest.agent} ${latest.cloud} --prompt "${safePrompt}"`)}`);
  } else {
    console.log(`Rerun last: ${pc.cyan(`spawn ${latest.agent} ${latest.cloud}`)}`);
  }

  if (agentFilter || cloudFilter) {
    const totalRecords = filterHistory();
    console.log(pc.dim(`Showing ${records.length} of ${totalRecords.length} spawn${totalRecords.length !== 1 ? "s" : ""}`));
    console.log(pc.dim(`Clear filter: ${pc.cyan("spawn list")}`));
  } else {
    console.log(pc.dim(`${records.length} spawn${records.length !== 1 ? "s" : ""} recorded`));
    console.log(pc.dim(`Filter: ${pc.cyan("spawn list -a <agent>")}  or  ${pc.cyan("spawn list -c <cloud>")}`));
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
    const when = formatTimestamp(r.timestamp);
    const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
    const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
    let line =
      pc.green(agentDisplay.padEnd(20)) +
      cloudDisplay.padEnd(20) +
      pc.dim(when);
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
function buildRecordLabel(r: SpawnRecord, manifest: Manifest | null): string {
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  return `${agentDisplay} on ${cloudDisplay}`;
}

/** Build a hint string (timestamp + optional prompt preview) for the interactive picker */
function buildRecordHint(r: SpawnRecord): string {
  const when = formatTimestamp(r.timestamp);
  if (r.prompt) {
    const preview = r.prompt.length > 30 ? r.prompt.slice(0, 30) + "..." : r.prompt;
    return `${when}  --prompt "${preview}"`;
  }
  return when;
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

/** Check if a cloud's required auth env vars are all set in the environment */
export function hasCloudCredentials(auth: string): boolean {
  const vars = parseAuthEnvVars(auth);
  if (vars.length === 0) return false;
  return vars.every((v) => !!process.env[v]);
}

export async function cmdAgents(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const allAgents = agentKeys(manifest);
  console.log();
  console.log(pc.bold("Agents") + pc.dim(` (${allAgents.length} total)`));
  console.log();
  for (const key of allAgents) {
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

  const byType = groupByType(allClouds, (key) => manifest.clouds[key].type);

  console.log();
  console.log(pc.bold("Cloud Providers") + pc.dim(` (${allClouds.length} total)`));

  for (const [type, keys] of Object.entries(byType)) {
    console.log();
    console.log(`  ${pc.dim(type)}`);
    for (const key of keys) {
      const c = manifest.clouds[key];
      const implCount = getImplementedAgents(manifest, key).length;
      const countStr = `${implCount}/${allAgents.length}`;
      const authHint = c.auth.toLowerCase() === "none" ? "" : `  auth: ${c.auth}`;
      console.log(`    ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${c.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${countStr.padEnd(6)} ${c.description}`)}${authHint ? pc.dim(authHint) : ""}`);
    }
  }
  console.log();
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

export async function cmdAgentInfo(agent: string): Promise<void> {
  const [manifest, agentKey] = await validateAndGetEntity(agent, "agent");

  const agentDef = manifest.agents[agentKey];
  printInfoHeader(agentDef);
  if (agentDef.install) {
    console.log(pc.dim(`  Install: ${agentDef.install}`));
  }

  const allClouds = cloudKeys(manifest);
  const implClouds = getImplementedClouds(manifest, agentKey);

  // Show quick-start with first available cloud
  if (implClouds.length > 0) {
    const exampleCloud = implClouds[0];
    const cloudDef = manifest.clouds[exampleCloud];
    const authVars = parseAuthEnvVars(cloudDef.auth);
    console.log();
    console.log(pc.bold("Quick start:"));
    console.log(`  ${pc.cyan("export OPENROUTER_API_KEY=sk-or-v1-...")}  ${pc.dim("# https://openrouter.ai/settings/keys")}`);
    if (authVars.length > 0) {
      const hint = cloudDef.url ? `  ${pc.dim(`# ${cloudDef.url}`)}` : `  ${pc.dim(`# ${cloudDef.name} credential`)}`;
      console.log(`  ${pc.cyan(`export ${authVars[0]}=...`)}${hint}`);
    }
    console.log(`  ${pc.cyan(`spawn ${agentKey} ${exampleCloud}`)}`);
  }

  console.log();
  console.log(pc.bold(`Available clouds:`) + pc.dim(` ${implClouds.length} of ${allClouds.length}`));
  console.log();

  if (implClouds.length === 0) {
    console.log(pc.dim("  No implemented clouds yet."));
    console.log();
    return;
  }

  const byType = groupByType(implClouds, (c) => manifest.clouds[c].type);
  printGroupedList(
    byType,
    (c) => manifest.clouds[c].name,
    (c) => `spawn ${agentKey} ${c}`
  );
  console.log();
}

// ── Cloud Info ─────────────────────────────────────────────────────────────────

/** Print quick-start auth instructions for a cloud provider */
function printCloudQuickStart(
  cloud: { auth: string; url?: string },
  authVars: string[],
  exampleAgent: string | undefined,
  cloudKey: string
): void {
  console.log();
  console.log(pc.bold("Quick start:"));
  console.log(`  ${pc.cyan("export OPENROUTER_API_KEY=sk-or-v1-...")}  ${pc.dim("# https://openrouter.ai/settings/keys")}`);
  if (authVars.length > 0) {
    const hint = cloud.url ? `  ${pc.dim(`# ${cloud.url}`)}` : "";
    for (let i = 0; i < authVars.length; i++) {
      // Only show the URL hint on the first auth var to avoid repetition
      console.log(`  ${pc.cyan(`export ${authVars[i]}=...`)}${i === 0 ? hint : ""}`);
    }
  } else if (cloud.auth.toLowerCase() !== "none") {
    console.log(`  ${pc.dim(`Auth: ${cloud.auth}`)}`);
  }
  if (exampleAgent) {
    console.log(`  ${pc.cyan(`spawn ${exampleAgent} ${cloudKey}`)}`);
  }
}

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

export async function cmdCloudInfo(cloud: string): Promise<void> {
  const [manifest, cloudKey] = await validateAndGetEntity(cloud, "cloud");

  const c = manifest.clouds[cloudKey];
  printInfoHeader(c);
  console.log(pc.dim(`  Type: ${c.type}  |  Auth: ${c.auth}`));

  const authVars = parseAuthEnvVars(c.auth);
  const implAgents = getImplementedAgents(manifest, cloudKey);
  printCloudQuickStart(c, authVars, implAgents[0], cloudKey);

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
  if (!res.ok) throw new Error("fetch failed");
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

const HELP_COL = 37; // description column offset (after 2-char indent)

interface HelpEntry {
  cmd: string;
  desc: string;
  /** Extra description line(s) that appear below, aligned to the description column */
  extra?: string;
}

/** Format a two-column help entry, wrapping description to next line if cmd is too wide */
function fmtEntry(e: HelpEntry, fmtDesc: (s: string) => string = (s) => s): string {
  const pad = HELP_COL - e.cmd.length;
  const descLine = pad >= 2
    ? `  ${e.cmd}${" ".repeat(pad)}${fmtDesc(e.desc)}`
    : `  ${e.cmd}\n${" ".repeat(HELP_COL + 2)}${fmtDesc(e.desc)}`;
  return e.extra ? `${descLine}\n${" ".repeat(HELP_COL + 2)}${fmtDesc(e.extra)}` : descLine;
}

const USAGE_ENTRIES: HelpEntry[] = [
  { cmd: "spawn", desc: "Interactive agent + cloud picker" },
  { cmd: "spawn <agent> <cloud>", desc: "Launch agent on cloud directly" },
  { cmd: "spawn <agent> <cloud> --dry-run", desc: "Preview what would be provisioned (or -n)" },
  { cmd: 'spawn <agent> <cloud> --prompt "text"', desc: "Execute agent with prompt (non-interactive)" },
  { cmd: "spawn <agent> <cloud> --prompt-file <file>  (or -f)", desc: "Execute agent with prompt from file" },
  { cmd: "spawn <agent>", desc: "Show available clouds for agent" },
  { cmd: "spawn <cloud>", desc: "Show available agents for cloud" },
  { cmd: "spawn list", desc: "Browse and rerun previous spawns" },
  { cmd: "spawn list <filter>", desc: "Filter history by agent or cloud name" },
  { cmd: "spawn list -a <agent>", desc: "Filter spawn history by agent (or --agent)" },
  { cmd: "spawn list -c <cloud>", desc: "Filter spawn history by cloud (or --cloud)", extra: "Aliases: ls, history" },
  { cmd: "spawn matrix", desc: "Full availability matrix (alias: m)" },
  { cmd: "spawn agents", desc: "List all agents with descriptions" },
  { cmd: "spawn clouds", desc: "List all cloud providers" },
  { cmd: "spawn update", desc: "Check for CLI updates" },
  { cmd: "spawn version", desc: "Show version" },
  { cmd: "spawn help", desc: "Show this help message" },
];

const EXAMPLE_ENTRIES: HelpEntry[] = [
  { cmd: "spawn", desc: "# Pick interactively" },
  { cmd: "spawn claude sprite", desc: "# Launch Claude Code on Sprite" },
  { cmd: "spawn aider hetzner", desc: "# Launch Aider on Hetzner Cloud" },
  { cmd: 'spawn claude sprite --prompt "Fix all linter errors"', desc: "# Execute Claude with prompt and exit" },
  { cmd: 'spawn aider sprite -p "Add tests"', desc: "# Short form of --prompt" },
  { cmd: "spawn claude sprite -f instructions.txt", desc: "# Read prompt from file (short for --prompt-file)" },
  { cmd: "spawn claude sprite --dry-run", desc: "# Preview without provisioning" },
  { cmd: "spawn claude", desc: "# Show which clouds support Claude" },
  { cmd: "spawn hetzner", desc: "# Show which agents run on Hetzner" },
  { cmd: "spawn list", desc: "# Browse history and pick one to rerun" },
  { cmd: "spawn list claude", desc: "# Filter history by agent name" },
  { cmd: "spawn matrix", desc: "# See the full agent x cloud matrix" },
];

const TROUBLESHOOTING_ENTRIES = [
  `Script not found: Run ${pc.cyan("spawn matrix")} to verify the combination exists`,
  `Missing credentials: Run ${pc.cyan("spawn <cloud>")} to see setup instructions`,
  `Update issues: Try ${pc.cyan("spawn update")} or reinstall manually`,
  `Garbled unicode: Set ${pc.cyan("SPAWN_NO_UNICODE=1")} for ASCII-only output`,
  `Slow startup: Set ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")} to skip auto-update`,
];

const ENV_VAR_ENTRIES: [string, string][] = [
  ["OPENROUTER_API_KEY", "OpenRouter API key (all agents require this)"],
  ["SPAWN_NO_UPDATE_CHECK=1", "Skip auto-update check on startup"],
  ["SPAWN_NO_UNICODE=1", "Force ASCII output (no unicode symbols)"],
  ["SPAWN_HOME", "Override spawn data directory (default: ~/.spawn)"],
  ["SPAWN_DEBUG=1", "Show debug output (unicode detection, etc.)"],
];

function fmtEnvVar([name, desc]: [string, string]): string {
  const colored = pc.cyan(name);
  // Pad based on the raw (uncolored) name length to align descriptions
  const pad = HELP_COL - name.length;
  return `  ${colored}${" ".repeat(pad)}${desc}`;
}

export function cmdHelp(): void {
  const usage = USAGE_ENTRIES.map((e) => fmtEntry(e)).join("\n");
  const examples = EXAMPLE_ENTRIES.map((e) => fmtEntry(e, pc.dim)).join("\n");
  const troubleshooting = TROUBLESHOOTING_ENTRIES.map((t) => `  ${pc.dim("*")} ${t}`).join("\n");
  const envVars = ENV_VAR_ENTRIES.map(fmtEnvVar).join("\n");

  console.log(`
${pc.bold("spawn")} -- Launch any AI coding agent on any cloud

${pc.bold("USAGE")}
${usage}

${pc.bold("EXAMPLES")}
${examples}

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
${troubleshooting}

${pc.bold("ENVIRONMENT VARIABLES")}
${envVars}

${pc.bold("MORE INFO")}
  Repository:  https://github.com/${REPO}
  OpenRouter:  https://openrouter.ai
`);
}

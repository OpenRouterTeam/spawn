import "./unicode-detect.js"; // Must be first: configures TERM before clack reads it
import * as p from "@clack/prompts";
import pc from "picocolors";
import * as v from "valibot";
import { parseJsonWith, isString } from "@openrouter/spawn-shared";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Manifest } from "./manifest.js";
import {
  loadManifest,
  agentKeys,
  cloudKeys,
  matrixStatus,
  countImplemented,
  isStaleCache,
  RAW_BASE,
  REPO,
} from "./manifest.js";
import pkg from "../package.json" with { type: "json" };
const VERSION = pkg.version;
import {
  validateIdentifier,
  validateScriptContent,
  validatePrompt,
  validateConnectionIP,
  validateUsername,
  validateServerIdentifier,
  validateMetadataValue,
  validateLaunchCmd,
} from "./security.js";
import type { SpawnRecord, VMConnection } from "./history.js";
import {
  saveSpawnRecord,
  filterHistory,
  clearHistory,
  markRecordDeleted,
  removeRecord,
  getActiveServers,
  getHistoryPath,
} from "./history.js";
import { buildDashboardHint, EXIT_CODE_GUIDANCE, SIGNAL_GUIDANCE } from "./guidance-data.js";
import { destroyServer as hetznerDestroyServer, ensureHcloudToken } from "./hetzner/hetzner.js";
import { destroyServer as doDestroyServer, ensureDoToken } from "./digitalocean/digitalocean.js";
import {
  destroyInstance as gcpDestroyInstance,
  ensureGcloudCli as gcpEnsureGcloudCli,
  authenticate as gcpAuthenticate,
  resolveProject as gcpResolveProject,
} from "./gcp/gcp.js";
import { destroyServer as awsDestroyServer, ensureAwsCli, authenticate as awsAuthenticate } from "./aws/aws.js";
import { destroyServer as daytonaDestroyServer, ensureDaytonaToken } from "./daytona/daytona.js";
import { destroyServer as spriteDestroyServer, ensureSpriteCli, ensureSpriteAuthenticated } from "./sprite/sprite.js";
import { SSH_INTERACTIVE_OPTS, spawnInteractive } from "./shared/ssh.js";
import { toKebabCase, prepareStdinForHandoff } from "./shared/ui.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const PkgVersionSchema = v.object({
  version: v.string(),
});

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
    p.log.error(`${fieldName} is required but was not provided.`);
    p.log.info(`Run ${pc.cyan(helpCommand)} to see all available options.`);
    process.exit(1);
  }
}

function mapToSelectOptions<
  T extends {
    name: string;
    description: string;
  },
>(
  keys: string[],
  items: Record<string, T>,
  hintOverrides?: Record<string, string>,
): Array<{
  value: string;
  label: string;
  hint: string;
}> {
  return keys.map((key) => ({
    value: key,
    label: items[key].name,
    hint: hintOverrides?.[key] ?? items[key].description,
  }));
}

export function getImplementedClouds(manifest: Manifest, agent: string): string[] {
  return cloudKeys(manifest).filter((c: string): boolean => matrixStatus(manifest, c, agent) === "implemented");
}

/** Levenshtein distance between two strings */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from(
    {
      length: m + 1,
    },
    () => Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Find the closest match from a list of candidates (max distance 3) */
export function findClosestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
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
  getName: (key: string) => string,
): string | null {
  let bestKey: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
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
  if (collection[input]) {
    return input;
  }
  const keys = getEntityKeys(manifest, kind);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) {
      return key;
    }
  }
  for (const key of keys) {
    if (collection[key].name.toLowerCase() === lower) {
      return key;
    }
  }
  return null;
}

export function resolveAgentKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "agent");
}

export function resolveCloudKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "cloud");
}

interface EntityDef {
  label: string;
  labelPlural: string;
  listCmd: string;
  opposite: string;
}
const ENTITY_DEFS: Record<"agent" | "cloud", EntityDef> = {
  agent: {
    label: "agent",
    labelPlural: "agents",
    listCmd: "spawn agents",
    opposite: "cloud provider",
  },
  cloud: {
    label: "cloud",
    labelPlural: "clouds",
    listCmd: "spawn clouds",
    opposite: "agent",
  },
};

function getEntityCollection(manifest: Manifest, kind: "agent" | "cloud") {
  return kind === "agent" ? manifest.agents : manifest.clouds;
}

function getEntityKeys(manifest: Manifest, kind: "agent" | "cloud") {
  return kind === "agent" ? agentKeys(manifest) : cloudKeys(manifest);
}

/** Suggest a typo correction by fuzzy-matching against a set of keys */
function suggestTypoCorrection(value: string, manifest: Manifest, kind: "agent" | "cloud"): string | null {
  const collection = getEntityCollection(manifest, kind);
  const keys = getEntityKeys(manifest, kind);
  return findClosestKeyByNameOrKey(value, keys, (k) => collection[k].name);
}

/** Check if user provided an entity of the wrong kind and suggest correction */
function checkWrongKind(value: string, kind: "agent" | "cloud", manifest: Manifest, def: EntityDef): boolean {
  const oppositeKind = kind === "agent" ? "cloud" : "agent";
  const oppositeCollection = getEntityCollection(manifest, oppositeKind);

  if (oppositeCollection[value]) {
    const kindLabel = kind === "agent" ? "a cloud provider" : "an agent";
    const wrongLabel = kind === "agent" ? "an agent" : "a cloud provider";
    p.log.info(`"${value}" is ${kindLabel}, not ${wrongLabel}.`);
    p.log.info(`Usage: ${pc.cyan("spawn <agent> <cloud>")}`);
    p.log.info(`Run ${pc.cyan(def.listCmd)} to see available ${def.labelPlural}.`);
    return true;
  }
  return false;
}

/** Check for typo in same kind and suggest correction */
function checkSameKindTypo(
  value: string,
  kind: "agent" | "cloud",
  manifest: Manifest,
  def: EntityDef,
  collection: Record<
    string,
    {
      name: string;
    }
  >,
): boolean {
  const match = suggestTypoCorrection(value, manifest, kind);
  if (match) {
    p.log.info(`Did you mean ${pc.cyan(match)} (${collection[match].name})?`);
    p.log.info(`  ${pc.cyan(`spawn ${match}`)}`);
    p.log.info(`Run ${pc.cyan(def.listCmd)} to see available ${def.labelPlural}.`);
    return true;
  }
  return false;
}

/** Check for typo in opposite kind (swapped arguments) and suggest correction */
function checkOppositeKindTypo(value: string, kind: "agent" | "cloud", manifest: Manifest): boolean {
  const oppositeKind = kind === "agent" ? "cloud" : "agent";
  const oppositeMatch = suggestTypoCorrection(value, manifest, oppositeKind);

  if (oppositeMatch) {
    const oppositeDef = ENTITY_DEFS[oppositeKind];
    const oppositeCollection = getEntityCollection(manifest, oppositeKind);
    p.log.info(
      `"${pc.bold(value)}" looks like ${oppositeDef.label} ${pc.cyan(oppositeMatch)} (${oppositeCollection[oppositeMatch].name}).`,
    );
    p.log.info("Did you swap the agent and cloud arguments?");
    p.log.info(`Usage: ${pc.cyan("spawn <agent> <cloud>")}`);
    return true;
  }
  return false;
}

/** Report validation error for an entity and return false, or return true if valid */
export function checkEntity(manifest: Manifest, value: string, kind: "agent" | "cloud"): boolean {
  const def = ENTITY_DEFS[kind];
  const collection = getEntityCollection(manifest, kind);
  if (collection[value]) {
    return true;
  }

  p.log.error(`Unknown ${def.label}: ${pc.bold(value)}`);

  // Try different correction strategies
  if (checkWrongKind(value, kind, manifest, def)) {
    return false;
  }
  if (checkSameKindTypo(value, kind, manifest, def, collection)) {
    return false;
  }
  if (checkOppositeKindTypo(value, kind, manifest)) {
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

async function validateAndGetEntity(
  value: string,
  kind: "agent" | "cloud",
): Promise<
  [
    manifest: Manifest,
    key: string,
  ]
> {
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

  return [
    manifest,
    value,
  ];
}

function validateImplementation(manifest: Manifest, cloud: string, agent: string): void {
  const status = matrixStatus(manifest, cloud, agent);
  if (status !== "implemented") {
    const agentName = manifest.agents[agent].name;
    const cloudName = manifest.clouds[cloud].name;
    p.log.error(`${agentName} on ${cloudName} is not yet implemented.`);

    const availableClouds = getImplementedClouds(manifest, agent);
    if (availableClouds.length > 0) {
      // Prioritize clouds where the user already has credentials
      const { sortedClouds, credCount } = prioritizeCloudsByCredentials(availableClouds, manifest);
      const examples = sortedClouds.slice(0, 3).map((c) => {
        const hasCredsMarker = hasCloudCredentials(manifest.clouds[c].auth) ? " (ready)" : "";
        return `spawn ${agent} ${c}${hasCredsMarker}`;
      });
      console.log();
      p.log.info(
        `${agentName} is available on ${availableClouds.length} cloud${availableClouds.length > 1 ? "s" : ""}. Try one of these:`,
      );
      for (const cmd of examples) {
        p.log.info(`  ${pc.cyan(cmd)}`);
      }
      if (availableClouds.length > 3) {
        p.log.info(`\nRun ${pc.cyan(`spawn ${agent}`)} to see all ${availableClouds.length} options.`);
      }
      if (credCount > 0) {
        console.log();
        p.log.info(`${pc.green("ready")} = credentials already set`);
      }
    } else {
      console.log();
      p.log.info("This agent has no implemented cloud providers yet.");
      p.log.info(`Run ${pc.cyan("spawn matrix")} to see the full availability matrix.`);
    }
    process.exit(1);
  }
}

// ── Interactive ────────────────────────────────────────────────────────────────

/** Map of cloud keys to their CLI tool names */
const CLOUD_CLI_MAP: Record<string, string> = {
  gcp: "gcloud",
  aws: "aws",

  sprite: "sprite",
  hetzner: "hcloud",
  digitalocean: "doctl",
};

/** Check if the relevant CLI tool for a cloud provider is installed */
export function hasCloudCli(cloud: string): boolean {
  const cli = CLOUD_CLI_MAP[cloud];
  if (!cli) {
    return false;
  }
  return Bun.which(cli) !== null;
}

/** Sort clouds by credential/CLI availability and build hint overrides for the picker.
 *  Four tiers: credentials set > featured cloud > CLI installed > neither. */
export function prioritizeCloudsByCredentials(
  clouds: string[],
  manifest: Manifest,
  featuredCloud?: string[],
): {
  sortedClouds: string[];
  hintOverrides: Record<string, string>;
  credCount: number;
  cliCount: number;
} {
  const withCreds: string[] = [];
  const featured: string[] = [];
  const withCli: string[] = [];
  const rest: string[] = [];
  for (const c of clouds) {
    if (hasCloudCredentials(manifest.clouds[c].auth)) {
      withCreds.push(c);
    } else if (featuredCloud?.includes(c)) {
      featured.push(c);
    } else if (hasCloudCli(c)) {
      withCli.push(c);
    } else {
      rest.push(c);
    }
  }

  const hintOverrides: Record<string, string> = {};
  for (const c of withCreds) {
    hintOverrides[c] = `credentials detected -- ${manifest.clouds[c].description}`;
  }
  for (const c of featured) {
    hintOverrides[c] = `recommended -- ${manifest.clouds[c].description}`;
  }
  for (const c of withCli) {
    hintOverrides[c] = `CLI installed -- ${manifest.clouds[c].description}`;
  }

  return {
    sortedClouds: [
      ...withCreds,
      ...featured,
      ...withCli,
      ...rest,
    ],
    hintOverrides,
    credCount: withCreds.length,
    cliCount: withCli.length,
  };
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
    const readyCount = implClouds.filter((c) => hasCloudCredentials(manifest.clouds[c].auth)).length;
    const cloudLabel = `${implClouds.length} cloud${implClouds.length !== 1 ? "s" : ""}`;
    if (readyCount > 0) {
      hints[agent] = `${cloudLabel}, ${readyCount} ready`;
    } else {
      hints[agent] = cloudLabel;
    }
  }
  return hints;
}

// Prompt user to select an agent with hints and type-ahead filtering
async function selectAgent(manifest: Manifest): Promise<string> {
  const agents = agentKeys(manifest);
  const agentHints = buildAgentPickerHints(manifest);
  const agentChoice = await p.autocomplete({
    message: "Select an agent (type to filter)",
    options: mapToSelectOptions(agents, manifest.agents, agentHints),
    placeholder: "Start typing to search...",
  });
  if (p.isCancel(agentChoice)) {
    handleCancel();
  }
  return agentChoice;
}

// Validate that agent has available clouds and return sorted cloud list with priority hints
function getAndValidateCloudChoices(
  manifest: Manifest,
  agent: string,
): {
  clouds: string[];
  hintOverrides: Record<string, string>;
  credCount: number;
} {
  const clouds = getImplementedClouds(manifest, agent);

  if (clouds.length === 0) {
    p.log.error(`No clouds available for ${manifest.agents[agent].name}`);
    p.log.info("This agent has no implemented cloud providers yet.");
    p.log.info(`Run ${pc.cyan("spawn matrix")} to see the full availability matrix.`);
    process.exit(1);
  }

  const featuredCloud = manifest.agents[agent]?.featured_cloud;
  const { sortedClouds, hintOverrides, credCount, cliCount } = prioritizeCloudsByCredentials(
    clouds,
    manifest,
    featuredCloud,
  );
  if (credCount > 0) {
    p.log.info(`${credCount} cloud${credCount > 1 ? "s" : ""} with credentials detected (shown first)`);
  }
  if (cliCount > 0) {
    p.log.info(`${cliCount} cloud${cliCount > 1 ? "s" : ""} with CLI installed`);
  }

  return {
    clouds: sortedClouds,
    hintOverrides,
    credCount,
  };
}

// Prompt user to select a cloud from the sorted list with type-ahead filtering
async function selectCloud(
  manifest: Manifest,
  cloudList: string[],
  hintOverrides: Record<string, string>,
): Promise<string> {
  const cloudChoice = await p.autocomplete({
    message: "Select a cloud provider (type to filter)",
    options: mapToSelectOptions(cloudList, manifest.clouds, hintOverrides),
    placeholder: "Start typing to search...",
  });
  if (p.isCancel(cloudChoice)) {
    handleCancel();
  }
  return cloudChoice;
}

// Prompt user to enter a display name for the spawn instance.
// Any string is allowed (spaces, uppercase, etc.) — the shell scripts
// derive a kebab-case slug for the actual cloud resource name.
async function promptSpawnName(): Promise<string | undefined> {
  // If SPAWN_NAME is set (e.g. via --name flag), use it without prompting
  if (process.env.SPAWN_NAME) {
    return process.env.SPAWN_NAME;
  }

  const suffix = Math.random().toString(36).slice(2, 6);
  const defaultName = `spawn-${suffix}`;
  const spawnName = await p.text({
    message: "Name your spawn",
    placeholder: defaultName,
    defaultValue: defaultName,
    validate: (value) => {
      if (!value) {
        return undefined;
      }
      if (value.length > 128) {
        return "Name must be 128 characters or less";
      }
      return undefined;
    },
  });
  if (p.isCancel(spawnName)) {
    handleCancel();
  }
  return spawnName || undefined;
}

export async function cmdInteractive(): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  const manifest = await loadManifestWithSpinner();
  const agentChoice = await selectAgent(manifest);

  const { clouds, hintOverrides } = getAndValidateCloudChoices(manifest, agentChoice);
  const cloudChoice = await selectCloud(manifest, clouds, hintOverrides);

  await preflightCredentialCheck(manifest, cloudChoice);

  const spawnName = await promptSpawnName();

  const agentName = manifest.agents[agentChoice].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${agentChoice} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");

  await execScript(
    cloudChoice,
    agentChoice,
    undefined,
    getAuthHint(manifest, cloudChoice),
    manifest.clouds[cloudChoice].url,
    undefined,
    spawnName,
  );
}

/** Interactive cloud selection when agent is already known (e.g. `spawn claude`) */
export async function cmdAgentInteractive(agent: string, prompt?: string, dryRun?: boolean): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  const manifest = await loadManifestWithSpinner();
  const resolvedAgent = resolveAgentKey(manifest, agent);

  if (!resolvedAgent) {
    const agentMatch = findClosestKeyByNameOrKey(agent, agentKeys(manifest), (k) => manifest.agents[k].name);
    p.log.error(`Unknown agent: ${pc.bold(agent)}`);
    if (agentMatch) {
      p.log.info(`Did you mean ${pc.cyan(agentMatch)} (${manifest.agents[agentMatch].name})?`);
    }
    p.log.info(`Run ${pc.cyan("spawn agents")} to see available agents.`);
    process.exit(1);
  }

  const { clouds, hintOverrides } = getAndValidateCloudChoices(manifest, resolvedAgent);
  const cloudChoice = await selectCloud(manifest, clouds, hintOverrides);

  await preflightCredentialCheck(manifest, cloudChoice);

  const spawnName = await promptSpawnName();

  const agentName = manifest.agents[resolvedAgent].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${resolvedAgent} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");

  await execScript(
    cloudChoice,
    resolvedAgent,
    prompt,
    getAuthHint(manifest, cloudChoice),
    manifest.clouds[cloudChoice].url,
    dryRun,
    spawnName,
  );
}

// ── Run ────────────────────────────────────────────────────────────────────────

/** Resolve display names / casing and log if resolved to a different key */
function resolveAndLog(
  manifest: Manifest,
  agent: string,
  cloud: string,
): {
  agent: string;
  cloud: string;
} {
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
  return {
    agent,
    cloud,
  };
}

/** Detect and fix swapped arguments: "spawn <cloud> <agent>" -> "spawn <agent> <cloud>" */
function detectAndFixSwappedArgs(
  manifest: Manifest,
  agent: string,
  cloud: string,
): {
  agent: string;
  cloud: string;
} {
  if (!manifest.agents[agent] && manifest.clouds[agent] && manifest.agents[cloud]) {
    p.log.info("It looks like you swapped the agent and cloud arguments.");
    p.log.info(`Running: ${pc.cyan(`spawn ${cloud} ${agent}`)}`);
    return {
      agent: cloud,
      cloud: agent,
    };
  }
  return {
    agent,
    cloud,
  };
}

/** Print a labeled section: bold header, body lines, then a blank line */
function printDryRunSection(title: string, lines: string[]): void {
  p.log.step(pc.bold(title));
  for (const line of lines) {
    console.log(line);
  }
  console.log();
}

function buildAgentLines(agentInfo: {
  name: string;
  description: string;
  install?: string;
  launch?: string;
}): string[] {
  const lines = [
    `  Name:        ${agentInfo.name}`,
    `  Description: ${agentInfo.description}`,
  ];
  if (agentInfo.install) {
    lines.push(`  Install:     ${agentInfo.install}`);
  }
  if (agentInfo.launch) {
    lines.push(`  Launch:      ${agentInfo.launch}`);
  }
  return lines;
}

function buildCloudLines(cloudInfo: {
  name: string;
  description: string;
  defaults?: Record<string, string>;
}): string[] {
  const lines = [
    `  Name:        ${cloudInfo.name}`,
    `  Description: ${cloudInfo.description}`,
  ];
  if (cloudInfo.defaults) {
    lines.push("  Defaults:");
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

  const lines = [
    formatCredStatusLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys"),
  ];

  for (let i = 0; i < authVars.length; i++) {
    lines.push(formatCredStatusLine(authVars[i], i === 0 ? cloudUrl : undefined));
  }

  return lines;
}

function buildEnvironmentLines(manifest: Manifest, agent: string): string[] | null {
  const env = manifest.agents[agent].env;
  if (!env) {
    return null;
  }
  return Object.entries(env).map(([k, v]) => {
    const display = v.includes("OPENROUTER_API_KEY") ? "(from OpenRouter)" : v;
    return `  ${k}=${display}`;
  });
}

function buildPromptLines(prompt: string): string[] {
  const preview = prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;
  const lines = [
    `  ${preview}`,
  ];
  if (prompt.length > 100) {
    lines.push(pc.dim(`  (${prompt.length} characters total)`));
  }
  return lines;
}

function showDryRunPreview(manifest: Manifest, agent: string, cloud: string, prompt?: string): void {
  p.log.info(pc.bold("Dry run -- no resources will be provisioned\n"));

  printDryRunSection("Agent", buildAgentLines(manifest.agents[agent]));
  printDryRunSection("Cloud", buildCloudLines(manifest.clouds[cloud]));
  printDryRunSection("Script", [
    `  URL: ${RAW_BASE}/sh/${cloud}/${agent}.sh`,
  ]);

  const envLines = buildEnvironmentLines(manifest, agent);
  if (envLines) {
    printDryRunSection("Environment variables", envLines);
  }

  // Show credential readiness
  const credLines = buildCredentialStatusLines(manifest, cloud);
  printDryRunSection("Credentials", credLines);
  const allSet = credLines.every((l) => l.includes("-- set"));
  if (!allSet) {
    p.log.warn("Some credentials are missing. Set them before launching.");
    p.log.info(`Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions.`);
    console.log();
  }

  if (prompt) {
    printDryRunSection("Prompt", buildPromptLines(prompt));
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
/** Check if credentials are saved in ~/.config/spawn/{cloud}.json */
function hasCloudConfigCredentials(cloud: string): boolean {
  try {
    const configPath = path.join(process.env.HOME || "", ".config/spawn", `${cloud}.json`);
    if (!fs.existsSync(configPath)) {
      return false;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    // Check if config has any non-empty credentials
    return Object.values(config).some((v) => isString(v) && v.trim().length > 0);
  } catch {
    // If config can't be read, assume no saved credentials
    return false;
  }
}

function collectMissingCredentials(authVars: string[], cloud?: string): string[] {
  const missing: string[] = [];
  if (!process.env.OPENROUTER_API_KEY) {
    missing.push("OPENROUTER_API_KEY");
  }
  for (const v of authVars) {
    if (!process.env[v]) {
      missing.push(v);
    }
  }

  // If there are missing credentials but the cloud has saved config, don't report them as missing
  if (missing.length > 0 && cloud && hasCloudConfigCredentials(cloud)) {
    return missing.filter((v) => v === "OPENROUTER_API_KEY");
  }

  return missing;
}

function getCredentialGuidance(cloud: string, onlyOpenRouter: boolean): string {
  if (onlyOpenRouter) {
    return "The script will open your browser to authenticate with OpenRouter.";
  }
  return `Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions.`;
}

async function confirmContinueWithMissingCreds(onlyOpenRouter: boolean): Promise<boolean> {
  const confirmMsg = onlyOpenRouter
    ? "Continue? You'll authenticate via browser."
    : "Continue anyway? The script will prompt for missing credentials.";
  const shouldContinue = await p.confirm({
    message: confirmMsg,
    initialValue: true,
  });
  return !p.isCancel(shouldContinue) && shouldContinue;
}

export async function preflightCredentialCheck(manifest: Manifest, cloud: string): Promise<void> {
  const cloudAuth = manifest.clouds[cloud].auth;
  if (cloudAuth.toLowerCase() === "none") {
    return;
  }

  const authVars = parseAuthEnvVars(cloudAuth);
  const missing = collectMissingCredentials(authVars, cloud);
  if (missing.length === 0) {
    return;
  }

  const cloudName = manifest.clouds[cloud].name;
  p.log.warn(`Missing credentials for ${cloudName}: ${missing.map((v) => pc.cyan(v)).join(", ")}`);

  const onlyOpenRouter = missing.length === 1 && missing[0] === "OPENROUTER_API_KEY";
  p.log.info(getCredentialGuidance(cloud, onlyOpenRouter));

  if (isInteractiveTTY()) {
    const shouldContinue = await confirmContinueWithMissingCreds(onlyOpenRouter);
    if (!shouldContinue) {
      handleCancel();
    }
  }
}

export async function cmdRun(
  agent: string,
  cloud: string,
  prompt?: string,
  dryRun?: boolean,
  debug?: boolean,
): Promise<void> {
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

  const spawnName = await promptSpawnName();

  // If a name was given, check whether an active instance with that name already
  // exists for this agent + cloud combination.  When it does, route the user into
  // the same action picker they get from `spawn ls` instead of blindly creating a
  // second VM.
  if (spawnName) {
    const activeServers = getActiveServers();
    const existingRecord = activeServers.find((r) => r.name === spawnName && r.agent === agent && r.cloud === cloud);
    if (existingRecord) {
      p.log.warn(
        `An active instance named ${pc.bold(spawnName)} already exists on ${pc.bold(manifest.clouds[cloud].name)}.`,
      );
      await handleRecordAction(existingRecord, manifest);
      return;
    }
  }

  const agentName = manifest.agents[agent].name;
  const cloudName = manifest.clouds[cloud].name;
  const suffix = prompt ? " with prompt..." : "...";
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}${suffix}`);

  await execScript(cloud, agent, prompt, getAuthHint(manifest, cloud), manifest.clouds[cloud].url, debug, spawnName);
}

// ── Headless Mode ──────────────────────────────────────────────────────────────

/** Exit codes for headless mode:
 *  0 = success
 *  1 = script execution error (provisioning/setup failed)
 *  2 = script download error (network/404)
 *  3 = validation error (bad inputs, missing credentials) */

export interface HeadlessOptions {
  prompt?: string;
  debug?: boolean;
  outputFormat?: string;
  spawnName?: string;
}

interface SpawnResult {
  status: "success" | "error";
  cloud: string;
  agent: string;
  server_id?: string;
  server_name?: string;
  ip_address?: string;
  ssh_user?: string;
  error_message?: string;
  error_code?: string;
}

function headlessOutput(result: SpawnResult, outputFormat?: string): void {
  if (outputFormat === "json") {
    console.log(JSON.stringify(result));
  } else {
    // Plain text output for headless without --output json
    if (result.status === "success") {
      console.error(`Success: ${result.agent} on ${result.cloud}`);
      if (result.ip_address) {
        console.error(`  IP: ${result.ip_address}`);
      }
      if (result.ssh_user) {
        console.error(`  User: ${result.ssh_user}`);
      }
      if (result.server_id) {
        console.error(`  Server ID: ${result.server_id}`);
      }
    } else {
      console.error(`Error: ${result.error_message}`);
    }
  }
}

function headlessError(
  agent: string,
  cloud: string,
  errorCode: string,
  errorMessage: string,
  outputFormat?: string,
  exitCode = 1,
): never {
  headlessOutput(
    {
      status: "error",
      cloud,
      agent,
      error_code: errorCode,
      error_message: errorMessage,
    },
    outputFormat,
  );
  process.exit(exitCode);
}

/** Run a bash script in headless mode (all output to stderr, no interactive session) */
function runBashHeadless(script: string, prompt?: string, debug?: boolean, spawnName?: string): Promise<number> {
  validateScriptContent(script);

  const env = {
    ...process.env,
  };
  env.SPAWN_HEADLESS = "1";
  env.SPAWN_MODE = "non-interactive";
  if (prompt) {
    env.SPAWN_PROMPT = prompt;
  }
  if (debug) {
    env.SPAWN_DEBUG = "1";
  }
  if (spawnName) {
    env.SPAWN_NAME = spawnName;
    env.SPAWN_NAME_KEBAB = toKebabCase(spawnName);
  }

  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        script,
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "inherit",
        ],
        env,
      },
    );
    // Forward stdout to stderr so JSON output stays clean on stdout
    if (child.stdout) {
      child.stdout.pipe(process.stderr);
    }
    child.on("close", (code: number | null) => {
      resolve(code ?? 1);
    });
    child.on("error", reject);
  });
}

export async function cmdRunHeadless(agent: string, cloud: string, opts: HeadlessOptions = {}): Promise<void> {
  const { prompt, debug, outputFormat, spawnName } = opts;

  // Phase 1: Validate inputs (exit code 3)
  try {
    validateIdentifier(agent, "Agent name");
    validateIdentifier(cloud, "Cloud name");
    if (prompt) {
      validatePrompt(prompt);
    }
  } catch (err) {
    headlessError(agent, cloud, "VALIDATION_ERROR", getErrorMessage(err), outputFormat, 3);
  }

  // Load manifest (silently - no spinner in headless mode)
  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch (err) {
    headlessError(agent, cloud, "MANIFEST_ERROR", getErrorMessage(err), outputFormat, 3);
  }

  // Resolve agent/cloud names
  const resolvedAgent = resolveAgentKey(manifest, agent) ?? agent;
  const resolvedCloud = resolveCloudKey(manifest, cloud) ?? cloud;

  // Validate entities exist
  if (!manifest.agents[resolvedAgent]) {
    headlessError(resolvedAgent, resolvedCloud, "UNKNOWN_AGENT", `Unknown agent: ${resolvedAgent}`, outputFormat, 3);
  }
  if (!manifest.clouds[resolvedCloud]) {
    headlessError(resolvedAgent, resolvedCloud, "UNKNOWN_CLOUD", `Unknown cloud: ${resolvedCloud}`, outputFormat, 3);
  }

  const matrixKey = `${resolvedCloud}/${resolvedAgent}`;
  if (manifest.matrix[matrixKey] !== "implemented") {
    headlessError(
      resolvedAgent,
      resolvedCloud,
      "NOT_IMPLEMENTED",
      `${resolvedAgent} on ${resolvedCloud} is not implemented`,
      outputFormat,
      3,
    );
  }

  // Check credentials upfront
  const cloudAuth = manifest.clouds[resolvedCloud].auth;
  if (cloudAuth.toLowerCase() !== "none") {
    const authVars = parseAuthEnvVars(cloudAuth);
    const missing = collectMissingCredentials(authVars, resolvedCloud);
    if (missing.length > 0) {
      headlessError(
        resolvedAgent,
        resolvedCloud,
        "MISSING_CREDENTIALS",
        `Missing required credentials: ${missing.join(", ")}`,
        outputFormat,
        3,
      );
    }
  }

  // Phase 2: Load script — prefer local source when SPAWN_CLI_DIR is set (exit code 2)
  let scriptContent: string;
  const cliDir = process.env.SPAWN_CLI_DIR;
  let localScriptResolved = "";

  if (cliDir) {
    // Reject cloud/agent names containing path traversal characters
    const hasBadChars = (s: string) => s.includes("..") || s.includes("/") || s.includes("\\");
    const safeCloud = !hasBadChars(resolvedCloud);
    const safeAgent = !hasBadChars(resolvedAgent);

    if (safeCloud && safeAgent) {
      const resolvedCliDir = path.resolve(cliDir);
      const candidatePath = path.join(resolvedCliDir, "sh", resolvedCloud, `${resolvedAgent}.sh`);
      try {
        const canonicalPath = fs.realpathSync(candidatePath);
        // Ensure the resolved path stays inside the CLI dir (no path traversal)
        const prefix = resolvedCliDir.endsWith(path.sep) ? resolvedCliDir : resolvedCliDir + path.sep;
        if (canonicalPath.startsWith(prefix)) {
          localScriptResolved = canonicalPath;
        }
      } catch {
        // File doesn't exist — fall through to remote fetch
      }
    }
  }

  if (localScriptResolved) {
    scriptContent = fs.readFileSync(localScriptResolved, "utf-8");
    if (debug) {
      console.error(`[headless] Using local script: ${localScriptResolved}`);
    }
  } else {
    const url = `https://openrouter.ai/labs/spawn/${resolvedCloud}/${resolvedAgent}.sh`;
    const ghUrl = `${RAW_BASE}/sh/${resolvedCloud}/${resolvedAgent}.sh`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (res.ok) {
        scriptContent = await res.text();
      } else {
        const ghRes = await fetch(ghUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        });
        if (!ghRes.ok) {
          headlessError(
            resolvedAgent,
            resolvedCloud,
            "DOWNLOAD_ERROR",
            `Script not found (HTTP ${res.status} primary, ${ghRes.status} fallback)`,
            outputFormat,
            2,
          );
        }
        scriptContent = await ghRes.text();
      }
    } catch (err) {
      headlessError(
        resolvedAgent,
        resolvedCloud,
        "DOWNLOAD_ERROR",
        `Failed to download script: ${getErrorMessage(err)}`,
        outputFormat,
        2,
      );
    }
  }

  // Phase 3: Execute script (exit code 1)
  if (debug) {
    console.error(`[headless] Executing ${resolvedAgent} on ${resolvedCloud}...`);
  }

  const exitCode = await runBashHeadless(scriptContent, prompt, debug, spawnName);

  if (exitCode !== 0) {
    headlessError(
      resolvedAgent,
      resolvedCloud,
      "EXECUTION_ERROR",
      `Script exited with code ${exitCode}`,
      outputFormat,
      1,
    );
  }

  // Read connection info from last-connection.json
  const { getConnectionPath } = await import("./history.js");
  const connectionInfo: {
    ip?: string;
    user?: string;
    server_id?: string;
    server_name?: string;
  } = {};
  try {
    const connPath = getConnectionPath();
    const { readFileSync, existsSync } = await import("node:fs");
    if (existsSync(connPath)) {
      const raw = JSON.parse(readFileSync(connPath, "utf-8"));

      try {
        // SECURITY: Validate connection fields before including in output
        // Prevents injection via tampered last-connection.json files
        if (raw.ip) {
          validateConnectionIP(raw.ip);
          connectionInfo.ip = raw.ip;
        }
        if (raw.user) {
          validateUsername(raw.user);
          connectionInfo.user = raw.user;
        }
        if (raw.server_id) {
          validateServerIdentifier(raw.server_id);
          connectionInfo.server_id = raw.server_id;
        }
        if (raw.server_name) {
          validateServerIdentifier(raw.server_name);
          connectionInfo.server_name = raw.server_name;
        }
      } catch (validationErr) {
        // Validation failure is a security issue - report via headless error
        headlessError(
          resolvedAgent,
          resolvedCloud,
          "VALIDATION_ERROR",
          `Connection info validation failed: ${getErrorMessage(validationErr)}`,
          outputFormat,
          1,
        );
      }
    }
  } catch {
    // File read/parse errors - not fatal, just omit connection info
  }

  const result: SpawnResult = {
    status: "success",
    cloud: resolvedCloud,
    agent: resolvedAgent,
    ...(connectionInfo.ip
      ? {
          ip_address: connectionInfo.ip,
        }
      : {}),
    ...(connectionInfo.user
      ? {
          ssh_user: connectionInfo.user,
        }
      : {}),
    ...(connectionInfo.server_id
      ? {
          server_id: connectionInfo.server_id,
        }
      : {}),
    ...(connectionInfo.server_name
      ? {
          server_name: connectionInfo.server_name,
        }
      : {}),
  };

  headlessOutput(result, outputFormat);
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

// Report 404 errors (script not found)
function report404Failure(): void {
  p.log.error("Script not found (HTTP 404)");
  console.error("\nThe spawn script doesn't exist at the expected location.");
  console.error("\nThis usually means:");
  console.error("  • The agent + cloud combination hasn't been implemented yet");
  console.error("  • The script is currently being deployed (rare)");
  console.error("  • There's a temporary issue with the file server");
  console.error(`\n${pc.bold("Next steps:")}`);
  console.error(`  1. Verify it's implemented: ${pc.cyan("spawn matrix")}`);
  console.error("  2. If the matrix shows ✓, wait 1-2 minutes and retry");
  console.error(`  3. Still broken? Report it: ${pc.cyan(`https://github.com/${REPO}/issues`)}`);
}

// Report HTTP errors (non-404)
function reportHTTPFailure(primaryStatus: number, fallbackStatus: number): void {
  const hasServerError = primaryStatus >= 500 || fallbackStatus >= 500;
  p.log.error("Script download failed");
  console.error(
    `\nCouldn't download the spawn script (HTTP ${primaryStatus} from primary, ${fallbackStatus} from fallback).`,
  );
  if (hasServerError) {
    console.error("\nThe servers are experiencing issues or temporarily unavailable.");
  }
  console.error(`\n${pc.bold("Next steps:")}`);
  console.error("  1. Check your internet connection");
  console.error("  2. Wait a moment and try again");
  console.error(`  3. Check GitHub's status: ${pc.cyan("https://www.githubstatus.com")}`);
  if (hasServerError) {
    console.error(`  4. If GitHub is down, retry when it's back up`);
  }
}

function reportDownloadFailure(
  _primaryUrl: string,
  _fallbackUrl: string,
  primaryStatus: number,
  fallbackStatus: number,
): void {
  if (primaryStatus === 404 && fallbackStatus === 404) {
    report404Failure();
  } else {
    reportHTTPFailure(primaryStatus, fallbackStatus);
  }
}

// Detect error type from error message
function classifyNetworkError(errMsg: string): "timeout" | "connection" | "unknown" {
  if (errMsg.toLowerCase().includes("timeout")) {
    return "timeout";
  }
  if (errMsg.toLowerCase().includes("connect") || errMsg.toLowerCase().includes("enotfound")) {
    return "connection";
  }
  return "unknown";
}

interface ErrorGuidance {
  causes: string[];
  steps: (ghUrl: string) => string[];
}

const NETWORK_ERROR_GUIDANCE: Record<"timeout" | "connection" | "unknown", ErrorGuidance> = {
  timeout: {
    causes: [
      "  • Slow or unstable internet connection",
      "  • Download server not responding (possibly overloaded)",
      "  • Firewall blocking or slowing the connection",
    ],
    steps: (ghUrl) => [
      "  2. Verify combination exists: " + pc.cyan("spawn matrix"),
      "  3. Wait a moment and retry",
      "  4. Test URL directly: " + pc.dim(ghUrl),
    ],
  },
  connection: {
    causes: [
      "  • No internet connection",
      "  • Firewall or proxy blocking GitHub access",
      "  • DNS not resolving GitHub's domain",
    ],
    steps: () => [
      "  2. Test github.com access in your browser",
      "  3. Check firewall/VPN settings",
      "  4. Try disabling proxy temporarily",
    ],
  },
  unknown: {
    causes: [
      "  • Internet connection issue",
      "  • GitHub's servers temporarily down",
    ],
    steps: (ghUrl) => [
      "  2. Verify combination exists: " + pc.cyan("spawn matrix"),
      "  3. Wait a moment and retry",
      "  4. Test URL directly: " + pc.dim(ghUrl),
    ],
  },
};

function reportDownloadError(ghUrl: string, err: unknown): never {
  p.log.error("Script download failed");
  const errMsg = getErrorMessage(err);
  console.error("\nNetwork error:", errMsg);

  const errorType = classifyNetworkError(errMsg);
  const guidance = NETWORK_ERROR_GUIDANCE[errorType];

  console.error(`\n${pc.bold("Possible causes:")}`);
  for (const cause of guidance.causes) {
    console.error(cause);
  }

  console.error(`\n${pc.bold("Next steps:")}`);
  console.error("  1. Check your internet connection");
  for (const step of guidance.steps(ghUrl)) {
    console.error(step);
  }
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
  const authVars = authHint
    .split(/\s*\+\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const allVars = [
    ...authVars,
    "OPENROUTER_API_KEY",
  ];

  const missing = allVars.filter((v) => !process.env[v]);

  if (missing.length === 0) {
    // All credentials are set -- the issue is likely something else
    return [
      `  - Credentials appear to be set (${allVars.map((v) => pc.cyan(v)).join(", ")})`,
      "    The error may be due to invalid or expired credentials",
      `    Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions`,
    ];
  }

  // Show which specific vars are missing
  const lines: string[] = [];
  lines.push("  - Missing credentials:");
  for (const v of missing) {
    lines.push(`      ${pc.cyan(v)} -- not set`);
  }
  lines.push(`    Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions`);

  return lines;
}

export function getSignalGuidance(signal: string, dashboardUrl?: string): string[] {
  const entry = SIGNAL_GUIDANCE[signal];
  if (entry) {
    const lines = [
      entry.header,
      ...entry.causes,
    ];
    if (entry.includeDashboard) {
      lines.push(buildDashboardHint(dashboardUrl));
    }
    return lines;
  }
  return [
    `Script was killed by signal ${signal}.`,
    "  - The process was terminated by the system or another process",
    buildDashboardHint(dashboardUrl),
  ];
}

function optionalDashboardLine(dashboardUrl?: string): string[] {
  return dashboardUrl
    ? [
        `  - Check your dashboard: ${pc.cyan(dashboardUrl)}`,
      ]
    : [];
}

export function getScriptFailureGuidance(
  exitCode: number | null,
  cloud: string,
  authHint?: string,
  dashboardUrl?: string,
): string[] {
  const entry = exitCode !== null ? EXIT_CODE_GUIDANCE[exitCode] : null;

  if (!entry) {
    // Default/unknown exit code
    return [
      `${pc.bold("Common causes:")}`,
      ...credentialHints(cloud, authHint, "Missing"),
      "  - Cloud provider API rate limit or quota exceeded",
      "  - Missing local dependencies (SSH, curl, jq)",
      ...optionalDashboardLine(dashboardUrl),
    ];
  }

  const lines = [
    pc.bold(entry.header),
    ...entry.lines,
  ];

  // Apply special handling if defined for this exit code
  if (entry.specialHandling) {
    // Exit code 1 special case: needs credentialHints
    if (exitCode === 1) {
      lines.push(
        ...credentialHints(cloud, authHint),
        "  - Cloud provider API error (quota, rate limit, or region issue)",
        "  - Server provisioning failed (try again or pick a different region)",
      );
    } else {
      lines.push(...entry.specialHandling(cloud, authHint, dashboardUrl));
    }
  }

  if (entry.includeDashboard) {
    lines.push(buildDashboardHint(dashboardUrl));
  }

  return lines;
}

export function buildRetryCommand(agent: string, cloud: string, prompt?: string, spawnName?: string): string {
  const safeName = spawnName ? spawnName.replace(/"/g, '\\"') : "";
  const nameFlag = spawnName ? ` --name "${safeName}"` : "";
  if (!prompt) {
    return `spawn ${agent} ${cloud}${nameFlag}`;
  }
  if (prompt.length <= 80) {
    const safe = prompt.replace(/"/g, '\\"');
    return `spawn ${agent} ${cloud}${nameFlag} --prompt "${safe}"`;
  }
  // Long prompts: suggest --prompt-file instead of truncating into a broken command
  return `spawn ${agent} ${cloud}${nameFlag} --prompt-file <your-prompt-file>`;
}

function reportScriptFailure(
  errMsg: string,
  cloud: string,
  agent: string,
  authHint?: string,
  prompt?: string,
  dashboardUrl?: string,
  spawnName?: string,
): never {
  p.log.error("Spawn script failed");
  console.error("\nError:", errMsg);

  const exitCodeMatch = errMsg.match(/exited with code (\d+)/);
  const exitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1], 10) : null;

  // Check for signal-killed messages (e.g. "killed by SIGKILL")
  const signalMatch = errMsg.match(/killed by (SIG\w+)/);
  const signal = signalMatch ? signalMatch[1] : null;

  const lines = signal
    ? getSignalGuidance(signal, dashboardUrl)
    : getScriptFailureGuidance(exitCode, cloud, authHint, dashboardUrl);
  console.error("");
  for (const line of lines) {
    console.error(line);
  }
  console.error("");
  console.error(`Retry: ${pc.cyan(buildRetryCommand(agent, cloud, prompt, spawnName))}`);
  process.exit(1);
}

/** Check if an error message indicates an SSH connection failure (exit code 255). */
export function isRetryableExitCode(errMsg: string): boolean {
  const exitCodeMatch = errMsg.match(/exited with code (\d+)/);
  if (!exitCodeMatch) {
    return false;
  }
  const code = Number.parseInt(exitCodeMatch[1], 10);
  // Exit 255 = SSH connection failure (the standard SSH error exit code)
  return code === 255;
}

function handleUserInterrupt(errMsg: string, dashboardUrl?: string): void {
  if (!errMsg.includes("interrupted by user") && !errMsg.includes("killed by SIGINT")) {
    return;
  }
  console.error();
  p.log.warn("Script interrupted (Ctrl+C).");
  p.log.warn("If a server was already created, it may still be running.");
  if (dashboardUrl) {
    p.log.warn(`  Check your dashboard: ${pc.cyan(dashboardUrl)}`);
  } else {
    p.log.warn("  Check your cloud provider dashboard to stop or delete any unused servers.");
  }
  process.exit(130);
}

/**
 * Run a bash script once. Does NOT retry — the script includes server creation
 * and an interactive session, so retrying would create duplicate servers.
 * On SSH disconnect (exit 255), shows a reconnect hint instead.
 */
function runBashScript(
  script: string,
  prompt?: string,
  dashboardUrl?: string,
  debug?: boolean,
  spawnName?: string,
): string | undefined {
  try {
    runBash(script, prompt, debug, spawnName);
    return undefined; // success
  } catch (err) {
    const errMsg = getErrorMessage(err);
    handleUserInterrupt(errMsg, dashboardUrl);

    // SSH disconnect after the server was already created — don't retry
    if (isRetryableExitCode(errMsg)) {
      console.error();
      p.log.warn("SSH connection lost. Your server is likely still running.");
      p.log.warn("To reconnect, re-run the same spawn command.");
    }

    return errMsg;
  }
}

async function execScript(
  cloud: string,
  agent: string,
  prompt?: string,
  authHint?: string,
  dashboardUrl?: string,
  debug?: boolean,
  spawnName?: string,
): Promise<void> {
  const url = `https://openrouter.ai/labs/spawn/${cloud}/${agent}.sh`;
  const ghUrl = `${RAW_BASE}/sh/${cloud}/${agent}.sh`;

  let scriptContent: string;
  try {
    scriptContent = await downloadScriptWithFallback(url, ghUrl);
  } catch (err) {
    reportDownloadError(ghUrl, err);
    return; // Exit early - cannot proceed without script content
  }

  // Record the spawn before execution (so it's logged even if the script fails midway)
  try {
    saveSpawnRecord({
      agent,
      cloud,
      timestamp: new Date().toISOString(),
      ...(spawnName
        ? {
            name: spawnName,
          }
        : {}),
      ...(prompt
        ? {
            prompt,
          }
        : {}),
    });
  } catch (err) {
    // Non-fatal: don't block the spawn if history write fails
    // Log for debugging but continue execution
    if (debug) {
      console.error(pc.dim(`Warning: Failed to save spawn record: ${getErrorMessage(err)}`));
    }
  }

  const lastErr = runBashScript(scriptContent, prompt, dashboardUrl, debug, spawnName);
  if (lastErr) {
    reportScriptFailure(lastErr, cloud, agent, authHint, prompt, dashboardUrl, spawnName);
  }
}

function spawnBash(script: string, env: Record<string, string | undefined>): void {
  const result = spawnSync(
    "bash",
    [
      "-c",
      script,
    ],
    {
      stdio: "inherit",
      env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  const code = result.status;
  const signal = result.signal;

  if (code === 0) {
    return;
  }
  if (code !== null) {
    const msg = code === 130 ? "Script interrupted by user (Ctrl+C)" : `Script exited with code ${code}`;
    throw new Error(msg);
  }
  // code is null when killed by a signal (SIGKILL, SIGTERM, etc.)
  const sig = signal ?? "unknown signal";
  throw new Error(`Script was killed by ${sig}`);
}

function runBash(script: string, prompt?: string, debug?: boolean, spawnName?: string): void {
  // SECURITY: Validate script content before execution
  validateScriptContent(script);

  // Set environment variables for non-interactive mode
  const env = {
    ...process.env,
  };
  if (prompt) {
    env.SPAWN_PROMPT = prompt;
    env.SPAWN_MODE = "non-interactive";
  }
  if (debug) {
    env.SPAWN_DEBUG = "1";
  }
  if (spawnName) {
    env.SPAWN_NAME = spawnName;
    env.SPAWN_NAME_KEBAB = toKebabCase(spawnName);
  }
  if (process.env.SPAWN_CUSTOM === "1") {
    env.SPAWN_CUSTOM = "1";
  }

  // Clean up stdin state left by @clack/prompts so the child process
  // gets a pristine file descriptor (prevents silent hangs / early exit)
  prepareStdinForHandoff();

  spawnBash(script, env);
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

// ── List (History) ──────────────────────────────────────────────────────────────

/** Format an ISO timestamp as a human-readable relative time (e.g., "5 min ago", "2 days ago") */
export function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) {
      return "just now";
    }
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) {
      return "just now";
    }
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) {
      return `${diffMin} min ago`;
    }
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) {
      return `${diffHr}h ago`;
    }
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays === 1) {
      return "yesterday";
    }
    if (diffDays < 30) {
      return `${diffDays}d ago`;
    }
    // Fall back to absolute date for old entries
    const date = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return date;
  } catch (_err) {
    // Invalid date format - return as-is
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
  if (agentFilter) {
    parts.push(`agent=${pc.bold(agentFilter)}`);
  }
  if (cloudFilter) {
    parts.push(`cloud=${pc.bold(cloudFilter)}`);
  }
  p.log.info(`No spawns found matching ${parts.join(", ")}.`);

  try {
    const manifest = await loadManifest();
    if (agentFilter) {
      await suggestFilterCorrection(
        agentFilter,
        "-a",
        agentKeys(manifest),
        resolveAgentKey,
        (k) => manifest.agents[k].name,
        manifest,
      );
    }
    if (cloudFilter) {
      await suggestFilterCorrection(
        cloudFilter,
        "-c",
        cloudKeys(manifest),
        resolveCloudKey,
        (k) => manifest.clouds[k].name,
        manifest,
      );
    }
  } catch (_err) {
    // Manifest unavailable -- skip suggestions
  }

  const totalRecords = filterHistory();
  if (totalRecords.length > 0) {
    p.log.info(
      `Run ${pc.cyan("spawn list")} to see all ${totalRecords.length} recorded spawn${totalRecords.length !== 1 ? "s" : ""}.`,
    );
  }
}

function buildListFooterLines(records: SpawnRecord[], agentFilter?: string, cloudFilter?: string): string[] {
  const lines: string[] = [];
  const latest = records[0];
  lines.push(`Rerun last: ${pc.cyan(buildRetryCommand(latest.agent, latest.cloud, latest.prompt, latest.name))}`);

  if (agentFilter || cloudFilter) {
    const totalRecords = filterHistory();
    lines.push(
      pc.dim(`Showing ${records.length} of ${totalRecords.length} spawn${totalRecords.length !== 1 ? "s" : ""}`),
    );
    lines.push(pc.dim(`Clear filter: ${pc.cyan("spawn list")}`));
  } else {
    lines.push(pc.dim(`${records.length} spawn${records.length !== 1 ? "s" : ""} recorded`));
    lines.push(
      pc.dim(
        `Filter: ${pc.cyan("spawn list -a <agent>")}  or  ${pc.cyan("spawn list -c <cloud>")}  |  Clear: ${pc.cyan("spawn list --clear")}`,
      ),
    );
  }
  return lines;
}

function showListFooter(records: SpawnRecord[], agentFilter?: string, cloudFilter?: string): void {
  for (const line of buildListFooterLines(records, agentFilter, cloudFilter)) {
    console.log(line);
  }
  console.log();
}

/** Resolve an agent/cloud key to its display name, or return the key as-is */
export function resolveDisplayName(manifest: Manifest | null, key: string, kind: "agent" | "cloud"): string {
  if (!manifest) {
    return key;
  }
  const entry = kind === "agent" ? manifest.agents[key] : manifest.clouds[key];
  return entry ? entry.name : key;
}

function renderListTable(records: SpawnRecord[], manifest: Manifest | null): void {
  console.log();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const name = r.name || r.connection?.server_name || "unnamed";
    console.log(pc.bold(name));
    console.log(`  ${buildRecordSubtitle(r, manifest)}`);
    if (i < records.length - 1) {
      console.log();
    }
  }
  console.log();
}

export function isInteractiveTTY(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/** Build a display label (line 1: name) for a spawn record in the interactive picker */
export function buildRecordLabel(r: SpawnRecord, _manifest: Manifest | null): string {
  return r.name || r.connection?.server_name || "unnamed";
}

/** Build a subtitle (line 2: agent · cloud · time) for the interactive picker */
export function buildRecordSubtitle(r: SpawnRecord, manifest: Manifest | null): string {
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  const relative = formatRelativeTime(r.timestamp);
  const parts = [
    agentDisplay,
    cloudDisplay,
    relative,
  ];
  if (r.connection?.deleted) {
    parts.push("[deleted]");
  }
  return parts.join(" · ");
}

/** Try to load manifest and resolve filter display names to keys.
 *  When a bare positional filter doesn't match an agent, try it as a cloud. */
async function resolveListFilters(
  agentFilter?: string,
  cloudFilter?: string,
): Promise<{
  manifest: Manifest | null;
  agentFilter?: string;
  cloudFilter?: string;
}> {
  let manifest: Manifest | null = null;
  try {
    manifest = await loadManifest();
  } catch (_err) {
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
    if (resolved) {
      cloudFilter = resolved;
    }
  }

  return {
    manifest,
    agentFilter,
    cloudFilter,
  };
}

// ── Delete ──────────────────────────────────────────────────────────────────────

/** Execute server deletion for a given record using TypeScript cloud modules */
async function execDeleteServer(record: SpawnRecord): Promise<boolean> {
  const conn = record.connection;
  if (!conn?.cloud || conn.cloud === "local") {
    return false;
  }

  const id = conn.server_id || conn.server_name || "";

  // SECURITY: Validate server ID to prevent command injection
  // This protects against corrupted or tampered history files
  try {
    validateServerIdentifier(id);
  } catch (err) {
    throw new Error(
      `Invalid server identifier in history: ${getErrorMessage(err)}\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `Location: ${getHistoryPath()}\n` +
        `To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'`,
    );
  }

  const isAlreadyGone = (msg: string) =>
    msg.includes("404") || msg.includes("not found") || msg.includes("Not Found") || msg.includes("Could not find");

  const tryDelete = async (deleteFn: () => Promise<void>): Promise<boolean> => {
    try {
      await deleteFn();
      markRecordDeleted(record);
      return true;
    } catch (err) {
      const errMsg = getErrorMessage(err);
      if (isAlreadyGone(errMsg)) {
        p.log.warn("Server already deleted or not found. Marking as deleted.");
        markRecordDeleted(record);
        return true;
      }
      p.log.error(`Delete failed: ${errMsg}`);
      p.log.info("The server may still be running. Check your cloud provider dashboard.");
      return false;
    }
  };

  switch (conn.cloud) {
    case "hetzner":
      return tryDelete(async () => {
        await ensureHcloudToken();
        await hetznerDestroyServer(id);
      });

    case "digitalocean":
      return tryDelete(async () => {
        await ensureDoToken();
        await doDestroyServer(id);
      });

    case "gcp": {
      const zone = conn.metadata?.zone || "us-central1-a";
      const project = conn.metadata?.project || "";
      // SECURITY: Validate metadata values to prevent injection via tampered history
      validateMetadataValue(zone, "GCP zone");
      if (project) {
        validateMetadataValue(project, "GCP project");
      }
      return tryDelete(async () => {
        process.env.GCP_ZONE = zone;
        if (project) {
          process.env.GCP_PROJECT = project;
        }
        await gcpEnsureGcloudCli();
        await gcpAuthenticate();
        // Deletion runs under a spinner — suppress interactive prompts
        const prevNonInteractive = process.env.SPAWN_NON_INTERACTIVE;
        process.env.SPAWN_NON_INTERACTIVE = "1";
        try {
          await gcpResolveProject();
        } finally {
          if (prevNonInteractive === undefined) {
            delete process.env.SPAWN_NON_INTERACTIVE;
          } else {
            process.env.SPAWN_NON_INTERACTIVE = prevNonInteractive;
          }
        }
        await gcpDestroyInstance(id);
      });
    }

    case "aws":
      return tryDelete(async () => {
        await ensureAwsCli();
        await awsAuthenticate();
        await awsDestroyServer(id);
      });

    case "daytona":
      return tryDelete(async () => {
        await ensureDaytonaToken();
        await daytonaDestroyServer(id);
      });

    case "sprite":
      return tryDelete(async () => {
        await ensureSpriteCli();
        await ensureSpriteAuthenticated();
        await spriteDestroyServer(id);
      });

    default:
      p.log.error(`No delete handler for cloud: ${conn.cloud}`);
      return false;
  }
}

/** Prompt for delete confirmation and execute. Returns true if deleted. */
async function confirmAndDelete(record: SpawnRecord, manifest: Manifest | null): Promise<boolean> {
  const conn = record.connection!;
  const label = conn.server_name || conn.server_id || conn.ip;
  const cloudLabel = manifest?.clouds[conn.cloud!]?.name || conn.cloud;

  const confirmed = await p.confirm({
    message: `Delete server "${label}" on ${cloudLabel}? This will permanently destroy the server and all data on it.`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info("Delete cancelled.");
    return false;
  }

  const s = p.spinner();
  s.start(`Deleting ${label}...`);

  const success = await execDeleteServer(record);

  if (success) {
    s.stop(`Server "${label}" deleted.`);
  } else {
    s.stop("Delete failed.");
  }
  return success;
}

/** Handle reconnect or rerun action for a selected spawn record */
async function handleRecordAction(selected: SpawnRecord, manifest: Manifest | null): Promise<void> {
  if (!selected.connection) {
    // No connection info -- just rerun, reusing the existing spawn name
    if (selected.name) {
      process.env.SPAWN_NAME = selected.name;
    }
    p.log.step(`Spawning ${pc.bold(buildRecordLabel(selected, manifest))}`);
    await cmdRun(selected.agent, selected.cloud, selected.prompt);
    return;
  }

  const conn = selected.connection;
  const canDelete = conn.cloud && conn.cloud !== "local" && !conn.deleted && (conn.server_id || conn.server_name);

  const options: {
    value: string;
    label: string;
    hint?: string;
  }[] = [];

  // Prefer stored launch command (captured at spawn time), fall back to manifest
  const agentDef = manifest?.agents?.[selected.agent];
  const launchCmd = conn.launch_cmd || agentDef?.launch;

  if (!conn.deleted && launchCmd) {
    const agentName = agentDef?.name || selected.agent;
    options.push({
      value: "enter",
      label: `Enter ${agentName}`,
      hint: agentDef?.launch || launchCmd,
    });
  }

  if (!conn.deleted) {
    options.push({
      value: "reconnect",
      label: "SSH into VM",
      hint:
        conn.ip === "sprite-console"
          ? `sprite console -s ${conn.server_name}`
          : conn.ip === "daytona-sandbox"
            ? `daytona ssh ${conn.server_id}`
            : `ssh ${conn.user}@${conn.ip}`,
    });
  }

  options.push({
    value: "rerun",
    label: "Spawn a new VM",
    hint: "Create a fresh instance",
  });

  if (canDelete) {
    options.push({
      value: "delete",
      label: "Delete this server",
      hint: `destroy ${conn.server_name || conn.server_id}`,
    });
  }

  const action = await p.select({
    message: "What would you like to do?",
    options,
  });

  if (p.isCancel(action)) {
    handleCancel();
  }

  if (action === "enter") {
    try {
      await cmdEnterAgent(selected.connection, selected.agent, manifest);
    } catch (err) {
      p.log.error(`Connection failed: ${getErrorMessage(err)}`);
      p.log.info(
        `VM may no longer be running. Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`,
      );
    }
    return;
  }

  if (action === "reconnect") {
    try {
      await cmdConnect(selected.connection);
    } catch (err) {
      p.log.error(`Connection failed: ${getErrorMessage(err)}`);
      p.log.info(
        `VM may no longer be running. Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`,
      );
    }
    return;
  }

  if (action === "delete") {
    await confirmAndDelete(selected, manifest);
    return;
  }

  // Rerun (create new spawn).  Clear any pre-set name so the user is prompted for
  // a fresh one — this prevents cmdRun's duplicate-detection from immediately
  // routing them back here in an infinite loop.
  delete process.env.SPAWN_NAME;
  p.log.step(
    `Spawning ${pc.bold(buildRecordLabel(selected, manifest))} ${pc.dim(`(${buildRecordSubtitle(selected, manifest)})`)}`,
  );
  await cmdRun(selected.agent, selected.cloud, selected.prompt);
}

/** Interactive picker with inline delete support.
 *  Pressing 'd' triggers delete; Enter triggers handleRecordAction. */
async function activeServerPicker(records: SpawnRecord[], manifest: Manifest | null): Promise<void> {
  const { pickToTTYWithActions } = await import("./picker.js");

  const remaining = [
    ...records,
  ];

  while (remaining.length > 0) {
    const options = remaining.map((r) => ({
      value: r.timestamp,
      label: buildRecordLabel(r, manifest),
      subtitle: buildRecordSubtitle(r, manifest),
    }));

    const result = pickToTTYWithActions({
      message: `Select a spawn (${remaining.length} server${remaining.length !== 1 ? "s" : ""})`,
      options,
      deleteKey: true,
    });

    if (result.action === "cancel") {
      return;
    }

    const picked = remaining[result.index];

    if (result.action === "delete") {
      const conn = picked.connection;
      const canDestroy = conn?.cloud && conn.cloud !== "local" && !conn.deleted && (conn.server_id || conn.server_name);

      const deleteOptions: {
        value: string;
        label: string;
        hint?: string;
      }[] = [];
      if (canDestroy) {
        deleteOptions.push({
          value: "destroy",
          label: "Destroy server",
          hint: "permanently delete the cloud VM",
        });
      }
      deleteOptions.push({
        value: "remove",
        label: "Remove from history",
        hint: "remove this entry without touching the server",
      });
      deleteOptions.push({
        value: "cancel",
        label: "Cancel",
      });

      const deleteAction = await p.select({
        message: "How do you want to delete this?",
        options: deleteOptions,
      });

      if (p.isCancel(deleteAction) || deleteAction === "cancel") {
        continue;
      }

      if (deleteAction === "destroy") {
        const deleted = await confirmAndDelete(picked, manifest);
        if (deleted) {
          remaining.splice(result.index, 1);
        }
      } else if (deleteAction === "remove") {
        const removed = removeRecord(picked);
        if (removed) {
          p.log.success("Removed from history.");
          remaining.splice(result.index, 1);
        } else {
          p.log.warn("Could not find record in history.");
        }
      }
      continue;
    }

    // action === "select"
    await handleRecordAction(picked, manifest);
    return;
  }

  p.log.info("No servers remaining.");
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

  if (isInteractiveTTY()) {
    // Interactive mode: show active servers with inline delete
    const servers = getActiveServers();
    let filtered = servers;
    if (agentFilter) {
      const lower = agentFilter.toLowerCase();
      filtered = filtered.filter((r) => r.agent.toLowerCase() === lower);
    }
    if (cloudFilter) {
      const lower = cloudFilter.toLowerCase();
      filtered = filtered.filter((r) => r.cloud.toLowerCase() === lower);
    }

    if (filtered.length === 0) {
      const historyRecords = filterHistory(agentFilter, cloudFilter);
      if (historyRecords.length > 0) {
        p.log.info("No active servers found.");
        p.log.info(
          pc.dim(
            `${historyRecords.length} spawn${historyRecords.length !== 1 ? "s" : ""} in history but without active connections.`,
          ),
        );
        p.log.info(
          `Re-launch with ${pc.cyan("spawn <agent> <cloud>")} or view full history with ${pc.cyan("spawn list | cat")}`,
        );
      } else {
        await showEmptyListMessage(agentFilter, cloudFilter);
      }
      return;
    }

    await activeServerPicker(filtered, manifest);
    return;
  }

  // Non-interactive: show full history table
  const records = filterHistory(agentFilter, cloudFilter);
  if (records.length === 0) {
    await showEmptyListMessage(agentFilter, cloudFilter);
    return;
  }

  renderListTable(records, manifest);
  showListFooter(records, agentFilter, cloudFilter);
}

export async function cmdDelete(agentFilter?: string, cloudFilter?: string): Promise<void> {
  const resolved = await resolveListFilters(agentFilter, cloudFilter);
  agentFilter = resolved.agentFilter;
  cloudFilter = resolved.cloudFilter;

  const servers = getActiveServers();

  let filtered = servers;
  if (agentFilter) {
    const lower = agentFilter.toLowerCase();
    filtered = filtered.filter((r) => r.agent.toLowerCase() === lower);
  }
  if (cloudFilter) {
    const lower = cloudFilter.toLowerCase();
    filtered = filtered.filter((r) => r.cloud.toLowerCase() === lower);
  }

  if (filtered.length === 0) {
    p.log.info("No active servers to delete.");
    if (servers.length > 0) {
      p.log.info(
        pc.dim(
          `${servers.length} active server${servers.length !== 1 ? "s" : ""} found, but none matched your filters.`,
        ),
      );
    }
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create a spawn first.`);
    return;
  }

  let manifest: Manifest | null = null;
  try {
    manifest = await loadManifest();
  } catch {
    // Manifest unavailable
  }

  if (!isInteractiveTTY()) {
    p.log.error("spawn delete requires an interactive terminal.");
    p.log.info(`Use ${pc.cyan("spawn list")} to see your servers.`);
    process.exit(1);
  }

  await activeServerPicker(filtered, manifest);
}

export async function cmdLast(): Promise<void> {
  const records = filterHistory();

  if (records.length === 0) {
    p.log.info("No spawn history found.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create your first spawn.`);
    return;
  }

  const latest = records[0];
  let manifest: Manifest | null = null;
  try {
    manifest = await loadManifest();
  } catch (_err) {
    // Manifest unavailable -- show raw keys
  }

  const label = buildRecordLabel(latest, manifest);
  const subtitle = buildRecordSubtitle(latest, manifest);
  p.log.step(`Rerunning last spawn: ${pc.bold(label)} ${pc.dim(`(${subtitle})`)}`);

  if (latest.name) {
    process.env.SPAWN_NAME = latest.name;
  }
  await cmdRun(latest.agent, latest.cloud, latest.prompt);
}

// ── Connect ────────────────────────────────────────────────────────────────────

/** Execute a shell command and resolve/reject on process close/error */
async function runInteractiveCommand(
  cmd: string,
  args: string[],
  failureMsg: string,
  manualCmd: string,
): Promise<void> {
  let code: number;
  try {
    code = spawnInteractive([
      cmd,
      ...args,
    ]);
  } catch (err) {
    p.log.error(`Failed to connect: ${getErrorMessage(err)}`);
    p.log.info(`Try manually: ${pc.cyan(manualCmd)}`);
    throw err;
  }
  if (code !== 0) {
    throw new Error(`${failureMsg} with exit code ${code}`);
  }
}

/** Connect to an existing VM via SSH */
async function cmdConnect(connection: VMConnection): Promise<void> {
  // SECURITY: Validate all connection parameters before use
  // This prevents command injection if the history file is corrupted or tampered with
  try {
    validateConnectionIP(connection.ip);
    validateUsername(connection.user);
    if (connection.server_name) {
      validateServerIdentifier(connection.server_name);
    }
    if (connection.server_id) {
      validateServerIdentifier(connection.server_id);
    }
  } catch (err) {
    p.log.error(`Security validation failed: ${getErrorMessage(err)}`);
    p.log.info("Your spawn history file may be corrupted or tampered with.");
    p.log.info(`Location: ${getHistoryPath()}`);
    p.log.info(`To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'`);
    process.exit(1);
  }

  // Handle Sprite console connections
  if (connection.ip === "sprite-console" && connection.server_name) {
    p.log.step(`Connecting to sprite ${pc.bold(connection.server_name)}...`);
    return runInteractiveCommand(
      "sprite",
      [
        "console",
        "-s",
        connection.server_name,
      ],
      "Sprite console connection failed",
      `sprite console -s ${connection.server_name}`,
    );
  }

  // Handle Daytona sandbox connections
  if (connection.ip === "daytona-sandbox" && connection.server_id) {
    p.log.step(`Connecting to Daytona sandbox ${pc.bold(connection.server_id)}...`);
    return runInteractiveCommand(
      "daytona",
      [
        "ssh",
        connection.server_id,
      ],
      "Daytona sandbox connection failed",
      `daytona ssh ${connection.server_id}`,
    );
  }

  // Handle SSH connections
  p.log.step(`Connecting to ${pc.bold(connection.ip)}...`);
  const sshCmd = `ssh ${connection.user}@${connection.ip}`;

  return runInteractiveCommand(
    "ssh",
    [
      ...SSH_INTERACTIVE_OPTS,
      `${connection.user}@${connection.ip}`,
    ],
    "SSH connection failed",
    sshCmd,
  );
}

/** SSH into a VM and launch the agent directly */
async function cmdEnterAgent(connection: VMConnection, agentKey: string, manifest: Manifest | null): Promise<void> {
  // SECURITY: Validate all connection parameters before use
  try {
    validateConnectionIP(connection.ip);
    validateUsername(connection.user);
    if (connection.server_name) {
      validateServerIdentifier(connection.server_name);
    }
    if (connection.server_id) {
      validateServerIdentifier(connection.server_id);
    }
    if (connection.launch_cmd) {
      validateLaunchCmd(connection.launch_cmd);
    }
  } catch (err) {
    p.log.error(`Security validation failed: ${getErrorMessage(err)}`);
    p.log.info("Your spawn history file may be corrupted or tampered with.");
    p.log.info(`Location: ${getHistoryPath()}`);
    p.log.info(`To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'`);
    process.exit(1);
  }

  const agentDef = manifest?.agents?.[agentKey];

  // Prefer the launch command stored at spawn time (captures dynamic state),
  // fall back to manifest definition, then to agent key as last resort
  const storedCmd = connection.launch_cmd;
  let remoteCmd: string;
  if (storedCmd) {
    // Stored command already includes source ~/.spawnrc, PATH setup, etc.
    remoteCmd = storedCmd;
  } else {
    const launchCmd = agentDef?.launch ?? agentKey;
    const preLaunch = agentDef?.pre_launch;
    const parts = [
      "source ~/.spawnrc 2>/dev/null",
    ];
    if (preLaunch) {
      parts.push(preLaunch);
    }
    parts.push(launchCmd);
    remoteCmd = parts.reduce((acc, part) => {
      if (!acc) {
        return part;
      }
      const sep = acc.trimEnd().endsWith("&") ? " " : "; ";
      return acc + sep + part;
    }, "");
  }

  const agentName = agentDef?.name || agentKey;

  // Handle Sprite console connections
  if (connection.ip === "sprite-console" && connection.server_name) {
    p.log.step(`Entering ${pc.bold(agentName)} on sprite ${pc.bold(connection.server_name)}...`);
    return runInteractiveCommand(
      "sprite",
      [
        "console",
        "-s",
        connection.server_name,
        "--",
        "bash",
        "-lc",
        remoteCmd,
      ],
      `Failed to enter ${agentName}`,
      `sprite console -s ${connection.server_name} -- bash -lc '${remoteCmd}'`,
    );
  }

  // Handle Daytona sandbox connections
  if (connection.ip === "daytona-sandbox" && connection.server_id) {
    p.log.step(`Entering ${pc.bold(agentName)} on Daytona sandbox ${pc.bold(connection.server_id)}...`);
    return runInteractiveCommand(
      "daytona",
      [
        "ssh",
        connection.server_id,
        "--",
        "bash",
        "-lc",
        remoteCmd,
      ],
      `Failed to enter ${agentName}`,
      `daytona ssh ${connection.server_id} -- bash -lc '${remoteCmd}'`,
    );
  }

  // Standard SSH connection with agent launch
  p.log.step(`Entering ${pc.bold(agentName)} on ${pc.bold(connection.ip)}...`);
  const escapedRemoteCmd = remoteCmd.replace(/'/g, "'\\''");
  return runInteractiveCommand(
    "ssh",
    [
      ...SSH_INTERACTIVE_OPTS,
      `${connection.user}@${connection.ip}`,
      "--",
      `bash -lc '${escapedRemoteCmd}'`,
    ],
    `Failed to enter ${agentName}`,
    `ssh -t ${connection.user}@${connection.ip} -- bash -lc '${escapedRemoteCmd}'`,
  );
}

// ── Agents ─────────────────────────────────────────────────────────────────────

export function getImplementedAgents(manifest: Manifest, cloud: string): string[] {
  return agentKeys(manifest).filter((a: string): boolean => matrixStatus(manifest, cloud, a) === "implemented");
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
  if (vars.length === 0) {
    return false;
  }
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

// ── Clouds ─────────────────────────────────────────────────────────────────────

/** Format credential status indicator for a cloud in the list view */
function formatCredentialIndicator(auth: string): string {
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
      const credIndicator = formatCredentialIndicator(c.auth);
      console.log(
        `    ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${c.name.padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(`${countStr.padEnd(6)} ${c.description}`)}${credIndicator}`,
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

// ── Info helpers ───────────────────────────────────────────────────────────────

/** Print name, description, url, and notes for a manifest entry */
function printInfoHeader(entry: { name: string; description: string; url?: string; notes?: string }): void {
  console.log();
  console.log(`${pc.bold(entry.name)} ${pc.dim("--")} ${entry.description}`);
  if (entry.url) {
    console.log(pc.dim(`  ${entry.url}`));
  }
  if (entry.notes) {
    console.log(pc.dim(`  ${entry.notes}`));
  }
}

/** Group keys by a classifier function (e.g., cloud type) */
function groupByType(keys: string[], getType: (key: string) => string): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const key of keys) {
    const type = getType(key);
    if (!byType[type]) {
      byType[type] = [];
    }
    byType[type].push(key);
  }
  return byType;
}

/** Print a grouped list of items with command hints */
function printGroupedList(
  byType: Record<string, string[]>,
  getName: (key: string) => string,
  getHint: (key: string) => string,
  indent = "  ",
): void {
  for (const [type, keys] of Object.entries(byType)) {
    console.log(`${indent}${pc.dim(type)}`);
    for (const key of keys) {
      console.log(
        `${indent}  ${pc.green(key.padEnd(NAME_COLUMN_WIDTH))} ${getName(key).padEnd(NAME_COLUMN_WIDTH)} ${pc.dim(getHint(key))}`,
      );
    }
  }
}

// ── Agent Info ─────────────────────────────────────────────────────────────────

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

function checkAllCredentialsReady(auth: string): boolean {
  const hasCreds = hasCloudCredentials(auth);
  const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
  return hasOpenRouterKey && (hasCreds || auth.toLowerCase() === "none");
}

function printAuthVariableStatus(authVars: string[], cloudUrl?: string): void {
  console.log(formatAuthVarLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys"));
  for (let i = 0; i < authVars.length; i++) {
    console.log(formatAuthVarLine(authVars[i], i === 0 ? cloudUrl : undefined));
  }
}

/** Print quick-start instructions showing credential status and example spawn command */
function printQuickStart(opts: { auth: string; authVars: string[]; cloudUrl?: string; spawnCmd?: string }): void {
  console.log();

  if (checkAllCredentialsReady(opts.auth) && opts.spawnCmd) {
    console.log(pc.bold("Quick start:") + "  " + pc.green("credentials detected -- ready to go"));
    console.log(`  ${pc.cyan(opts.spawnCmd)}`);
    return;
  }

  console.log(pc.bold("Quick start:"));
  printAuthVariableStatus(opts.authVars, opts.cloudUrl);
  if (opts.spawnCmd) {
    console.log(`  ${pc.cyan(opts.spawnCmd)}`);
  }
}

// ── Cloud Info ─────────────────────────────────────────────────────────────────

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

  console.log();
  console.log(pc.dim(`  Full setup guide: ${pc.cyan(`https://github.com/${REPO}/tree/main/sh/${cloudKey}`)}`));
  console.log();
}

// ── Update ─────────────────────────────────────────────────────────────────────

async function fetchRemoteVersion(): Promise<string> {
  const res = await fetch(`${RAW_BASE}/packages/cli/package.json`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const data = parseJsonWith(await res.text(), PkgVersionSchema);
  if (!data?.version) {
    throw new Error("Invalid package.json: no version field");
  }
  return data.version;
}

const INSTALL_CMD = `curl -fsSL ${RAW_BASE}/sh/cli/install.sh | bash`;

async function performUpdate(_remoteVersion: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  try {
    execSync(INSTALL_CMD, {
      stdio: "inherit",
      shell: "/bin/bash",
    });
    console.log();
    p.log.success("Updated successfully!");
    p.log.info("Run spawn again to use the new version.");
  } catch (_err) {
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
    console.error("\nHow to fix:");
    console.error("  1. Check your internet connection");
    console.error("  2. Try again in a few moments");
    console.error(`  3. Update manually: ${pc.cyan(INSTALL_CMD)}`);
  }
}

// ── Help ───────────────────────────────────────────────────────────────────────

function getHelpUsageSection(): string {
  return `${pc.bold("USAGE")}
  spawn                              Interactive agent + cloud picker
  spawn <agent> <cloud>              Launch agent on cloud directly
  spawn <agent> <cloud> --dry-run    Preview what would be provisioned (or -n)
  spawn <agent> <cloud> --custom      Show interactive size/region pickers
  spawn <agent> <cloud> --headless   Provision and exit (no interactive session)
  spawn <agent> <cloud> --output json
                                     Headless mode with structured JSON on stdout
  spawn <agent> <cloud> --prompt "text"
                                     Execute agent with prompt (non-interactive)
  spawn <agent> <cloud> --prompt-file <file>  (or -f)
                                     Execute agent with prompt from file
  spawn <agent>                      Interactive cloud picker for agent
  spawn <cloud>                      Show available agents for cloud
  spawn list                         Browse and rerun previous spawns (aliases: ls, history)
  spawn list <filter>                Filter history by agent or cloud name
  spawn list -a <agent>              Filter spawn history by agent (or --agent)
  spawn list -c <cloud>              Filter spawn history by cloud (or --cloud)
  spawn list --clear                 Clear all spawn history
  spawn delete                       Delete a previously spawned server (aliases: rm, destroy, kill)
  spawn delete -a <agent>            Filter servers by agent
  spawn delete -c <cloud>            Filter servers by cloud
  spawn last                         Instantly rerun the most recent spawn (alias: rerun)
  spawn matrix                       Full availability matrix (alias: m)
  spawn agents                       List all agents with descriptions
  spawn clouds                       List all cloud providers
  spawn update                       Check for CLI updates
  spawn version                      Show version (or --version, -v)
  spawn help                         Show this help message (or --help, -h)`;
}

function getHelpExamplesSection(): string {
  return `${pc.bold("EXAMPLES")}
  spawn                              ${pc.dim("# Pick interactively")}
  spawn openclaw sprite              ${pc.dim("# Launch OpenClaw on Sprite")}
  spawn codex hetzner                ${pc.dim("# Launch Codex CLI on Hetzner Cloud")}
  spawn kilocode digitalocean        ${pc.dim("# Launch Kilo Code on DigitalOcean")}
  spawn claude sprite --prompt "Fix all linter errors"
                                     ${pc.dim("# Execute Claude with prompt and exit")}
  spawn codex sprite -p "Add tests"  ${pc.dim("# Short form of --prompt")}
  spawn openclaw aws -f instructions.txt
                                     ${pc.dim("# Read prompt from file (short for --prompt-file)")}
  spawn opencode gcp --dry-run       ${pc.dim("# Preview without provisioning")}
  spawn claude hetzner --headless    ${pc.dim("# Provision, print connection info, exit")}
  spawn claude hetzner --output json ${pc.dim("# Structured JSON output on stdout")}
  spawn claude                       ${pc.dim("# Show which clouds support Claude")}
  spawn hetzner                      ${pc.dim("# Show which agents run on Hetzner")}
  spawn list                         ${pc.dim("# Browse history and pick one to rerun")}
  spawn list codex                   ${pc.dim("# Filter history by agent name")}
  spawn last                         ${pc.dim("# Instantly rerun the most recent spawn")}
  spawn matrix                       ${pc.dim("# See the full agent x cloud matrix")}`;
}

function getHelpAuthSection(): string {
  return `${pc.bold("AUTHENTICATION")}
  All agents use OpenRouter for LLM access. Get your API key at:
  ${pc.cyan("https://openrouter.ai/settings/keys")}

  For non-interactive use, set environment variables:
  ${pc.dim("OPENROUTER_API_KEY")}=sk-or-v1-... spawn claude sprite

  Each cloud provider has its own auth requirements.
  Run ${pc.cyan("spawn <cloud>")} to see setup instructions for a specific provider.`;
}

function getHelpInstallSection(): string {
  return `${pc.bold("INSTALL")}
  curl -fsSL ${RAW_BASE}/sh/cli/install.sh | bash`;
}

function getHelpTroubleshootingSection(): string {
  return `${pc.bold("TROUBLESHOOTING")}
  ${pc.dim("*")} Script not found: Run ${pc.cyan("spawn matrix")} to verify the combination exists
  ${pc.dim("*")} Missing credentials: Run ${pc.cyan("spawn <cloud>")} to see setup instructions
  ${pc.dim("*")} Update issues: Try ${pc.cyan("spawn update")} or reinstall manually
  ${pc.dim("*")} Garbled unicode: Set ${pc.cyan("SPAWN_NO_UNICODE=1")} for ASCII-only output
  ${pc.dim("*")} Missing unicode over SSH: Set ${pc.cyan("SPAWN_UNICODE=1")} to force unicode on
  ${pc.dim("*")} Slow startup: Set ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")} to skip auto-update`;
}

function getHelpEnvVarsSection(): string {
  return `${pc.bold("ENVIRONMENT VARIABLES")}
  ${pc.cyan("OPENROUTER_API_KEY")}        OpenRouter API key (all agents require this)
  ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")}   Skip auto-update check on startup
  ${pc.cyan("SPAWN_NO_UNICODE=1")}        Force ASCII output (no unicode symbols)
  ${pc.cyan("SPAWN_UNICODE=1")}           Force Unicode output (override auto-detection)
  ${pc.cyan("SPAWN_HOME")}                Override spawn data directory (default: ~/.spawn)
  ${pc.cyan("SPAWN_DEBUG=1")}             Show debug output (unicode detection, etc.)
  ${pc.cyan("SPAWN_HEADLESS=1")}          Set automatically in --headless mode (for scripts)
  ${pc.cyan("SPAWN_CUSTOM=1")}           Set automatically in --custom mode (show size/region pickers)`;
}

function getHelpFooterSection(): string {
  return `${pc.bold("MORE INFO")}
  Repository:  https://github.com/${REPO}
  OpenRouter:  https://openrouter.ai`;
}

// ── Pick ────────────────────────────────────────────────────────────────────

/**
 * `spawn pick` — interactive option picker invokable from bash scripts.
 *
 * Reads options from stdin (when piped) as tab-separated lines:
 *   "value\tLabel\tHint"
 *
 * Supported flags:
 *   --prompt <text>    Question shown above the option list
 *   --default <value>  Value pre-selected in the picker
 *
 * Writes the selected value to stdout (one line, no extra whitespace).
 * Exit code 0 = selection made; exit code 1 = cancelled / no TTY.
 *
 * Example from bash:
 *   zone=$(printf 'us-central1-a\tIowa\nus-east1-b\tVirginia\n' \
 *            | spawn pick --prompt "Select GCP zone" --default "us-central1-a")
 */
export async function cmdPick(pickArgs: string[]): Promise<void> {
  // ── parse flags ──────────────────────────────────────────────────────────
  let message = "Select an option";
  let defaultValue: string | undefined;

  const remaining: string[] = [];
  for (let i = 0; i < pickArgs.length; i++) {
    const a = pickArgs[i];
    if ((a === "--prompt" || a === "-p") && pickArgs[i + 1]) {
      message = pickArgs[++i];
    } else if (a === "--default" && pickArgs[i + 1]) {
      defaultValue = pickArgs[++i];
    } else if (!a.startsWith("-")) {
      remaining.push(a);
    }
    // unknown flags silently ignored — keeps pick composable
  }

  // ── read options from stdin (if piped) ────────────────────────────────────
  const { parsePickerInput, pickToTTY } = await import("./picker.js");

  let inputText = "";
  if (!process.stdin.isTTY) {
    // Stdin is piped — read options from it synchronously
    const { readFileSync } = await import("node:fs");
    try {
      inputText = readFileSync(0, "utf8"); // fd 0 = stdin
    } catch {
      // ignore read errors (e.g. already closed)
    }
  }

  const options = parsePickerInput(inputText);

  if (options.length === 0) {
    process.stderr.write(
      pc.red("spawn pick: no options provided.\n") +
        pc.dim(
          "  Supply options via stdin as tab-separated lines:\n" +
            '  printf "value1\\tLabel1\\nvalue2\\tLabel2" | spawn pick --prompt "..."\n',
        ),
    );
    process.exit(1);
  }

  // ── run picker ────────────────────────────────────────────────────────────
  const config = {
    message,
    options,
    defaultValue,
  };

  // pickToTTY already falls back to pickFallback internally when /dev/tty is
  // unavailable or stty fails.  It returns null only when the user cancels.
  const result = pickToTTY(config);

  if (result === null) {
    // User pressed Ctrl-C / Escape — or an unrecoverable TTY error
    process.exit(1);
  }

  // Write ONLY the selected value to stdout (so bash `$()` captures it cleanly)
  process.stdout.write(result + "\n");
}

export function cmdHelp(): void {
  const sections = [
    "",
    `${pc.bold("spawn")} -- Launch any AI coding agent on any cloud`,
    "",
    getHelpUsageSection(),
    "",
    getHelpExamplesSection(),
    "",
    getHelpAuthSection(),
    "",
    getHelpInstallSection(),
    "",
    getHelpTroubleshootingSection(),
    "",
    getHelpEnvVarsSection(),
    "",
    getHelpFooterSection(),
  ];
  console.log(sections.join("\n"));
}

import "../unicode-detect.js"; // Must be first: configures TERM before clack reads it
import type { Manifest } from "../manifest.js";

import * as fs from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import pkg from "../../package.json" with { type: "json" };
import { agentKeys, cloudKeys, isStaleCache, loadManifest, matrixStatus } from "../manifest.js";
import { validateIdentifier, validatePrompt } from "../security.js";
import { PkgVersionSchema } from "../shared/parse.js";
import { getSpawnCloudConfigPath } from "../shared/paths.js";
import { getErrorMessage, isString } from "../shared/type-guards.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const VERSION = pkg.version;
export const FETCH_TIMEOUT = 10_000; // 10 seconds
export const NAME_COLUMN_WIDTH = 18;

export { PkgVersionSchema };

// ── Helpers ──────────────────────────────────────────────────────────────────

export { getErrorMessage };

export function handleCancel(): never {
  p.outro(pc.dim("Cancelled."));
  process.exit(0);
}

export async function withSpinner<T>(msg: string, fn: () => Promise<T>, doneMsg?: string): Promise<T> {
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

export function validateNonEmptyString(value: string, fieldName: string, helpCommand: string): void {
  if (!value || value.trim() === "") {
    p.log.error(`${fieldName} is required but was not provided.`);
    p.log.info(`Run ${pc.cyan(helpCommand)} to see all available options.`);
    process.exit(1);
  }
}

export function mapToSelectOptions<
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

// ── Fuzzy matching ───────────────────────────────────────────────────────────

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

// ── Entity resolution ────────────────────────────────────────────────────────

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
export const ENTITY_DEFS: Record<"agent" | "cloud", EntityDef> = {
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

export function validateEntity(manifest: Manifest, value: string, kind: "agent" | "cloud"): void {
  if (!checkEntity(manifest, value, kind)) {
    process.exit(1);
  }
}

export async function validateAndGetEntity(
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

export function validateImplementation(manifest: Manifest, cloud: string, agent: string): void {
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

// ── Credential helpers ───────────────────────────────────────────────────────

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
    hintOverrides[c] = `${manifest.clouds[c].price ?? ""} — credentials detected`;
  }
  for (const c of featured) {
    hintOverrides[c] = `${manifest.clouds[c].price ?? ""} — recommended`;
  }
  for (const c of withCli) {
    hintOverrides[c] = `${manifest.clouds[c].price ?? ""} — CLI installed`;
  }
  for (const c of rest) {
    hintOverrides[c] = `${manifest.clouds[c].price ?? ""} — ${manifest.clouds[c].description}`;
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

/** Format a single credential env var as a status line (green if set, red if missing) */
export function formatCredStatusLine(varName: string, urlHint?: string): string {
  if (process.env[varName]) {
    return `  ${pc.green(varName)} ${pc.dim("-- set")}`;
  }
  const suffix = urlHint ? `  ${pc.dim(urlHint)}` : "";
  return `  ${pc.red(varName)} ${pc.dim("-- not set")}${suffix}`;
}

/** Check if credentials are saved in ~/.config/spawn/{cloud}.json */
function hasCloudConfigCredentials(cloud: string): boolean {
  try {
    const configPath = getSpawnCloudConfigPath(cloud);
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

export function collectMissingCredentials(authVars: string[], cloud?: string): string[] {
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
    return "You will be prompted to authenticate with OpenRouter during setup.";
  }
  return `Run ${pc.cyan(`spawn ${cloud}`)} for setup instructions.`;
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

  // No confirmation needed — the warning + guidance above is sufficient.
  // The orchestration pipeline will prompt for credentials as needed.
}

/** Build auth hint string from cloud auth field for error messages */
export function getAuthHint(manifest: Manifest, cloud: string): string | undefined {
  const authVars = parseAuthEnvVars(manifest.clouds[cloud].auth);
  return authVars.length > 0 ? authVars.join(" + ") : undefined;
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

export function isInteractiveTTY(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/** Validate inputs for injection attacks (SECURITY) and check they're non-empty */
export function validateRunSecurity(agent: string, cloud: string, prompt?: string): void {
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
export function validateEntities(manifest: Manifest, agent: string, cloud: string): void {
  const agentValid = checkEntity(manifest, agent, "agent");
  const cloudValid = checkEntity(manifest, cloud, "cloud");
  if (!agentValid || !cloudValid) {
    process.exit(1);
  }
  validateImplementation(manifest, cloud, agent);
}

// ── Info helpers ─────────────────────────────────────────────────────────────

/** Print name, description, url, and notes for a manifest entry */
export function printInfoHeader(entry: { name: string; description: string; url?: string; notes?: string }): void {
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
export function groupByType(keys: string[], getType: (key: string) => string): Record<string, string[]> {
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
export function printGroupedList(
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
export function printQuickStart(opts: {
  auth: string;
  authVars: string[];
  cloudUrl?: string;
  spawnCmd?: string;
}): void {
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

export function getImplementedAgents(manifest: Manifest, cloud: string): string[] {
  return agentKeys(manifest).filter((a: string): boolean => matrixStatus(manifest, cloud, a) === "implemented");
}

/** Resolve an agent/cloud key to its display name, or return the key as-is */
export function resolveDisplayName(manifest: Manifest | null, key: string, kind: "agent" | "cloud"): string {
  if (!manifest) {
    return key;
  }
  const entry = kind === "agent" ? manifest.agents[key] : manifest.clouds[key];
  return entry ? entry.name : key;
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

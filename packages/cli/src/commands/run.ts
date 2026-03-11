import type { Manifest } from "../manifest.js";

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { buildDashboardHint, EXIT_CODE_GUIDANCE, SIGNAL_GUIDANCE } from "../guidance-data.js";
import { generateSpawnId, getActiveServers, saveSpawnRecord } from "../history.js";
import { loadManifest, RAW_BASE, REPO, SPAWN_CDN } from "../manifest.js";
import { validateIdentifier, validatePrompt, validateScriptContent } from "../security.js";
import { asyncTryCatch, isFileError, tryCatch, tryCatchIf } from "../shared/result.js";
import { prepareStdinForHandoff, toKebabCase } from "../shared/ui.js";
import { promptSetupOptions, promptSpawnName } from "./interactive.js";
import { handleRecordAction } from "./list.js";
import {
  buildRetryCommand,
  collectMissingCredentials,
  credentialHints,
  FETCH_TIMEOUT,
  formatCredStatusLine,
  getAuthHint,
  getErrorMessage,
  loadManifestWithSpinner,
  parseAuthEnvVars,
  preflightCredentialCheck,
  resolveAgentKey,
  resolveCloudKey,
  validateEntities,
  validateRunSecurity,
} from "./shared.js";

// ── Dry-run helpers ──────────────────────────────────────────────────────────

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
  price: string;
  description: string;
  defaults?: Record<string, string>;
}): string[] {
  const lines = [
    `  Name:        ${cloudInfo.name}`,
    `  Price:       ${cloudInfo.price}`,
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

export function showDryRunPreview(manifest: Manifest, agent: string, cloud: string, prompt?: string): void {
  p.log.info(pc.bold("Dry run -- no resources will be provisioned\n"));

  printDryRunSection("Agent", buildAgentLines(manifest.agents[agent]));
  printDryRunSection("Cloud", buildCloudLines(manifest.clouds[cloud]));
  printDryRunSection("Script", [
    `  URL: ${SPAWN_CDN}/${cloud}/${agent}.sh`,
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

// ── Script download ──────────────────────────────────────────────────────────

async function downloadScriptWithFallback(primaryUrl: string, fallbackUrl: string): Promise<string> {
  const s = p.spinner();
  s.start("Downloading spawn script...");

  const r = await asyncTryCatch(async () => {
    const res = await fetch(primaryUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.ok) {
      const text = await res.text();
      s.stop("Script downloaded");
      return text;
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
    const text = await ghRes.text();
    s.stop("Script downloaded (fallback)");
    return text;
  });
  if (!r.ok) {
    s.stop(pc.red("Download failed"));
    throw r.error;
  }
  return r.data;
}

// Report 404 errors (script not found)
function report404Failure(): void {
  p.log.error("Script not found (HTTP 404)");
  console.error("\nThe spawn script doesn't exist at the expected location.");
  console.error("\nThis usually means:");
  console.error("  \u2022 The agent + cloud combination hasn't been implemented yet");
  console.error("  \u2022 The script is currently being deployed (rare)");
  console.error("  \u2022 There's a temporary issue with the file server");
  console.error(`\n${pc.bold("Next steps:")}`);
  console.error(`  1. Verify it's implemented: ${pc.cyan("spawn matrix")}`);
  console.error("  2. If the matrix shows \u2713, wait 1-2 minutes and retry");
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
    console.error("  4. If GitHub is down, retry when it's back up");
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
      "  \u2022 Slow or unstable internet connection",
      "  \u2022 Download server not responding (possibly overloaded)",
      "  \u2022 Firewall blocking or slowing the connection",
    ],
    steps: (ghUrl) => [
      "  2. Verify combination exists: " + pc.cyan("spawn matrix"),
      "  3. Wait a moment and retry",
      "  4. Test URL directly: " + pc.dim(ghUrl),
    ],
  },
  connection: {
    causes: [
      "  \u2022 No internet connection",
      "  \u2022 Firewall or proxy blocking GitHub access",
      "  \u2022 DNS not resolving GitHub's domain",
    ],
    steps: () => [
      "  2. Test github.com access in your browser",
      "  3. Check firewall/VPN settings",
      "  4. Try disabling proxy temporarily",
    ],
  },
  unknown: {
    causes: [
      "  \u2022 Internet connection issue",
      "  \u2022 GitHub's servers temporarily down",
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

// ── Script failure guidance ──────────────────────────────────────────────────

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

// ── Bash execution ───────────────────────────────────────────────────────────

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
  const r = tryCatch(() => runBash(script, prompt, debug, spawnName));
  if (r.ok) {
    return undefined;
  }

  const errMsg = getErrorMessage(r.error);
  handleUserInterrupt(errMsg, dashboardUrl);

  // SSH disconnect after the server was already created — don't retry
  if (isRetryableExitCode(errMsg)) {
    console.error();
    p.log.warn("SSH connection lost. Your server is likely still running.");
    p.log.warn("To reconnect, re-run the same spawn command.");
    return undefined; // Don't report as failure — user already has clear guidance
  }

  return errMsg;
}

export async function execScript(
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

  const dlResult = await asyncTryCatch(() => downloadScriptWithFallback(url, ghUrl));
  if (!dlResult.ok) {
    reportDownloadError(ghUrl, dlResult.error);
    return; // Exit early - cannot proceed without script content
  }
  const scriptContent = dlResult.data;

  // Generate a unique spawn ID and record the spawn before execution
  const spawnId = generateSpawnId();
  const saveResult = tryCatchIf(isFileError, () =>
    saveSpawnRecord({
      id: spawnId,
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
    }),
  );
  // Non-fatal: don't block the spawn if history write fails
  if (!saveResult.ok && debug) {
    console.error(pc.dim(`Warning: Failed to save spawn record: ${getErrorMessage(saveResult.error)}`));
  }

  // Pass spawn ID to the bash script so connection data can be linked back
  process.env.SPAWN_ID = spawnId;

  const lastErr = runBashScript(scriptContent, prompt, dashboardUrl, debug, spawnName);
  if (lastErr) {
    reportScriptFailure(lastErr, cloud, agent, authHint, prompt, dashboardUrl, spawnName);
  }
}

// ── Headless Mode ────────────────────────────────────────────────────────────

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
  const validationResult = tryCatch(() => {
    validateIdentifier(agent, "Agent name");
    validateIdentifier(cloud, "Cloud name");
    if (prompt) {
      validatePrompt(prompt);
    }
  });
  if (!validationResult.ok) {
    headlessError(agent, cloud, "VALIDATION_ERROR", getErrorMessage(validationResult.error), outputFormat, 3);
  }

  // Load manifest (silently - no spinner in headless mode)
  const manifestResult = await asyncTryCatch(loadManifest);
  if (!manifestResult.ok) {
    headlessError(agent, cloud, "MANIFEST_ERROR", getErrorMessage(manifestResult.error), outputFormat, 3);
  }
  const manifest = manifestResult.data;

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
      const realResult = tryCatchIf(isFileError, () => fs.realpathSync(candidatePath));
      if (realResult.ok) {
        // Ensure the resolved path stays inside the CLI dir (no path traversal)
        const prefix = resolvedCliDir.endsWith(path.sep) ? resolvedCliDir : resolvedCliDir + path.sep;
        if (realResult.data.startsWith(prefix)) {
          localScriptResolved = realResult.data;
        }
      }
      // File doesn't exist — fall through to remote fetch
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

    const fetchResult = await asyncTryCatch(async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (res.ok) {
        return res.text();
      }
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
      return ghRes.text();
    });
    if (!fetchResult.ok) {
      headlessError(
        resolvedAgent,
        resolvedCloud,
        "DOWNLOAD_ERROR",
        `Failed to download script: ${getErrorMessage(fetchResult.error)}`,
        outputFormat,
        2,
      );
    }
    scriptContent = fetchResult.data;
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

  const result: SpawnResult = {
    status: "success",
    cloud: resolvedCloud,
    agent: resolvedAgent,
  };

  headlessOutput(result, outputFormat);
}

// ── cmdRun ───────────────────────────────────────────────────────────────────

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

  const enabledSteps = await promptSetupOptions(agent);
  if (enabledSteps) {
    process.env.SPAWN_ENABLED_STEPS = [
      ...enabledSteps,
    ].join(",");
  }

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

#!/usr/bin/env bun
import {
  cmdInteractive,
  cmdAgentInteractive,
  cmdRun,
  cmdList,
  cmdListClear,
  cmdLast,
  cmdMatrix,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdCloudInfo,
  cmdUpdate,
  cmdHelp,
  findClosestKeyByNameOrKey,
  resolveAgentKey,
  resolveCloudKey,
  loadManifestWithSpinner,
} from "./commands.js";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { checkForUpdates } from "./update-check.js";
import { loadManifest, agentKeys, cloudKeys, getCacheAge } from "./manifest.js";

const VERSION = pkg.version;

function isInteractiveTTY(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function handleError(err: unknown): never {
  // Use duck typing instead of instanceof to avoid prototype chain issues
  const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  console.error(pc.red(`Error: ${msg}`));
  console.error(`\nRun ${pc.cyan("spawn help")} for usage information.`);
  process.exit(1);
}

/** Extract a flag and its value from args, returning [value, remainingArgs] */
function extractFlagValue(
  args: string[],
  flags: string[],
  flagLabel: string,
  usageHint: string
): [string | undefined, string[]] {
  const idx = args.findIndex(arg => flags.includes(arg));
  if (idx === -1) return [undefined, args];

  if (!args[idx + 1] || args[idx + 1].startsWith("-")) {
    console.error(pc.red(`Error: ${pc.bold(args[idx])} requires a value`));
    console.error(`\nUsage: ${pc.cyan(usageHint)}`);
    process.exit(1);
  }

  const value = args[idx + 1];
  const remaining = [...args];
  remaining.splice(idx, 2);
  return [value, remaining];
}

const HELP_FLAGS = ["--help", "-h", "help"];

const KNOWN_FLAGS = new Set([
  "--help", "-h",
  "--version", "-v", "-V",
  "--prompt", "-p", "--prompt-file", "-f",
  "--dry-run", "-n",
  "--debug",
  "-a", "-c", "--agent", "--cloud",
  "--clear",
]);

/** Expand --flag=value into --flag value so all flag parsing works uniformly */
export function expandEqualsFlags(args: string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      result.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      result.push(arg);
    }
  }
  return result;
}

/** Check for unknown flags and show an actionable error */
function checkUnknownFlags(args: string[]): void {
  for (const arg of args) {
    if ((arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg))) && !KNOWN_FLAGS.has(arg)) {
      console.error(pc.red(`Unknown flag: ${pc.bold(arg)}`));
      console.error();
      console.error(`  Supported flags:`);
      console.error(`    ${pc.cyan("--prompt, -p")}        Provide a prompt for non-interactive execution`);
      console.error(`    ${pc.cyan("--prompt-file, -f")}   Read prompt from a file`);
      console.error(`    ${pc.cyan("--dry-run, -n")}       Preview what would be provisioned`);
      console.error(`    ${pc.cyan("--debug")}             Show all commands being executed`);
      console.error(`    ${pc.cyan("--help, -h")}          Show help information`);
      console.error(`    ${pc.cyan("--version, -v")}       Show version`);
      console.error();
      console.error(`  For ${pc.cyan("spawn list")}:`);
      console.error(`    ${pc.cyan("-a, --agent")}         Filter history by agent`);
      console.error(`    ${pc.cyan("-c, --cloud")}         Filter history by cloud`);
      console.error(`    ${pc.cyan("--clear")}             Clear all spawn history`);
      console.error();
      console.error(`  Run ${pc.cyan("spawn help")} for full usage information.`);
      process.exit(1);
    }
  }
}

/** Show info for a name that could be an agent or cloud, or show an error with suggestions */
function showUnknownCommandError(name: string, manifest: { agents: Record<string, { name: string }>; clouds: Record<string, { name: string }> }): never {
  const agentMatch = findClosestKeyByNameOrKey(name, agentKeys(manifest), (k) => manifest.agents[k].name);
  const cloudMatch = findClosestKeyByNameOrKey(name, cloudKeys(manifest), (k) => manifest.clouds[k].name);

  // Check for typos in subcommands
  const allSubcommands = ["help", "agents", "clouds", "matrix", "m", "list", "ls", "history", "update", "last", "rerun"];
  const subcommandMatch = findClosestMatch(name, allSubcommands);

  console.error(pc.red(`Unknown agent or cloud: ${pc.bold(name)}`));
  console.error();

  const suggestions: string[] = [];
  if (agentMatch) suggestions.push(`${pc.cyan(agentMatch)} (agent: ${manifest.agents[agentMatch].name})`);
  if (cloudMatch) suggestions.push(`${pc.cyan(cloudMatch)} (cloud: ${manifest.clouds[cloudMatch].name})`);
  if (subcommandMatch && !agentMatch && !cloudMatch) {
    suggestions.push(`${pc.cyan(subcommandMatch)} (command)`);
  }

  if (suggestions.length > 0) {
    console.error(`  Did you mean ${suggestions.join(" or ")}?`);
    console.error();
  }

  console.error(`  Run ${pc.cyan("spawn help")} for available commands.`);
  console.error(`  Run ${pc.cyan("spawn agents")} to see available agents.`);
  console.error(`  Run ${pc.cyan("spawn clouds")} to see available clouds.`);
  process.exit(1);
}

async function showInfoOrError(name: string): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  // Direct key match — pass pre-loaded manifest to avoid a redundant spinner
  if (manifest.agents[name]) { await cmdAgentInfo(name, manifest); return; }
  if (manifest.clouds[name]) { await cmdCloudInfo(name, manifest); return; }

  // Try resolving display names and case-insensitive matches
  const resolvedAgent = resolveAgentKey(manifest, name);
  if (resolvedAgent) { await cmdAgentInfo(resolvedAgent, manifest); return; }
  const resolvedCloud = resolveCloudKey(manifest, name);
  if (resolvedCloud) { await cmdCloudInfo(resolvedCloud, manifest); return; }

  showUnknownCommandError(name, manifest);
}

async function handleDefaultCommand(agent: string, cloud: string | undefined, prompt?: string, dryRun?: boolean, debug?: boolean): Promise<void> {
  if (cloud && HELP_FLAGS.includes(cloud)) {
    await showInfoOrError(agent);
    return;
  }
  if (cloud) {
    await cmdRun(agent, cloud, prompt, dryRun, debug);
    return;
  }
  if (dryRun) {
    console.error(pc.red("Error: --dry-run requires both <agent> and <cloud>"));
    console.error(`\nUsage: ${pc.cyan(`spawn <agent> <cloud> --dry-run`)}`);
    process.exit(1);
  }
  if (prompt) {
    await suggestCloudsForPrompt(agent);
    process.exit(1);
  }

  // Interactive cloud selection when agent is provided without cloud
  if (isInteractiveTTY()) {
    await cmdAgentInteractive(agent, prompt, dryRun);
    return;
  }

  await showInfoOrError(agent);
}

/** Show "prompt requires cloud" error and suggest available clouds for the agent */
async function suggestCloudsForPrompt(agent: string): Promise<void> {
  console.error(pc.red("Error: --prompt requires both <agent> and <cloud>"));
  console.error(`\nUsage: ${pc.cyan(`spawn ${agent} <cloud> --prompt "your prompt here"`)}`);

  try {
    const manifest = await loadManifest();
    const resolvedAgent = resolveAgentKey(manifest, agent);
    if (!resolvedAgent) return;

    const clouds = cloudKeys(manifest).filter(
      (c: string) => manifest.matrix[`${c}/${resolvedAgent}`] === "implemented"
    );
    if (clouds.length === 0) return;

    console.error(`\nAvailable clouds for ${pc.bold(resolvedAgent)}:`);
    for (const c of clouds.slice(0, 5)) {
      console.error(`  ${pc.cyan(`spawn ${resolvedAgent} ${c} --prompt "..."`)}`);
    }
    if (clouds.length > 5) {
      console.error(`  Run ${pc.cyan(`spawn ${resolvedAgent}`)} to see all ${clouds.length} clouds.`);
    }
  } catch {
    // Manifest unavailable — skip cloud suggestions
  }
}

/** Print a descriptive error for a failed prompt file read and exit */
function handlePromptFileError(promptFile: string, err: unknown): never {
  const code = err && typeof err === "object" && "code" in err ? err.code : "";
  if (code === "ENOENT") {
    console.error(pc.red(`Prompt file not found: ${pc.bold(promptFile)}`));
    console.error(`\nCheck the path and try again.`);
  } else if (code === "EACCES") {
    console.error(pc.red(`Permission denied reading prompt file: ${pc.bold(promptFile)}`));
    console.error(`\nCheck file permissions: ${pc.cyan(`ls -la ${promptFile}`)}`);
  } else if (code === "EISDIR") {
    console.error(pc.red(`'${promptFile}' is a directory, not a file.`));
    console.error(`\nProvide a path to a text file containing your prompt.`);
  } else {
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    console.error(pc.red(`Error reading prompt file '${promptFile}': ${msg}`));
  }
  process.exit(1);
}

/** Read and validate a prompt file, exiting on any error */
async function readPromptFile(promptFile: string): Promise<string> {
  const { validatePromptFilePath, validatePromptFileStats } = await import("./security.js");
  const { readFileSync, statSync } = await import("fs");

  try {
    validatePromptFilePath(promptFile);
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    console.error(pc.red(msg));
    process.exit(1);
  }

  try {
    const stats = statSync(promptFile);
    validatePromptFileStats(promptFile, stats);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") {
      handlePromptFileError(promptFile, err);
    }
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    console.error(pc.red(msg));
    process.exit(1);
  }

  try {
    return readFileSync(promptFile, "utf-8");
  } catch (err) {
    handlePromptFileError(promptFile, err);
  }
}

/** Parse --prompt / -p and --prompt-file flags, returning the resolved prompt text and remaining args */
async function resolvePrompt(args: string[]): Promise<[string | undefined, string[]]> {
  let [prompt, filteredArgs] = extractFlagValue(
    args,
    ["--prompt", "-p"],
    "prompt",
    'spawn <agent> <cloud> --prompt "your prompt here"'
  );

  const [promptFile, finalArgs] = extractFlagValue(
    filteredArgs,
    ["--prompt-file", "-f"],
    "prompt file",
    "spawn <agent> <cloud> --prompt-file instructions.txt"
  );
  filteredArgs = finalArgs;

  if (prompt && promptFile) {
    console.error(pc.red("Error: --prompt and --prompt-file cannot be used together"));
    console.error(`\nUse one or the other:`);
    console.error(`  ${pc.cyan('spawn <agent> <cloud> --prompt "your prompt here"')}`);
    console.error(`  ${pc.cyan("spawn <agent> <cloud> --prompt-file instructions.txt")}`);
    process.exit(1);
  }

  if (promptFile) {
    prompt = await readPromptFile(promptFile);
  }

  return [prompt, filteredArgs];
}

/** Handle the case when no command is given (interactive mode or help) */
async function handleNoCommand(prompt: string | undefined, dryRun?: boolean): Promise<void> {
  if (dryRun) {
    console.error(pc.red("Error: --dry-run requires both <agent> and <cloud>"));
    console.error(`\nUsage: ${pc.cyan("spawn <agent> <cloud> --dry-run")}`);
    process.exit(1);
  }
  if (prompt) {
    console.error(pc.red("Error: --prompt requires both <agent> and <cloud>"));
    console.error(`\nUsage: ${pc.cyan('spawn <agent> <cloud> --prompt "your prompt here"')}`);
    process.exit(1);
  }
  if (isInteractiveTTY()) {
    await cmdInteractive();
  } else {
    console.error(pc.yellow("Cannot run interactive picker: not a terminal"));
    console.error(pc.dim("  (stdin/stdout is piped or redirected)"));
    console.error();
    console.error(`  Launch directly:  ${pc.cyan("spawn <agent> <cloud>")}`);
    console.error(`  Rerun previous:   ${pc.cyan("spawn list")}`);
    console.error(`  Browse agents:    ${pc.cyan("spawn agents")}`);
    console.error(`  Browse clouds:    ${pc.cyan("spawn clouds")}`);
    console.error(`  Full help:        ${pc.cyan("spawn help")}`);
    console.error();
    process.exit(1);
  }
}

function formatCacheAge(seconds: number): string {
  if (!isFinite(seconds)) return "no cache";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function showVersion(): void {
  console.log(`spawn v${VERSION}`);
  const binPath = process.argv[1];
  if (binPath) {
    console.log(pc.dim(`  ${binPath}`));
  }
  console.log(pc.dim(`  ${process.versions.bun ? "bun" : "node"} ${process.versions.bun ?? process.versions.node}  ${process.platform} ${process.arch}`));
  const age = getCacheAge();
  console.log(pc.dim(`  manifest cache: ${formatCacheAge(age)}`));
  console.log(pc.dim(`  https://github.com/OpenRouterTeam/spawn`));
  console.log(pc.dim(`  Run ${pc.cyan("spawn update")} to check for updates.`));
}

const IMMEDIATE_COMMANDS: Record<string, () => void> = {
  "help": cmdHelp, "--help": cmdHelp, "-h": cmdHelp,
  "version": showVersion,
  "--version": showVersion,
  "-v": showVersion,
  "-V": showVersion,
};

const SUBCOMMANDS: Record<string, () => Promise<void>> = {
  "matrix": cmdMatrix, "m": cmdMatrix,
  "agents": cmdAgents,
  "clouds": cmdClouds,
  "update": cmdUpdate,
  "last": cmdLast, "rerun": cmdLast,
};

// list/ls/history handled separately for -a/-c flag parsing
const LIST_COMMANDS = new Set(["list", "ls", "history"]);

// Common verb prefixes that users naturally try (e.g. "spawn run claude sprite")
// These are not real subcommands -- we strip them and forward to the default handler
const VERB_ALIASES = new Set(["run", "launch", "start", "deploy", "exec"]);

/** Warn when extra positional arguments are silently ignored */
function warnExtraArgs(filteredArgs: string[], maxExpected: number): void {
  const extra = filteredArgs.slice(maxExpected);
  if (extra.length > 0) {
    console.error(pc.yellow(`Extra argument${extra.length > 1 ? "s" : ""} ignored: ${extra.join(", ")}`));
    console.error(pc.dim(`  Usage: spawn <agent> <cloud> [--prompt "..."]`));
    console.error();
  }
}

/** Parse -a/--agent <agent> and -c/--cloud <cloud> filter flags from args.
 *  Also accepts a bare positional arg as a filter (e.g. "spawn list claude"). */
function parseListFilters(args: string[]): { agentFilter?: string; cloudFilter?: string } {
  let agentFilter: string | undefined;
  let cloudFilter: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" || args[i] === "--agent") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error(pc.red(`Error: ${pc.bold(args[i])} requires an agent name`));
        console.error(`\nUsage: ${pc.cyan("spawn list -a <agent>")}`);
        process.exit(1);
      }
      agentFilter = args[i + 1];
      i++;
    } else if (args[i] === "-c" || args[i] === "--cloud") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error(pc.red(`Error: ${pc.bold(args[i])} requires a cloud name`));
        console.error(`\nUsage: ${pc.cyan("spawn list -c <cloud>")}`);
        process.exit(1);
      }
      cloudFilter = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  // Support bare positional filter: "spawn list claude" or "spawn list hetzner"
  if (!agentFilter && !cloudFilter && positional.length > 0) {
    agentFilter = positional[0];
  }

  return { agentFilter, cloudFilter };
}

/** Check if trailing args contain a help flag */
function hasTrailingHelpFlag(args: string[]): boolean {
  return args.slice(1).some(a => HELP_FLAGS.includes(a));
}

/** Handle list/ls/history commands with filters and --clear */
async function dispatchListCommand(filteredArgs: string[]): Promise<void> {
  if (hasTrailingHelpFlag(filteredArgs)) { cmdHelp(); return; }
  if (filteredArgs.slice(1).includes("--clear")) {
    await cmdListClear();
    return;
  }
  const { agentFilter, cloudFilter } = parseListFilters(filteredArgs.slice(1));
  await cmdList(agentFilter, cloudFilter);
}

/** Handle named subcommands (agents, clouds, matrix, etc.) */
async function dispatchSubcommand(cmd: string, filteredArgs: string[]): Promise<void> {
  if (hasTrailingHelpFlag(filteredArgs)) { cmdHelp(); return; }

  // "spawn agents <name>" or "spawn clouds <name>" -> show info for that name
  if ((cmd === "agents" || cmd === "clouds") && filteredArgs.length > 1 && !filteredArgs[1].startsWith("-")) {
    const name = filteredArgs[1];
    warnExtraArgs(filteredArgs, 2);
    console.error(pc.dim(`Tip: next time you can just run ${pc.cyan(`spawn ${name}`)}`));
    console.error();
    await showInfoOrError(name);
    return;
  }

  warnExtraArgs(filteredArgs, 1);
  await SUBCOMMANDS[cmd]();
}

/** Handle verb aliases like "spawn run claude sprite" -> "spawn claude sprite" */
async function dispatchVerbAlias(cmd: string, filteredArgs: string[], prompt: string | undefined, dryRun: boolean, debug: boolean): Promise<void> {
  if (filteredArgs.length > 1) {
    const remaining = filteredArgs.slice(1);
    warnExtraArgs(remaining, 2);
    await handleDefaultCommand(remaining[0], remaining[1], prompt, dryRun, debug);
    return;
  }
  console.error(pc.red(`Error: ${pc.bold(cmd)} requires an agent and cloud`));
  console.error(`\nUsage: ${pc.cyan("spawn <agent> <cloud>")}`);
  console.error(pc.dim(`  The "${cmd}" keyword is optional -- just use ${pc.cyan("spawn <agent> <cloud>")} directly.`));
  process.exit(1);
}

/** Handle slash notation: "spawn claude/hetzner" -> "spawn claude hetzner" */
async function dispatchSlashNotation(cmd: string, prompt: string | undefined, dryRun: boolean, debug: boolean): Promise<boolean> {
  const parts = cmd.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    console.error(pc.dim(`Tip: use a space instead of slash: ${pc.cyan(`spawn ${parts[0]} ${parts[1]}`)}`));
    console.error();
    await handleDefaultCommand(parts[0], parts[1], prompt, dryRun, debug);
    return true;
  }
  return false;
}

/** Dispatch a named command or fall through to agent/cloud handling */
async function dispatchCommand(cmd: string, filteredArgs: string[], prompt: string | undefined, dryRun: boolean, debug: boolean): Promise<void> {
  if (IMMEDIATE_COMMANDS[cmd]) {
    warnExtraArgs(filteredArgs, 1);
    IMMEDIATE_COMMANDS[cmd]();
    return;
  }

  if (LIST_COMMANDS.has(cmd)) { await dispatchListCommand(filteredArgs); return; }
  if (SUBCOMMANDS[cmd]) { await dispatchSubcommand(cmd, filteredArgs); return; }
  if (VERB_ALIASES.has(cmd)) { await dispatchVerbAlias(cmd, filteredArgs, prompt, dryRun, debug); return; }

  if (filteredArgs.length === 1 && cmd.includes("/")) {
    if (await dispatchSlashNotation(cmd, prompt, dryRun, debug)) return;
  }

  warnExtraArgs(filteredArgs, 2);
  await handleDefaultCommand(filteredArgs[0], filteredArgs[1], prompt, dryRun, debug);
}

async function main(): Promise<void> {
  const args = expandEqualsFlags(process.argv.slice(2));

  await checkForUpdates();

  const [prompt, filteredArgs] = await resolvePrompt(args);

  // Extract --dry-run / -n boolean flag
  const dryRunIdx = filteredArgs.findIndex(a => a === "--dry-run" || a === "-n");
  const dryRun = dryRunIdx !== -1;
  if (dryRun) filteredArgs.splice(dryRunIdx, 1);

  // Extract --debug boolean flag
  const debugIdx = filteredArgs.findIndex(a => a === "--debug");
  const debug = debugIdx !== -1;
  if (debug) filteredArgs.splice(debugIdx, 1);

  checkUnknownFlags(filteredArgs);

  const cmd = filteredArgs[0];

  try {
    if (!cmd) {
      await handleNoCommand(prompt, dryRun);
    } else {
      await dispatchCommand(cmd, filteredArgs, prompt, dryRun, debug);
    }
  } catch (err) {
    handleError(err);
  }
}

main();

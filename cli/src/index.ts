#!/usr/bin/env bun
import {
  cmdInteractive,
  cmdRun,
  cmdList,
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
import { loadManifest, agentKeys, cloudKeys } from "./manifest.js";

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
  "--prompt", "-p", "--prompt-file",
]);

/** Check for unknown flags and show an actionable error */
function checkUnknownFlags(args: string[]): void {
  for (const arg of args) {
    if ((arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg))) && !KNOWN_FLAGS.has(arg)) {
      console.error(pc.red(`Unknown flag: ${pc.bold(arg)}`));
      console.error();
      console.error(`  Supported flags:`);
      console.error(`    ${pc.cyan("--prompt, -p")}        Provide a prompt for non-interactive execution`);
      console.error(`    ${pc.cyan("--prompt-file")}       Read prompt from a file`);
      console.error(`    ${pc.cyan("--help, -h")}          Show help information`);
      console.error(`    ${pc.cyan("--version, -v")}       Show version`);
      console.error();
      console.error(`  Run ${pc.cyan("spawn help")} for full usage information.`);
      process.exit(1);
    }
  }
}

/** Show info for a name that could be an agent or cloud, or show an error with suggestions */
async function showInfoOrError(name: string): Promise<void> {
  const manifest = await loadManifestWithSpinner();
  if (manifest.agents[name]) {
    await cmdAgentInfo(name);
    return;
  }
  if (manifest.clouds[name]) {
    await cmdCloudInfo(name);
    return;
  }

  // Try resolving display names and case-insensitive matches
  const resolvedAgent = resolveAgentKey(manifest, name);
  if (resolvedAgent) {
    await cmdAgentInfo(resolvedAgent);
    return;
  }
  const resolvedCloud = resolveCloudKey(manifest, name);
  if (resolvedCloud) {
    await cmdCloudInfo(resolvedCloud);
    return;
  }

  // Fall back to fuzzy matching suggestions (checks both keys and display names)
  const agentMatch = findClosestKeyByNameOrKey(name, agentKeys(manifest), (k) => manifest.agents[k].name);
  const cloudMatch = findClosestKeyByNameOrKey(name, cloudKeys(manifest), (k) => manifest.clouds[k].name);

  console.error(pc.red(`Unknown command: ${pc.bold(name)}`));
  console.error();
  const fmtAgent = agentMatch ? `${pc.cyan(agentMatch)} (agent: ${manifest.agents[agentMatch].name})` : "";
  const fmtCloud = cloudMatch ? `${pc.cyan(cloudMatch)} (cloud: ${manifest.clouds[cloudMatch].name})` : "";
  if (agentMatch && cloudMatch) {
    console.error(`  Did you mean ${fmtAgent} or ${fmtCloud}?`);
  } else if (agentMatch) {
    console.error(`  Did you mean ${fmtAgent}?`);
  } else if (cloudMatch) {
    console.error(`  Did you mean ${fmtCloud}?`);
  }
  console.error();
  console.error(`  Run ${pc.cyan("spawn agents")} to see available agents.`);
  console.error(`  Run ${pc.cyan("spawn clouds")} to see available clouds.`);
  console.error(`  Run ${pc.cyan("spawn help")} for usage information.`);
  process.exit(1);
}

async function handleDefaultCommand(agent: string, cloud: string | undefined, prompt?: string): Promise<void> {
  if (cloud && HELP_FLAGS.includes(cloud)) {
    await showInfoOrError(agent);
    return;
  }
  if (cloud) {
    await cmdRun(agent, cloud, prompt);
  } else {
    if (prompt) {
      console.error(pc.red("Error: --prompt requires both <agent> and <cloud>"));
      console.error(`\nUsage: ${pc.cyan(`spawn ${agent} <cloud> --prompt "your prompt here"`)}`);

      // Try to suggest available clouds for the agent
      try {
        const manifest = await loadManifest();
        const resolvedAgent = resolveAgentKey(manifest, agent);
        if (resolvedAgent) {
          const clouds = cloudKeys(manifest).filter(
            (c: string) => manifest.matrix[`${c}/${resolvedAgent}`] === "implemented"
          );
          if (clouds.length > 0) {
            console.error(`\nAvailable clouds for ${pc.bold(resolvedAgent)}:`);
            for (const c of clouds.slice(0, 5)) {
              console.error(`  ${pc.cyan(`spawn ${resolvedAgent} ${c} --prompt "..."`)}`);
            }
            if (clouds.length > 5) {
              console.error(`  Run ${pc.cyan(`spawn ${resolvedAgent}`)} to see all ${clouds.length} clouds.`);
            }
          }
        }
      } catch {
        // Manifest unavailable — skip cloud suggestions
      }

      process.exit(1);
    }
    await showInfoOrError(agent);
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
    ["--prompt-file"],
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
    const { readFileSync } = await import("fs");
    try {
      prompt = readFileSync(promptFile, "utf-8");
    } catch (err) {
      handlePromptFileError(promptFile, err);
    }
  }

  return [prompt, filteredArgs];
}

/** Handle the case when no command is given (interactive mode or help) */
async function handleNoCommand(prompt: string | undefined): Promise<void> {
  if (prompt) {
    console.error(pc.red("Error: --prompt requires both <agent> and <cloud>"));
    console.error(`\nUsage: ${pc.cyan('spawn <agent> <cloud> --prompt "your prompt here"')}`);
    process.exit(1);
  }
  if (isInteractiveTTY()) {
    await cmdInteractive();
  } else {
    console.error(pc.yellow("No interactive terminal detected."));
    console.error();
    console.error(`  Launch directly:  ${pc.cyan("spawn <agent> <cloud>")}`);
    console.error(`  Browse agents:    ${pc.cyan("spawn agents")}`);
    console.error(`  Browse clouds:    ${pc.cyan("spawn clouds")}`);
    console.error(`  Full help:        ${pc.cyan("spawn help")}`);
    console.error();
    process.exit(1);
  }
}

function showVersion(): void {
  console.log(`spawn v${VERSION}`);
  const binPath = process.argv[1];
  if (binPath) {
    console.log(pc.dim(`  ${binPath}`));
  }
  console.log(pc.dim(`  ${process.versions.bun ? "bun" : "node"} ${process.versions.bun ?? process.versions.node}  ${process.platform} ${process.arch}`));
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
  "list": cmdList, "ls": cmdList,
  "agents": cmdAgents,
  "clouds": cmdClouds,
  "update": cmdUpdate,
};

/** Warn when extra positional arguments are silently ignored */
function warnExtraArgs(filteredArgs: string[], maxExpected: number): void {
  const extra = filteredArgs.slice(maxExpected);
  if (extra.length > 0) {
    console.error(pc.yellow(`Warning: extra argument${extra.length > 1 ? "s" : ""} ignored: ${extra.join(", ")}`));
    console.error(pc.dim(`  Usage: spawn <agent> <cloud> [--prompt "..."]`));
    console.error();
  }
}

/** Dispatch a named command or fall through to agent/cloud handling */
async function dispatchCommand(cmd: string, filteredArgs: string[], prompt: string | undefined): Promise<void> {
  if (IMMEDIATE_COMMANDS[cmd]) {
    warnExtraArgs(filteredArgs, 1);
    IMMEDIATE_COMMANDS[cmd]();
    return;
  }

  if (SUBCOMMANDS[cmd]) {
    const hasHelpFlag = filteredArgs.slice(1).some(a => HELP_FLAGS.includes(a));
    if (hasHelpFlag) {
      cmdHelp();
    } else {
      warnExtraArgs(filteredArgs, 1);
      await SUBCOMMANDS[cmd]();
    }
    return;
  }

  warnExtraArgs(filteredArgs, 2);
  await handleDefaultCommand(filteredArgs[0], filteredArgs[1], prompt);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  await checkForUpdates();

  const [prompt, filteredArgs] = await resolvePrompt(args);
  checkUnknownFlags(filteredArgs);

  const cmd = filteredArgs[0];

  try {
    if (!cmd) {
      await handleNoCommand(prompt);
    } else {
      await dispatchCommand(cmd, filteredArgs, prompt);
    }
  } catch (err) {
    handleError(err);
  }
}

main();

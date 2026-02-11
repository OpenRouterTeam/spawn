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
  findClosestMatch,
  resolveAgentKey,
  resolveCloudKey,
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
  if (err && typeof err === "object" && "message" in err) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(`Error: ${String(err)}`);
  }
  console.error(`\nRun 'spawn help' for usage information.`);
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
    console.error(`Error: ${args[idx]} requires a value`);
    console.error(`\nUsage: ${usageHint}`);
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
  const manifest = await loadManifest();
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

  // Fall back to fuzzy matching suggestions
  const agentMatch = findClosestMatch(name, agentKeys(manifest));
  const cloudMatch = findClosestMatch(name, cloudKeys(manifest));

  console.error(pc.red(`Unknown command: ${pc.bold(name)}`));
  console.error();
  if (agentMatch && cloudMatch) {
    console.error(`  Did you mean ${pc.cyan(agentMatch)} (agent) or ${pc.cyan(cloudMatch)} (cloud)?`);
  } else if (agentMatch) {
    console.error(`  Did you mean ${pc.cyan(agentMatch)} (agent)?`);
  } else if (cloudMatch) {
    console.error(`  Did you mean ${pc.cyan(cloudMatch)} (cloud)?`);
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
      console.error("Error: --prompt requires both <agent> and <cloud>");
      console.error(`\nUsage: spawn ${agent} <cloud> --prompt "your prompt here"`);

      // Try to suggest available clouds for the agent
      try {
        const manifest = await loadManifest();
        const resolvedAgent = resolveAgentKey(manifest, agent);
        if (resolvedAgent) {
          const clouds = cloudKeys(manifest).filter(
            (c: string) => manifest.matrix[`${c}/${resolvedAgent}`] === "implemented"
          );
          if (clouds.length > 0) {
            console.error(`\nAvailable clouds for ${resolvedAgent}:`);
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
    console.error("Error: --prompt and --prompt-file cannot be used together");
    console.error(`\nUse one or the other:`);
    console.error(`  spawn <agent> <cloud> --prompt "your prompt here"`);
    console.error(`  spawn <agent> <cloud> --prompt-file instructions.txt`);
    process.exit(1);
  }

  if (promptFile) {
    const { readFileSync } = await import("fs");
    try {
      prompt = readFileSync(promptFile, "utf-8");
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
      console.error(`Error reading prompt file '${promptFile}': ${msg}`);
      console.error(`\nMake sure the file exists and is readable.`);
      process.exit(1);
    }
  }

  return [prompt, filteredArgs];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for updates and auto-update if needed (blocking)
  await checkForUpdates();

  const [prompt, filteredArgs] = await resolvePrompt(args);

  // Check for unknown flags before dispatching commands
  checkUnknownFlags(filteredArgs);

  const cmd = filteredArgs[0];

  try {
    if (!cmd) {
      if (prompt) {
        console.error("Error: --prompt requires both <agent> and <cloud>");
        console.error(`\nUsage: spawn <agent> <cloud> --prompt "your prompt here"`);
        process.exit(1);
      }
      if (isInteractiveTTY()) {
        await cmdInteractive();
      } else {
        cmdHelp();
      }
      return;
    }

    // Commands that print immediately (no help flag override)
    const immediateCommands: Record<string, () => void> = {
      "help": cmdHelp, "--help": cmdHelp, "-h": cmdHelp,
      "version": () => console.log(`spawn v${VERSION}`),
      "--version": () => console.log(`spawn v${VERSION}`),
      "-v": () => console.log(`spawn v${VERSION}`),
      "-V": () => console.log(`spawn v${VERSION}`),
    };

    if (immediateCommands[cmd]) {
      immediateCommands[cmd]();
      return;
    }

    // Subcommands that show help when passed --help/-h
    const subcommands: Record<string, () => Promise<void>> = {
      "list": cmdList, "ls": cmdList,
      "agents": cmdAgents,
      "clouds": cmdClouds,
      "update": cmdUpdate,
    };

    const hasHelpFlag = filteredArgs.slice(1).some(a => HELP_FLAGS.includes(a));

    if (subcommands[cmd]) {
      if (hasHelpFlag) {
        cmdHelp();
      } else {
        await subcommands[cmd]();
      }
    } else {
      await handleDefaultCommand(filteredArgs[0], filteredArgs[1], prompt);
    }
  } catch (err) {
    handleError(err);
  }
}

main();

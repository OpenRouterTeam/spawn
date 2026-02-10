#!/usr/bin/env bun
import {
  cmdInteractive,
  cmdRun,
  cmdList,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdUpdate,
  cmdHelp,
} from "./commands.js";
import pkg from "../package.json" with { type: "json" };
import { checkForUpdates } from "./update-check.js";

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

async function handleDefaultCommand(agent: string, cloud: string | undefined, prompt?: string): Promise<void> {
  // Handle "spawn <agent> --help" / "spawn <agent> -h" / "spawn <agent> help"
  if (cloud && HELP_FLAGS.includes(cloud)) {
    await cmdAgentInfo(agent);
    return;
  }
  if (cloud) {
    await cmdRun(agent, cloud, prompt);
  } else {
    if (prompt) {
      console.error("Error: --prompt requires both <agent> and <cloud>");
      console.error(`\nUsage: spawn ${agent} <cloud> --prompt "your prompt here"`);
      process.exit(1);
    }
    await cmdAgentInfo(agent);
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

    // If second arg is --help/-h, show general help for known subcommands
    const hasHelpFlag = filteredArgs.slice(1).some(a => HELP_FLAGS.includes(a));

    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        cmdHelp();
        break;

      case "version":
      case "--version":
      case "-v":
      case "-V":
        console.log(`spawn v${VERSION}`);
        break;

      case "list":
      case "ls":
        if (hasHelpFlag) {
          cmdHelp();
        } else {
          await cmdList();
        }
        break;

      case "agents":
        if (hasHelpFlag) {
          cmdHelp();
        } else {
          await cmdAgents();
        }
        break;

      case "clouds":
        if (hasHelpFlag) {
          cmdHelp();
        } else {
          await cmdClouds();
        }
        break;

      case "update":
        if (hasHelpFlag) {
          cmdHelp();
        } else {
          await cmdUpdate();
        }
        break;

      default:
        await handleDefaultCommand(filteredArgs[0], filteredArgs[1], prompt);
        break;
    }
  } catch (err) {
    handleError(err);
  }
}

main();

#!/usr/bin/env bun
import {
  cmdInteractive,
  cmdRun,
  cmdList,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdImprove,
  cmdUpdate,
  cmdHelp,
} from "./commands.js";
import { loadManifest } from "./manifest.js";
import { VERSION } from "./version.js";

function isInteractiveTTY(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function handleError(err: unknown): never {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
}

async function handleDefaultCommand(agent: string, cloud: string | undefined, prompt?: string): Promise<void> {
  const manifest = await loadManifest();
  if (!manifest.agents[agent]) {
    console.error(`Error: Unknown agent "${agent}"`);
    console.error(`\nAvailable agents:`);
    const agentNames = Object.values(manifest.agents).map(a => a.name).slice(0, 5);
    agentNames.forEach(name => console.error(`  - ${name}`));
    if (Object.keys(manifest.agents).length > 5) {
      console.error(`  ... and ${Object.keys(manifest.agents).length - 5} more`);
    }
    console.error(`\nRun 'spawn agents' to see all agents.`);
    console.error(`Run 'spawn help' for complete usage.`);
    process.exit(1);
  }

  if (cloud) {
    await cmdRun(agent, cloud, prompt);
  } else {
    await cmdAgentInfo(agent);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Extract --prompt or -p flag
  let prompt: string | undefined;
  let filteredArgs = [...args];

  const promptIndex = args.findIndex(arg => arg === "--prompt" || arg === "-p");
  if (promptIndex !== -1 && args[promptIndex + 1]) {
    prompt = args[promptIndex + 1];
    // Remove --prompt and its value from args
    filteredArgs.splice(promptIndex, 2);
  }

  // Extract --prompt-file flag
  const promptFileIndex = args.findIndex(arg => arg === "--prompt-file");
  if (promptFileIndex !== -1 && args[promptFileIndex + 1]) {
    const { readFileSync } = await import("fs");
    try {
      prompt = readFileSync(args[promptFileIndex + 1], "utf-8");
      // Remove --prompt-file and its value from args
      filteredArgs.splice(promptFileIndex, 2);
    } catch (err) {
      console.error(`Error reading prompt file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const cmd = filteredArgs[0];

  try {
    if (!cmd) {
      if (isInteractiveTTY()) {
        await cmdInteractive();
      } else {
        cmdHelp();
      }
      return;
    }

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
        await cmdList();
        break;

      case "agents":
        await cmdAgents();
        break;

      case "clouds":
        await cmdClouds();
        break;

      case "improve":
        await cmdImprove(filteredArgs.slice(1));
        break;

      case "update":
        await cmdUpdate();
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

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

async function handleDefaultCommand(agent: string, cloud: string | undefined): Promise<void> {
  const manifest = await loadManifest();
  if (!manifest.agents[agent]) {
    console.error(`Unknown command or agent: ${agent}`);
    console.error(`Run 'spawn help' for usage.`);
    process.exit(1);
  }

  if (cloud) {
    await cmdRun(agent, cloud);
  } else {
    await cmdAgentInfo(agent);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

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
        await cmdImprove(args.slice(1));
        break;

      case "update":
        await cmdUpdate();
        break;

      default:
        await handleDefaultCommand(args[0], args[1]);
        break;
    }
  } catch (err) {
    handleError(err);
  }
}

main();

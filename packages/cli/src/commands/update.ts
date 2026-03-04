import * as p from "@clack/prompts";
import pc from "picocolors";
import { parseJsonWith } from "../shared/parse.js";
import { SPAWN_CDN, VERSION_URL, RAW_BASE } from "../manifest.js";
import { VERSION, PkgVersionSchema, getErrorMessage } from "./shared.js";

const INSTALL_CMD = `curl -fsSL ${SPAWN_CDN}/cli/install.sh | bash`;

async function fetchRemoteVersion(): Promise<string> {
  // Primary: plain-text version file from GitHub release artifact (static URL)
  try {
    const res = await fetch(VERSION_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && /^\d+\.\d+\.\d+/.test(text)) {
        return text;
      }
    }
  } catch {
    // Fall through to GitHub raw fallback
  }

  // Fallback: package.json from GitHub raw
  const res = await fetch(`${RAW_BASE}/packages/cli/package.json`, {
    signal: AbortSignal.timeout(10_000),
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

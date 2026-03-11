import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { RAW_BASE, SPAWN_CDN, VERSION_URL } from "../manifest.js";
import { parseJsonWith } from "../shared/parse.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { getErrorMessage, PkgVersionSchema, VERSION } from "./shared.js";

const INSTALL_URL = `${SPAWN_CDN}/cli/install.sh`;
const INSTALL_CMD = `curl --proto '=https' -fsSL ${INSTALL_URL} | bash`;

async function fetchRemoteVersion(): Promise<string> {
  // Primary: plain-text version file from GitHub release artifact (static URL)
  const primary = await asyncTryCatch(async () => {
    const res = await fetch(VERSION_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && /^\d+\.\d+\.\d+/.test(text)) {
        return text;
      }
    }
    return null;
  });
  if (primary.ok && primary.data) {
    return primary.data;
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
  const r = tryCatch(() => {
    // Two-step: fetch with --proto '=https', then execute via bash -c
    // Prevents protocol downgrade on hostile networks (matches update-check.ts pattern)
    const scriptContent = execFileSync(
      "curl",
      [
        "--proto",
        "=https",
        "-fsSL",
        INSTALL_URL,
      ],
      {
        encoding: "utf8",
        stdio: [
          "pipe",
          "pipe",
          "inherit",
        ],
      },
    );
    execFileSync(
      "bash",
      [
        "-c",
        scriptContent ?? "",
      ],
      {
        stdio: "inherit",
      },
    );
  });
  if (r.ok) {
    console.log();
    p.log.success("Updated successfully!");
    p.log.info("Run spawn again to use the new version.");
  } else {
    p.log.error("Auto-update failed. Update manually:");
    console.log();
    console.log(`  ${pc.cyan(INSTALL_CMD)}`);
    console.log();
  }
}

export async function cmdUpdate(): Promise<void> {
  const s = p.spinner();
  s.start("Checking for updates...");

  const r = await asyncTryCatch(() => fetchRemoteVersion());
  if (!r.ok) {
    s.stop(pc.red("Failed to check for updates") + pc.dim(` (current: v${VERSION})`));
    console.error("Error:", getErrorMessage(r.error));
    console.error("\nHow to fix:");
    console.error("  1. Check your internet connection");
    console.error("  2. Try again in a few moments");
    console.error(`  3. Update manually: ${pc.cyan(INSTALL_CMD)}`);
    return;
  }

  const remoteVersion = r.data;
  if (remoteVersion === VERSION) {
    s.stop(`Already up to date ${pc.dim(`(v${VERSION})`)}`);
    return;
  }

  s.stop(`Updating: v${VERSION} -> v${remoteVersion}`);
  await performUpdate(remoteVersion);
}

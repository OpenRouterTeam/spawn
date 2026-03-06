// shared/agent-tarball.ts — Pre-built tarball install for agents
// Downloads a nightly tarball from GitHub Releases and extracts it on the remote VM.
// Falls back gracefully (returns false) on any failure so the caller can use live install.

import * as v from "valibot";
import type { CloudRunner } from "./agent-setup";
import { logInfo, logStep, logWarn } from "./ui";

const REPO = "OpenRouterTeam/spawn";

/** Schema for a single GitHub Release asset. */
const AssetSchema = v.object({
  name: v.string(),
  browser_download_url: v.string(),
});

/** Schema for the GitHub Release response (only the fields we need). */
const ReleaseSchema = v.object({
  assets: v.array(AssetSchema),
});

/**
 * Try to install an agent from a pre-built tarball on GitHub Releases.
 * Returns `true` on success, `false` on any failure (caller should fall back).
 */
export async function tryTarballInstall(runner: CloudRunner, agentName: string): Promise<boolean> {
  const tag = `agent-${agentName}-latest`;
  logStep(`Checking for pre-built tarball (${tag})...`);

  try {
    // Query GitHub Releases API for the rolling release tag
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      logWarn("No pre-built tarball available");
      return false;
    }

    const json: unknown = await resp.json();
    const parsed = v.safeParse(ReleaseSchema, json);
    if (!parsed.success) {
      logWarn("Tarball release has unexpected format");
      return false;
    }

    // Find the .tar.gz asset
    const asset = parsed.output.assets.find((a) => a.name.endsWith(".tar.gz"));
    if (!asset) {
      logWarn("No tarball asset found in release");
      return false;
    }

    const url = asset.browser_download_url;

    // SECURITY: Validate URL matches expected GitHub releases pattern.
    // Prevents shell injection via crafted API responses.
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^\s'"`;|&$()]+$/.test(url)) {
      logWarn("Tarball URL failed safety validation");
      return false;
    }

    logStep("Downloading pre-built agent tarball...");

    // Download and extract on the remote VM
    // --connect-timeout 10s, --max-time 120s, -L to follow redirects (GitHub releases redirect)
    await runner.runServer(
      `curl -fsSL --connect-timeout 10 --max-time 120 '${url}' | tar xz -C / && [ -f /root/.spawn-tarball ]`,
      150, // 2.5 min total timeout for the SSH command
    );

    logInfo("Agent installed from pre-built tarball");
    return true;
  } catch {
    logWarn("Tarball install failed, falling back to live install");
    return false;
  }
}

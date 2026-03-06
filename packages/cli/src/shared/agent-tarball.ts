// shared/agent-tarball.ts — Pre-built tarball install for agents
// Downloads a nightly tarball from GitHub Releases and extracts it on the remote VM.
// Falls back gracefully (returns false) on any failure so the caller can use live install.

import type { CloudRunner } from "./agent-setup";

import * as v from "valibot";
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
 * @param fetchFn - Optional fetch override (used by tests).
 */
export async function tryTarballInstall(
  runner: CloudRunner,
  agentName: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const tag = `agent-${agentName}-latest`;
  logStep(`Checking for pre-built tarball (${tag})...`);

  try {
    // Query GitHub Releases API for the rolling release tag
    const resp = await fetchFn(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
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

    // Find both arch-specific .tar.gz assets and let the remote VM pick the right one.
    // We try x86_64 first (most common), and include arm64 fallback in the remote script.
    const x86Asset = parsed.output.assets.find((a) => a.name.includes("-x86_64-") && a.name.endsWith(".tar.gz"));
    const armAsset = parsed.output.assets.find((a) => a.name.includes("-arm64-") && a.name.endsWith(".tar.gz"));

    if (!x86Asset && !armAsset) {
      logWarn("No tarball asset found in release");
      return false;
    }

    // Build arch-aware download: remote VM detects its own arch and picks the right URL
    const x86Url = x86Asset?.browser_download_url || "";
    const armUrl = armAsset?.browser_download_url || "";
    const url = x86Url || armUrl;

    // SECURITY: Validate URLs match expected GitHub releases pattern.
    // Prevents shell injection via crafted API responses.
    const urlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^\s'"`;|&$()]+$/;
    if ((x86Url && !urlPattern.test(x86Url)) || (armUrl && !urlPattern.test(armUrl))) {
      logWarn("Tarball URL failed safety validation");
      return false;
    }

    logStep("Downloading pre-built agent tarball...");

    // Build arch-aware download command: remote VM picks the right URL based on uname -m
    let downloadCmd: string;
    if (x86Url && armUrl) {
      downloadCmd =
        "_arch=$(uname -m); " +
        `if [ "$_arch" = "aarch64" ] || [ "$_arch" = "arm64" ]; then ` +
        `_url='${armUrl}'; else _url='${x86Url}'; fi; ` +
        `curl -fsSL --connect-timeout 10 --max-time 120 "$_url" | tar xz -C / && [ -f /root/.spawn-tarball ]`;
    } else {
      downloadCmd = `curl -fsSL --connect-timeout 10 --max-time 120 '${url}' | tar xz -C / && [ -f /root/.spawn-tarball ]`;
    }

    // Download and extract on the remote VM
    await runner.runServer(downloadCmd, 150);

    logInfo("Agent installed from pre-built tarball");
    return true;
  } catch {
    logWarn("Tarball install failed, falling back to live install");
    return false;
  }
}

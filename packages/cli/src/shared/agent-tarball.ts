// shared/agent-tarball.ts — Pre-built tarball install for agents
// Downloads a nightly tarball from GitHub Releases and extracts it on the remote VM.
// Falls back gracefully (returns false) on any failure so the caller can use live install.

import type { CloudRunner } from "./agent-setup.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { asyncTryCatch } from "./result.js";
import { logDebug, logInfo, logStep, logWarn } from "./ui.js";

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

  // Phase 1: Fetch + parse tarball metadata
  const metaResult = await asyncTryCatch(async () => {
    // Query GitHub Releases API for the rolling release tag
    const resp = await fetchFn(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      logWarn("No pre-built tarball available");
      return null;
    }

    const json: unknown = await resp.json();
    const parsed = v.safeParse(ReleaseSchema, json);
    if (!parsed.success) {
      logWarn("Tarball release has unexpected format");
      return null;
    }

    // Find both arch-specific .tar.gz assets and let the remote VM pick the right one.
    // We try x86_64 first (most common), and include arm64 fallback in the remote script.
    const x86Asset = parsed.output.assets.find((a) => a.name.includes("-x86_64-") && a.name.endsWith(".tar.gz"));
    const armAsset = parsed.output.assets.find((a) => a.name.includes("-arm64-") && a.name.endsWith(".tar.gz"));

    if (!x86Asset && !armAsset) {
      logWarn("No tarball asset found in release");
      return null;
    }

    return {
      x86Url: x86Asset?.browser_download_url || "",
      armUrl: armAsset?.browser_download_url || "",
      url: x86Asset?.browser_download_url || armAsset?.browser_download_url || "",
    };
  });
  if (!metaResult.ok) {
    logWarn("Failed to fetch pre-built tarball metadata");
    logDebug(getErrorMessage(metaResult.error));
    return false;
  }
  if (!metaResult.data) {
    return false;
  }
  const { x86Url, armUrl, url } = metaResult.data;

  // Phase 2: URL validation + command building (deterministic — no try/catch needed)
  // SECURITY: Validate URLs match expected GitHub releases pattern.
  // Prevents shell injection via crafted API responses.
  const urlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^\s'"`;|&$()]+$/;
  if ((x86Url && !urlPattern.test(x86Url)) || (armUrl && !urlPattern.test(armUrl))) {
    logWarn("Tarball URL failed safety validation");
    return false;
  }

  logStep("Downloading pre-built agent tarball...");

  // Build arch-aware download command: remote VM picks the right URL based on uname -m
  //
  // Tarballs are built with absolute /root/ paths. Two strategies:
  // - Root user: extract directly to / (fast, no transform needed)
  // - Non-root user: use tar --transform to remap /root/ to $HOME/ during extraction.
  //   This avoids needing sudo entirely (Sprite VMs don't have it).
  //   Falls back to sudo-based extraction for clouds with passwordless sudo (AWS, GCP).
  //
  // After non-root extraction we also have to rewrite SYMLINK TARGETS — tar's
  // --transform only rewrites file names, not the absolute paths stored inside
  // symlinks. Without this, the agent's binary symlinks (e.g.
  // ~/.local/bin/claude -> /root/.claude/local/claude) extract as dangling
  // links and `claude` shows up as "command not found" on PATH.
  const fixSymlinks = [
    'find "$HOME" -type l 2>/dev/null | while IFS= read -r _l; do',
    '  _t=$(readlink "$_l" 2>/dev/null) || continue',
    '  case "$_t" in',
    '    /root/*) ln -snf "$HOME${_t#/root}" "$_l" 2>/dev/null ;;',
    "  esac",
    "done",
    "true",
  ].join(" ");

  const extractCmd = [
    'if [ "$(id -u)" = "0" ]; then',
    "  tar xz -C /",
    "else",
    // Try transform first (no sudo needed) — remap /root/ paths to $HOME/,
    // then walk $HOME and rewrite any leftover absolute /root/ symlinks.
    `  { tar xz --transform "s|^root/|\${HOME#/}/|" -C / 2>/dev/null && { ${fixSymlinks}; }; } ||`,
    // Fallback: sudo extract + mirror (for clouds with passwordless sudo)
    "  sudo tar xz -C / 2>/dev/null",
    "fi",
  ].join("\n");

  // Arch detection + URL selection + download + extract + verify marker
  const markerCheck = [
    "if [ -f /root/.spawn-tarball ]; then true",
    'elif [ -f "$HOME/.spawn-tarball" ]; then true',
    "else false; fi",
  ].join("; ");

  let downloadCmd: string;
  if (x86Url && armUrl) {
    downloadCmd =
      "_arch=$(uname -m); " +
      `if [ "$_arch" = "aarch64" ] || [ "$_arch" = "arm64" ]; then ` +
      `_url='${armUrl}'; else _url='${x86Url}'; fi; ` +
      `curl -fsSL --connect-timeout 10 --max-time 120 "$_url" | (${extractCmd}) && (${markerCheck})`;
  } else {
    const isArm = !!armUrl;
    const archGuard = isArm
      ? '_arch=$(uname -m); if [ "$_arch" != "aarch64" ] && [ "$_arch" != "arm64" ]; then echo "Tarball is arm64 but VM is $_arch" >&2; exit 1; fi; '
      : '_arch=$(uname -m); if [ "$_arch" = "aarch64" ] || [ "$_arch" = "arm64" ]; then echo "Tarball is x86_64 but VM is $_arch" >&2; exit 1; fi; ';
    downloadCmd = `${archGuard}curl -fsSL --connect-timeout 10 --max-time 120 '${url}' | (${extractCmd}) && (${markerCheck})`;
  }

  // Phase 3: Remote execution — catch-all because any failure means "fall back to live install"
  const extractResult = await asyncTryCatch(() => runner.runServer(downloadCmd, 150));
  if (!extractResult.ok) {
    logWarn("Tarball download/extract failed on remote VM");
    logDebug(getErrorMessage(extractResult.error));
    return false;
  }

  logInfo("Agent installed from pre-built tarball");
  return true;
}

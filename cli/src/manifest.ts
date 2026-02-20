import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentDef {
  name: string;
  description: string;
  url: string;
  install: string;
  launch: string;
  env: Record<string, string>;
  pre_launch?: string;
  deps?: string[];
  config_files?: Record<string, unknown>;
  interactive_prompts?: Record<string, { prompt: string; default: string }>;
  dotenv?: { path: string; values: Record<string, string> };
  notes?: string;
  icon?: string;
  featured_cloud?: string[];
  creator?: string;
  repo?: string;
  license?: string;
  created?: string;
  added?: string;
  github_stars?: number;
  stars_updated?: string;
  language?: string;
  runtime?: string;
  category?: string;
  tagline?: string;
  tags?: string[];
}

export interface CloudDef {
  name: string;
  description: string;
  url: string;
  type: string;
  auth: string;
  provision_method: string;
  exec_method: string;
  interactive_method: string;
  defaults?: Record<string, unknown>;
  notes?: string;
  icon?: string;
}

export interface Manifest {
  agents: Record<string, AgentDef>;
  clouds: Record<string, CloudDef>;
  matrix: Record<string, string>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const REPO = "OpenRouterTeam/spawn";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
// Dynamic getters so tests can override XDG_CACHE_HOME at runtime
function getCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "spawn");
}
function getCacheFile(): string {
  return join(getCacheDir(), "manifest.json");
}
// Backward-compatible export (evaluated at import time)
const CACHE_DIR = getCacheDir();
const CACHE_TTL = 3600; // 1 hour in seconds
const FETCH_TIMEOUT = 10_000; // 10 seconds

// ── Cache helpers ──────────────────────────────────────────────────────────────

function cacheAge(): number {
  try {
    const st: ReturnType<typeof statSync> = statSync(getCacheFile());
    return (Date.now() - st.mtimeMs) / 1000;
  } catch (err) {
    // Cache file doesn't exist or is inaccessible - treat as infinitely old
    return Infinity;
  }
}

function logError(message: string, err?: unknown): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  console.error(err ? `${message}: ${errMsg}` : message);
}

function readCache(): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(getCacheFile(), "utf-8"));
    return stripDangerousKeys(raw) as Manifest;
  } catch (err) {
    // Cache file missing, corrupted, or unreadable
    logError(`Failed to read cache from ${getCacheFile()}`, err);
    return null;
  }
}

function isTestEnv(): boolean {
  return !!(process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test");
}

function writeCache(data: Manifest): void {
  // In test environments, only write to disk if XDG_CACHE_HOME is set (i.e.,
  // the test has opted into an isolated cache dir). This prevents test fixtures
  // from leaking into the real ~/.cache/spawn/manifest.json.
  if (isTestEnv() && !process.env.XDG_CACHE_HOME) {
    return;
  }
  mkdirSync(getCacheDir(), { recursive: true });
  writeFileSync(getCacheFile(), JSON.stringify(data, null, 2), "utf-8");
}

// ── Fetching ───────────────────────────────────────────────────────────────────

/** Recursively strip __proto__, constructor, and prototype keys from parsed JSON
 *  to prevent prototype pollution attacks (defense in depth). */
function stripDangerousKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripDangerousKeys);
  const clean: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    clean[key] = stripDangerousKeys(obj[key]);
  }
  return clean;
}

function isValidManifest(data: any): data is Manifest {
  return data && typeof data === "object" && !Array.isArray(data) &&
    data.agents && data.clouds && data.matrix;
}

async function fetchManifestFromGitHub(): Promise<Manifest | null> {
  try {
    const res = await fetch(`${RAW_BASE}/manifest.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) {
      logError(`Failed to fetch manifest from GitHub: HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const raw = await res.json();
    const data = stripDangerousKeys(raw) as Manifest;
    if (!isValidManifest(data)) {
      logError("Manifest structure validation failed: missing required fields (agents, clouds, or matrix)");
      return null;
    }
    return data;
  } catch (err) {
    logError("Network error fetching manifest", err);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

let _cached: Manifest | null = null;
let _staleCache = false;

function tryLoadFromDiskCache(): Manifest | null {
  if (cacheAge() >= CACHE_TTL) return null;
  return readCache();
}

function updateCache(manifest: Manifest): Manifest {
  writeCache(manifest);
  _cached = manifest;
  return manifest;
}

function tryLoadLocalManifest(): Manifest | null {
  // Skip local manifest in test environment
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return null;
  }

  try {
    // Try loading manifest.json from current directory (development mode)
    const localPath = join(process.cwd(), "manifest.json");
    if (existsSync(localPath)) {
      const raw = JSON.parse(readFileSync(localPath, "utf-8"));
      const data = stripDangerousKeys(raw);
      if (isValidManifest(data)) {
        return data as Manifest;
      }
    }
  } catch (err) {
    // Local manifest not found or invalid - not an error, just continue
  }
  return null;
}

export async function loadManifest(forceRefresh = false): Promise<Manifest> {
  // Return in-memory cache if available and not forcing refresh
  if (_cached && !forceRefresh) return _cached;

  // Try local manifest first (for development/testing, but not in test environment)
  const local = tryLoadLocalManifest();
  if (local) {
    _cached = local;
    return local;
  }

  // Check disk cache first if not forcing refresh
  if (!forceRefresh) {
    const cached = tryLoadFromDiskCache();
    if (cached) {
      _cached = cached;
      return cached;
    }
  }

  // Fetch from GitHub
  const fetched = await fetchManifestFromGitHub();
  if (fetched) {
    return updateCache(fetched);
  }

  // Offline fallback: use stale cache
  const stale = readCache();
  if (stale) {
    _cached = stale;
    _staleCache = true;
    return stale;
  }

  throw new Error(
    `Cannot load manifest: failed to fetch from GitHub and no local cache available.\n` +
    `\n` +
    `How to fix:\n` +
    `  1. Check your internet connection\n` +
    `  2. Try again in a few moments (GitHub may be temporarily unreachable)\n` +
    `  3. If the problem persists, clear the cache and retry:\n` +
    `     rm -rf ${getCacheDir()}`
  );
}

export function agentKeys(m: Manifest): string[] {
  return Object.keys(m.agents);
}

export function cloudKeys(m: Manifest): string[] {
  return Object.keys(m.clouds);
}

export function matrixStatus(m: Manifest, cloud: string, agent: string): string {
  return m.matrix[`${cloud}/${agent}`] ?? "missing";
}

export function countImplemented(m: Manifest): number {
  let count = 0;
  for (const value of Object.values(m.matrix)) {
    if (value === "implemented") {
      count++;
    }
  }
  return count;
}

/** Returns true if the manifest was loaded from a stale (expired) cache as offline fallback */
export function isStaleCache(): boolean {
  return _staleCache;
}

/** Returns the age of the disk cache in seconds, or Infinity if not available */
export function getCacheAge(): number {
  return cacheAge();
}

/** Clear the in-memory manifest cache (for testing only) */
export function _resetCacheForTesting(): void {
  _cached = null;
  _staleCache = false;
}

export { RAW_BASE, REPO, CACHE_DIR, stripDangerousKeys };

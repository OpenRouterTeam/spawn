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
}

export interface Manifest {
  agents: Record<string, AgentDef>;
  clouds: Record<string, CloudDef>;
  matrix: Record<string, string>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const REPO = "OpenRouterTeam/spawn";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "spawn");
const CACHE_FILE = join(CACHE_DIR, "manifest.json");
const CACHE_TTL = 3600; // 1 hour in seconds
const FETCH_TIMEOUT = 10_000; // 10 seconds

// ── Cache helpers ──────────────────────────────────────────────────────────────

function cacheAge(): number {
  try {
    const st = statSync(CACHE_FILE);
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
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch (err) {
    // Cache file missing, corrupted, or unreadable
    logError(`Failed to read cache from ${CACHE_FILE}`, err);
    return null;
  }
}

function writeCache(data: Manifest): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// ── Fetching ───────────────────────────────────────────────────────────────────

function isValidManifest(data: any): data is Manifest {
  return data && data.agents && data.clouds && data.matrix;
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
    const data = (await res.json()) as Manifest;
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

export async function loadManifest(forceRefresh = false): Promise<Manifest> {
  // Return in-memory cache if available and not forcing refresh
  if (_cached && !forceRefresh) return _cached;

  // Check disk cache first if not forcing refresh
  if (!forceRefresh && cacheAge() < CACHE_TTL) {
    const cached = readCache();
    if (cached) {
      _cached = cached;
      return cached;
    }
  }

  // Fetch from GitHub
  const fetched = await fetchManifestFromGitHub();
  if (fetched) {
    writeCache(fetched);
    _cached = fetched;
    return fetched;
  }

  // Offline fallback: use stale cache
  const stale = readCache();
  if (stale) {
    _cached = stale;
    return stale;
  }

  throw new Error("Cannot load manifest. Check your internet connection.");
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
  return Object.values(m.matrix).filter((v) => v === "implemented").length;
}

export { RAW_BASE, REPO, CACHE_DIR };

// shared/ssh-keys.ts — SSH key discovery, selection, and generation

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logInfo, logStep } from "./ui";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SshKeyPair {
  privPath: string;
  pubPath: string;
  /** Base name, e.g. "id_ed25519" or "work_key" */
  name: string;
  /** Key algorithm, e.g. "ED25519", "RSA" */
  type: string;
}

// ─── Module-level cache ─────────────────────────────────────────────────────

let cachedKeys: SshKeyPair[] | null = null;

/** Reset the module-level cache (for testing). */
export function _resetCache(): void {
  cachedKeys = null;
}

// ─── Key Discovery ──────────────────────────────────────────────────────────

/** Scan ~/.ssh/ for valid key pairs and extract key types. */
export function discoverSshKeys(): SshKeyPair[] {
  const sshDir = join(process.env.HOME || homedir(), ".ssh");
  if (!existsSync(sshDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(sshDir);
  } catch {
    return [];
  }

  const pubFiles = entries.filter((f) => f.endsWith(".pub"));
  const pairs: SshKeyPair[] = [];

  for (const pubFile of pubFiles) {
    const baseName = pubFile.slice(0, -4); // strip ".pub"
    const pubPath = `${sshDir}/${pubFile}`;
    const privPath = `${sshDir}/${baseName}`;

    if (!existsSync(privPath)) {
      continue;
    }

    // Extract key type via ssh-keygen
    const keyType = getKeyType(pubPath);
    pairs.push({
      privPath,
      pubPath,
      name: baseName,
      type: keyType,
    });
  }

  // Sort: ed25519 first, then rsa, then others; alphabetical within each group
  pairs.sort((a, b) => {
    const order = (t: string) => {
      const upper = t.toUpperCase();
      if (upper.includes("ED25519")) {
        return 0;
      }
      if (upper.includes("RSA")) {
        return 1;
      }
      return 2;
    };
    const diff = order(a.type) - order(b.type);
    if (diff !== 0) {
      return diff;
    }
    return a.name.localeCompare(b.name);
  });

  return pairs;
}

/** Extract the key type from a public key file using ssh-keygen. */
function getKeyType(pubPath: string): string {
  try {
    const result = Bun.spawnSync(
      [
        "ssh-keygen",
        "-lf",
        pubPath,
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    // Format: "256 SHA256:xxx user@host (ED25519)"
    const match = output.match(/\(([^)]+)\)$/);
    return match ? match[1] : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

// ─── Key Generation ─────────────────────────────────────────────────────────

/** Generate a new ed25519 key at ~/.ssh/id_ed25519. Returns the pair. */
export function generateSshKey(): SshKeyPair {
  const sshDir = join(process.env.HOME || homedir(), ".ssh");
  const privPath = `${sshDir}/id_ed25519`;
  const pubPath = `${privPath}.pub`;

  mkdirSync(sshDir, {
    recursive: true,
    mode: 0o700,
  });

  // If the key already exists (e.g. another concurrent process generated it),
  // reuse it instead of failing. ssh-keygen prompts for overwrite on stdin,
  // which fails when stdin is "ignore".
  if (existsSync(privPath) && existsSync(pubPath)) {
    logInfo("SSH key already exists, reusing");
    const keyType = getKeyType(pubPath);
    return {
      privPath,
      pubPath,
      name: "id_ed25519",
      type: keyType,
    };
  }

  logStep("Generating SSH key...");
  const result = Bun.spawnSync(
    [
      "ssh-keygen",
      "-t",
      "ed25519",
      "-f",
      privPath,
      "-N",
      "",
      "-C",
      "spawn",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  if (result.exitCode !== 0) {
    // Another process may have created the key between our check and ssh-keygen.
    // Re-check before throwing.
    if (existsSync(privPath) && existsSync(pubPath)) {
      logInfo("SSH key created by another process, reusing");
      const keyType = getKeyType(pubPath);
      return {
        privPath,
        pubPath,
        name: "id_ed25519",
        type: keyType,
      };
    }
    throw new Error("SSH key generation failed");
  }
  logInfo("SSH key generated");

  return {
    privPath,
    pubPath,
    name: "id_ed25519",
    type: "ED25519",
  };
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

/** Get the MD5 fingerprint of a public key (for cloud provider matching). */
export function getSshFingerprint(pubPath: string): string {
  const result = Bun.spawnSync(
    [
      "ssh-keygen",
      "-lf",
      pubPath,
      "-E",
      "md5",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const output = new TextDecoder().decode(result.stdout).trim();
  // Format: "2048 MD5:xx:xx:xx... user@host (ED25519)"
  const match = output.match(/MD5:([a-f0-9:]+)/i);
  return match ? match[1] : "";
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Discover, generate, or use all SSH keys automatically.
 *
 * - 0 keys found → generate one, return [generatedKey]
 * - 1+ keys found → use all silently (ed25519 preferred, sorted first)
 *
 * Results are cached at module level so subsequent calls return instantly.
 */
export async function ensureSshKeys(): Promise<SshKeyPair[]> {
  if (cachedKeys) {
    return cachedKeys;
  }

  const discovered = discoverSshKeys();

  if (discovered.length === 0) {
    const generated = generateSshKey();
    cachedKeys = [
      generated,
    ];
    return cachedKeys;
  }

  logInfo(`Using ${discovered.length} SSH key(s)`);
  cachedKeys = discovered;
  return cachedKeys;
}

// ─── SSH Opts Helper ────────────────────────────────────────────────────────

/**
 * Build SSH identity file options for all selected keys.
 * Returns ["-i", path1, "-i", path2, ...].
 */
export function getSshKeyOpts(keys: SshKeyPair[]): string[] {
  const opts: string[] = [];
  for (const key of keys) {
    opts.push("-i", key.privPath);
  }
  return opts;
}

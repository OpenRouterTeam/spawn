// shared/ssh-keys.ts — Spawn-owned SSH key with legacy fallback for back-compat

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import * as v from "valibot";
import { parseJsonObj } from "./parse.js";
import { getSpawnPreferencesPath, getSshDir } from "./paths.js";
import { isFileError, tryCatch, tryCatchIf, unwrapOr } from "./result.js";
import { logInfo, logStep, logWarn } from "./ui.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SshKeyPair {
  privPath: string;
  pubPath: string;
  /** Base name, e.g. "spawn_ed25519" or "id_rsa" */
  name: string;
  /** Key algorithm, e.g. "ED25519", "RSA" */
  type: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Filename of the spawn-managed key under ~/.ssh/. */
export const SPAWN_KEY_NAME = "spawn_ed25519";

/** Default key filenames OpenSSH auto-tries; used as legacy -i fallbacks
 * so droplets provisioned by older Spawn versions stay reachable. */
const LEGACY_KEY_NAMES = [
  "id_ed25519",
  "id_rsa",
  "id_ecdsa",
];

/** Cap the total number of -i flags to stay under a typical sshd MaxAuthTries. */
const MAX_KEYS = 3;

// ─── Module-level cache ─────────────────────────────────────────────────────

let cachedSpawnKey: SshKeyPair | null = null;
let cachedKeys: SshKeyPair[] | null = null;

/** Reset the module-level cache (for testing). */
export function _resetCache(): void {
  cachedSpawnKey = null;
  cachedKeys = null;
}

// ─── Pubkey helpers ─────────────────────────────────────────────────────────

/**
 * Read the first two whitespace-separated fields ("type base64") from an OpenSSH
 * public key string, ignoring trailing comment. Returns "" if the input is empty
 * or malformed.
 */
function pubKeyCore(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return "";
  }
  return `${parts[0]} ${parts[1]}`;
}

/**
 * Derive the public key text from a private key via `ssh-keygen -y`.
 * Returns the raw stdout (e.g. `"ssh-ed25519 AAAA... comment\n"`) on success,
 * or "" when the private key is passphrase-protected, corrupt, or missing.
 */
function derivePubFromPriv(privPath: string): string {
  return unwrapOr(
    tryCatch(() => {
      const result = Bun.spawnSync(
        [
          "ssh-keygen",
          "-y",
          "-P",
          "",
          "-f",
          privPath,
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
        return "";
      }
      return new TextDecoder().decode(result.stdout);
    }),
    "",
  );
}

/**
 * Verify that a private/public keypair on disk are actually paired:
 * derive the public key from the private key and compare to the `.pub`.
 *
 * Returns:
 *   - "match"        — derived public matches `.pub`
 *   - "mismatch"     — files exist but do NOT pair (silent-failure source)
 *   - "unverifiable" — passphrase-protected, corrupt, or otherwise can't derive
 */
export function verifyKeyPair(privPath: string, pubPath: string): "match" | "mismatch" | "unverifiable" {
  const derivedCore = pubKeyCore(derivePubFromPriv(privPath));
  if (!derivedCore) {
    return "unverifiable";
  }

  const pubText = unwrapOr(
    tryCatchIf(isFileError, () => readFileSync(pubPath, "utf-8")),
    "",
  );
  const pubCore = pubKeyCore(pubText);
  if (!pubCore) {
    return "unverifiable";
  }

  return derivedCore === pubCore ? "match" : "mismatch";
}

/**
 * Repair a stale `.pub` file by rewriting it from the matching private key.
 *
 * The original `.pub` is preserved as `<pubPath>.spawn-backup-<timestamp>` so
 * the user can inspect what was replaced. Returns the backup path on success,
 * or null if the private key couldn't be read or the filesystem write failed.
 */
export function repairPubFromPriv(privPath: string, pubPath: string): string | null {
  const derived = derivePubFromPriv(privPath);
  if (!pubKeyCore(derived)) {
    return null;
  }

  const backupPath = `${pubPath}.spawn-backup-${Date.now()}`;
  const result = tryCatchIf(isFileError, () => {
    renameSync(pubPath, backupPath);
    writeFileSync(pubPath, derived, {
      mode: 0o644,
    });
  });
  if (!result.ok) {
    return null;
  }
  return backupPath;
}

/** Extract the key type from a public key file using ssh-keygen. */
function getKeyType(pubPath: string): string {
  return unwrapOr(
    tryCatch(() => {
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
    }),
    "UNKNOWN",
  );
}

/** Get the MD5 fingerprint of a public key (for cloud provider matching). */
export function getSshFingerprint(pubPath: string): string {
  return unwrapOr(
    tryCatch(() => {
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
    }),
    "",
  );
}

// ─── Spawn Key Management ───────────────────────────────────────────────────

/**
 * Ensure the spawn-managed ed25519 key exists at ~/.ssh/spawn_ed25519 and
 * return it. Generated on first use, then cached. The custom filename avoids
 * clobbering the user's personal `id_ed25519` and keeps Spawn's key isolated
 * from the rest of their SSH setup.
 */
export function getSpawnKey(): SshKeyPair {
  if (cachedSpawnKey) {
    return cachedSpawnKey;
  }

  const sshDir = getSshDir();
  const privPath = `${sshDir}/${SPAWN_KEY_NAME}`;
  const pubPath = `${privPath}.pub`;

  mkdirSync(sshDir, {
    recursive: true,
    mode: 0o700,
  });

  if (existsSync(privPath) && existsSync(pubPath)) {
    cachedSpawnKey = {
      privPath,
      pubPath,
      name: SPAWN_KEY_NAME,
      type: getKeyType(pubPath),
    };
    return cachedSpawnKey;
  }

  logStep("Generating Spawn SSH key...");
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
    // Race: another process may have created the key between our check and ssh-keygen.
    if (existsSync(privPath) && existsSync(pubPath)) {
      cachedSpawnKey = {
        privPath,
        pubPath,
        name: SPAWN_KEY_NAME,
        type: getKeyType(pubPath),
      };
      return cachedSpawnKey;
    }
    throw new Error("Spawn SSH key generation failed");
  }
  logInfo(`Spawn SSH key generated at ~/.ssh/${SPAWN_KEY_NAME}`);

  cachedSpawnKey = {
    privPath,
    pubPath,
    name: SPAWN_KEY_NAME,
    type: "ED25519",
  };
  return cachedSpawnKey;
}

/**
 * Discover pre-existing default-named keys (id_ed25519, id_rsa, id_ecdsa) in
 * ~/.ssh/, excluding the spawn-managed key. Used as -i fallbacks so droplets
 * provisioned by older Spawn versions (which registered the user's personal
 * keys with the cloud account) remain SSH-reachable.
 *
 * Stale .pub files are auto-repaired against their .priv (the .priv is
 * authoritative; a non-derivable .pub is wrong by definition). Passphrase-
 * protected and unverifiable pairs are skipped silently — BatchMode SSH can't
 * use those without an active ssh-agent anyway.
 */
export function discoverLegacyKeys(): SshKeyPair[] {
  const sshDir = getSshDir();
  if (!existsSync(sshDir)) {
    return [];
  }

  const pairs: SshKeyPair[] = [];
  for (const baseName of LEGACY_KEY_NAMES) {
    if (baseName === SPAWN_KEY_NAME) {
      continue;
    }
    const privPath = `${sshDir}/${baseName}`;
    const pubPath = `${privPath}.pub`;
    if (!existsSync(privPath) || !existsSync(pubPath)) {
      continue;
    }

    const verification = verifyKeyPair(privPath, pubPath);
    if (verification === "mismatch") {
      const repaired = repairPubFromPriv(privPath, pubPath);
      if (!repaired) {
        continue;
      }
    } else if (verification === "unverifiable") {
      continue;
    }

    pairs.push({
      privPath,
      pubPath,
      name: baseName,
      type: getKeyType(pubPath),
    });
  }
  return pairs;
}

// ─── Saved-preference helpers ───────────────────────────────────────────────

/**
 * Subset of `~/.config/spawn/preferences.json` we care about here. Other
 * fields (`models`, `starPromptShownAt`, etc.) are owned by other modules
 * and must round-trip untouched, so reads use a tolerant schema and writes
 * merge into the existing object.
 */
const SshPreferencesSchema = v.object({
  sshKeyPath: v.optional(v.string()),
});

/**
 * Read the user's saved preferred SSH private-key path, if any.
 *
 * Returns `null` when the preferences file is missing, malformed, has no
 * `sshKeyPath` field, or points at a path that no longer exists. The
 * "still exists" check is important: stale references to deleted keys
 * would otherwise short-circuit `ensureSshKeys()` and break every spawn
 * run until the user notices and edits the file.
 */
export function getPreferredSshKeyPath(): string | null {
  const prefsPath = getSpawnPreferencesPath();
  if (!existsSync(prefsPath)) {
    return null;
  }
  const parsed = tryCatch(() => {
    const raw = parseJsonObj(readFileSync(prefsPath, "utf-8"));
    if (!raw) {
      return null;
    }
    const result = v.safeParse(SshPreferencesSchema, raw);
    if (!result.success) {
      return null;
    }
    return result.output.sshKeyPath ?? null;
  });
  if (!parsed.ok || !parsed.data) {
    return null;
  }
  // Drop the saved value if the file no longer exists — better to fall
  // through to discovery than to fail with a stale reference.
  if (!existsSync(parsed.data)) {
    return null;
  }
  return parsed.data;
}

/**
 * Persist the user's chosen SSH private-key path so subsequent spawn runs
 * use it directly. Other fields in `preferences.json` are preserved.
 *
 * Failures are swallowed (the path is best-effort UX, not data the user
 * supplied directly), but a warning is logged so the user can debug.
 */
export function setPreferredSshKeyPath(privPath: string): void {
  const prefsPath = getSpawnPreferencesPath();
  const result = tryCatch(() => {
    const existing: Record<string, unknown> = existsSync(prefsPath)
      ? (parseJsonObj(readFileSync(prefsPath, "utf-8")) ?? {})
      : {};
    const merged = {
      ...existing,
      sshKeyPath: privPath,
    };
    mkdirSync(dirname(prefsPath), {
      recursive: true,
    });
    writeFileSync(prefsPath, `${JSON.stringify(merged, null, 2)}\n`);
  });
  if (!result.ok) {
    logWarn(`Could not save preferred SSH key to ${prefsPath}: ${result.error.message}`);
  }
}

/** Remove the saved SSH-key preference. Used by tests and recovery flows. */
export function clearPreferredSshKeyPath(): void {
  const prefsPath = getSpawnPreferencesPath();
  if (!existsSync(prefsPath)) {
    return;
  }
  tryCatch(() => {
    const existing = parseJsonObj(readFileSync(prefsPath, "utf-8")) ?? {};
    if (!("sshKeyPath" in existing)) {
      return;
    }
    const { sshKeyPath: _drop, ...rest } = existing;
    writeFileSync(prefsPath, `${JSON.stringify(rest, null, 2)}\n`);
  });
}

/**
 * Build a SshKeyPair record from a private-key path on disk. Used when
 * honoring a saved preference — we don't always need the public key, but
 * we still try to populate metadata so logs are accurate.
 */
function pairFromPrivPath(privPath: string): SshKeyPair {
  const segments = privPath.split("/");
  const name = segments[segments.length - 1] || privPath;
  const pubPath = `${privPath}.pub`;
  const type = existsSync(pubPath) ? getKeyType(pubPath) : "UNKNOWN";
  return {
    privPath,
    pubPath,
    name,
    type,
  };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Return the keys to offer when SSHing to a Spawn-managed VM.
 *
 * - Saved preference exists & file present → use ONLY that key. The user
 *   already told spawn which key works for the cloud they're using; mixing
 *   in extra `-i` flags would just burn MaxAuthTries on guesses we know
 *   will fail.
 * - First entry is always the spawn-managed key (generated if missing) —
 *   this is what new VMs are provisioned with.
 * - Followed by any pre-existing default-named keys as legacy -i fallbacks
 *   so VMs provisioned by older Spawn versions remain reachable.
 * - Capped at MAX_KEYS so we stay under a typical sshd MaxAuthTries (6).
 *
 * Cached at module level so subsequent calls return instantly.
 */
export async function ensureSshKeys(): Promise<SshKeyPair[]> {
  if (cachedKeys) {
    return cachedKeys;
  }

  // Honor a saved preference first: if the user previously picked a key
  // (after spawn auto-discovery failed to authenticate), use only that
  // one. We've already verified the path exists in getPreferredSshKeyPath.
  const preferred = getPreferredSshKeyPath();
  if (preferred) {
    logInfo(`Using saved SSH key: ${preferred}`);
    cachedKeys = [
      pairFromPrivPath(preferred),
    ];
    return cachedKeys;
  }

  const spawnKey = getSpawnKey();
  const legacy = discoverLegacyKeys();
  cachedKeys = [
    spawnKey,
    ...legacy,
  ].slice(0, MAX_KEYS);
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

// ─── Interactive Picker ─────────────────────────────────────────────────────

/**
 * Validate a user-supplied private key path. Returns the absolute path on
 * success, or an error message string on failure (so it can be surfaced in
 * the clack `validate` callback).
 */
function validateCustomKeyPath(input: string | undefined): string | undefined {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return "Path must not be empty";
  }
  // Expand leading ~ to $HOME so users can paste familiar paths
  const home = process.env.HOME ?? "";
  const expanded = trimmed.startsWith("~/") && home ? `${home}${trimmed.slice(1)}` : trimmed;
  if (!existsSync(expanded)) {
    return `File not found: ${expanded}`;
  }
  const statResult = tryCatchIf(isFileError, () => statSync(expanded));
  if (!statResult.ok || !statResult.data.isFile()) {
    return `Not a regular file: ${expanded}`;
  }
  return undefined;
}

/** Resolve `~/...` to `$HOME/...` and trim whitespace. */
function expandUserPath(input: string): string {
  const trimmed = input.trim();
  const home = process.env.HOME ?? "";
  return trimmed.startsWith("~/") && home ? `${home}${trimmed.slice(1)}` : trimmed;
}

/**
 * Prompt the user to pick an SSH key after a handshake auth failure.
 *
 * Behavior:
 * - Returns `null` in non-interactive mode (no prompt, caller continues
 *   retrying with whatever keys it already had).
 * - Otherwise, lists the user's discovered SSH keys plus a "Custom path..."
 *   option and a "Continue retrying with current keys" escape hatch.
 * - Returns the chosen private-key path, or `null` if the user keeps the
 *   current keys.
 *
 * The caller is responsible for swapping the returned key into the SSH
 * identity options on the next retry.
 */
export async function promptForSshKey(currentKeyPaths: string[] = []): Promise<string | null> {
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return null;
  }

  // Discover keys fresh — the user may have generated/added one in another
  // shell since spawn started, and we want to surface those new options.
  // Use discoverLegacyKeys to list user-visible keys without triggering
  // spawn key generation (which requires ssh-keygen and is not needed here).
  const discovered = discoverLegacyKeys();
  const currentSet = new Set(currentKeyPaths);

  type Option = {
    value: string;
    label: string;
    hint?: string;
  };
  const options: Option[] = [];

  for (const key of discovered) {
    options.push({
      value: key.privPath,
      label: key.name,
      hint: currentSet.has(key.privPath) ? `${key.type} • already tried` : key.type,
    });
  }
  options.push({
    value: "__custom__",
    label: "Enter a custom key path...",
    hint: "e.g. ~/work/keys/id_ed25519",
  });
  options.push({
    value: "__skip__",
    label: "Continue retrying with current keys",
  });

  const choice = await p.select({
    message: "Pick an SSH key to try",
    options,
  });

  if (p.isCancel(choice)) {
    return null;
  }
  if (choice === "__skip__") {
    return null;
  }
  if (choice === "__custom__") {
    const entered = await p.text({
      message: "Path to private key",
      placeholder: "~/.ssh/id_ed25519",
      validate: (value) => validateCustomKeyPath(value),
    });
    if (p.isCancel(entered)) {
      return null;
    }
    return expandUserPath(entered);
  }
  if (typeof choice !== "string") {
    return null;
  }
  return choice;
}

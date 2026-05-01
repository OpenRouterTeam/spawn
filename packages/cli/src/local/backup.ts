// local/backup.ts — Snapshot config files before spawn overwrites them so
// `spawn local-restore` (and `spawn uninstall`) can put the user's machine
// back to how it was before spawn ever ran on it.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { parseJsonWith } from "../shared/parse.js";
import { getUserHome } from "../shared/paths.js";
import { isFileError, tryCatchIf } from "../shared/result.js";

/**
 * A single recorded write. We keep enough context to restore the file
 * (or remove it, if it didn't exist before) on uninstall.
 */
const BackupEntrySchema = v.object({
  destPath: v.string(),
  backupPath: v.string(),
  existed: v.boolean(),
  agent: v.string(),
  timestamp: v.number(),
});

const BackupManifestSchema = v.object({
  entries: v.array(BackupEntrySchema),
});

export type BackupEntry = v.InferOutput<typeof BackupEntrySchema>;
export type BackupManifest = v.InferOutput<typeof BackupManifestSchema>;

/** Manifest is a single file under the spawn config dir. */
export function getBackupRoot(): string {
  return join(getUserHome(), ".config", "spawn", "local-backups");
}

function getManifestPath(): string {
  return join(getBackupRoot(), "manifest.json");
}

function getFilesDir(): string {
  return join(getBackupRoot(), "files");
}

/** Treat a missing or malformed manifest as empty. */
function loadManifest(): BackupManifest {
  const path = getManifestPath();
  if (!existsSync(path)) {
    return {
      entries: [],
    };
  }
  const text = readFileSync(path, "utf-8");
  const parsed = parseJsonWith(text, BackupManifestSchema);
  if (!parsed) {
    return {
      entries: [],
    };
  }
  return parsed;
}

function saveManifest(m: BackupManifest): void {
  mkdirSync(getBackupRoot(), {
    recursive: true,
  });
  writeFileSync(getManifestPath(), JSON.stringify(m, null, 2), {
    mode: 0o600,
  });
}

/** Stable encoded filename for a destination path. */
function encodeName(absPath: string, timestamp: number): string {
  const slug = absPath.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 120);
  return `${slug}-${timestamp}`;
}

/**
 * Snapshot a single absolute path before it is about to be overwritten.
 * Idempotent — if we've already snapshotted this path, the call is a no-op.
 * Directories are snapshotted as a tarball-equivalent: we record their
 * existence only, and on restore remove them if they weren't there before.
 * We keep this conservative because directory snapshots can be huge.
 */
export function snapshotBeforeWrite(absDestPath: string, agent: string): void {
  const m = loadManifest();
  // Idempotent: keep the *first* snapshot, since that captures the true
  // pre-spawn state. Subsequent writes go to the same file.
  if (m.entries.some((e) => e.destPath === absDestPath)) {
    return;
  }

  const existed = existsSync(absDestPath);
  let isFile = false;
  if (existed) {
    const result = tryCatchIf(isFileError, () => statSync(absDestPath));
    if (result.ok) {
      isFile = result.data.isFile();
    }
  }

  const timestamp = Date.now();
  let backupPath = "";
  if (existed && isFile) {
    backupPath = join(getFilesDir(), encodeName(absDestPath, timestamp));
    mkdirSync(dirname(backupPath), {
      recursive: true,
    });
    copyFileSync(absDestPath, backupPath);
  }

  m.entries.push({
    destPath: absDestPath,
    backupPath,
    existed: existed && isFile,
    agent,
    timestamp,
  });
  saveManifest(m);
}

/**
 * Snapshot a list of paths up front (before any agent install starts).
 * Useful for files spawn writes via raw shell (e.g. `printf > ~/.claude.json`)
 * that uploadFile() never sees.
 */
export function snapshotPaths(paths: ReadonlyArray<string>, agent: string): void {
  for (const p of paths) {
    snapshotBeforeWrite(p, agent);
  }
}

export interface RestoreSummary {
  restored: string[];
  removed: string[];
  failed: string[];
  remaining: number;
}

/**
 * Restore every backed-up path (optionally filtered by agent) to its pre-spawn
 * state: copy original contents back, or remove the file if it didn't exist.
 * Entries that succeed are dropped from the manifest.
 */
export function restoreBackups(agent?: string): RestoreSummary {
  const m = loadManifest();
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  const keep: BackupEntry[] = [];

  for (const e of m.entries) {
    if (agent && e.agent !== agent) {
      keep.push(e);
      continue;
    }
    const op = tryCatchIf(isFileError, () => {
      if (e.existed && e.backupPath && existsSync(e.backupPath)) {
        mkdirSync(dirname(e.destPath), {
          recursive: true,
        });
        copyFileSync(e.backupPath, e.destPath);
        restored.push(e.destPath);
        tryCatchIf(isFileError, () => unlinkSync(e.backupPath));
      } else if (existsSync(e.destPath)) {
        // Spawn created this file — remove it.
        unlinkSync(e.destPath);
        removed.push(e.destPath);
      }
    });
    if (!op.ok) {
      failed.push(e.destPath);
      keep.push(e);
    }
  }

  if (keep.length === 0) {
    // Wipe the entire backup dir when nothing's left to track.
    tryCatchIf(isFileError, () =>
      rmSync(getBackupRoot(), {
        recursive: true,
        force: true,
      }),
    );
  } else {
    m.entries = keep;
    saveManifest(m);
  }

  return {
    restored,
    removed,
    failed,
    remaining: keep.length,
  };
}

/** Read-only view of the manifest, for `spawn local-restore` summaries. */
export function listBackups(): BackupEntry[] {
  return loadManifest().entries;
}

/**
 * Paths spawn touches via raw shell (not uploadFile) for each agent.
 * Snapshotting these up front lets `local-restore` revert them too.
 * Keep this list conservative — only files we *know* spawn writes.
 */
export const SHELL_LEVEL_PATHS: Record<string, ReadonlyArray<string>> = {
  claude: [
    "/.claude.json",
    "/.claude/CLAUDE.md",
  ],
};

/** Shell rc files spawn agents may append PATH lines to. */
export const SHELL_RC_FILES: ReadonlyArray<string> = [
  "/.bashrc",
  "/.zshrc",
  "/.profile",
  "/.bash_profile",
];

/** Resolve agent-specific shell-level paths against the user's home dir. */
export function resolveShellLevelPaths(agent: string): string[] {
  const home = getUserHome();
  const list = SHELL_LEVEL_PATHS[agent] ?? [];
  return list.map((rel) => join(home, rel));
}

/** Resolve shell rc paths against the user's home dir. */
export function resolveShellRcPaths(): string[] {
  const home = getUserHome();
  return SHELL_RC_FILES.map((rel) => join(home, rel));
}

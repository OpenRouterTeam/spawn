/**
 * ssh-keys.test.ts — Tests for shared SSH key discovery, selection, and generation.
 *
 * Uses real temp directories instead of mocking node:fs (which would bleed
 * into other test files via Bun's global mock.module).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Mock @clack/prompts ─────────────────────────────────────────────────────

mock.module("@clack/prompts", () => ({
  multiselect: mock(() => Promise.resolve([])),
  isCancel: () => false,
  log: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    step: mock(() => {}),
    message: mock(() => {}),
  },
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
  }),
  select: mock(() => Promise.resolve("")),
  text: mock(() => Promise.resolve("")),
}));

// ── Import after @clack/prompts mock ────────────────────────────────────────

const { discoverSshKeys, generateSshKey, getSshFingerprint, ensureSshKeys, getSshKeyOpts, _resetCache } = await import(
  "../shared/ssh-keys"
);

// ─── Temp dir helpers ───────────────────────────────────────────────────────

let tmpDir: string;
let origHome: string | undefined;

function setupTmpHome() {
  tmpDir = `/tmp/spawn-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpDir, {
    recursive: true,
  });
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
}

function cleanupTmpHome() {
  process.env.HOME = origHome;
  try {
    rmSync(tmpDir, {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
}

/** Create a fake SSH key pair in the temp ~/.ssh directory. */
function createFakeKeyPair(name: string, keyType: "ed25519" | "rsa" = "ed25519") {
  const sshDir = join(tmpDir, ".ssh");
  mkdirSync(sshDir, {
    recursive: true,
    mode: 0o700,
  });
  const privPath = join(sshDir, name);
  const pubPath = `${privPath}.pub`;

  // Write minimal valid key files that ssh-keygen can read
  if (keyType === "ed25519") {
    // Generate a real ed25519 key pair so ssh-keygen -lf works
    const result = Bun.spawnSync(
      [
        "ssh-keygen",
        "-t",
        "ed25519",
        "-f",
        privPath,
        "-N",
        "",
        "-q",
        "-C",
        "test",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
      },
    );
    if (result.exitCode !== 0) {
      // Fallback: write placeholder files (ssh-keygen -lf may not work but existsSync will)
      writeFileSync(privPath, "fake-private-key\n", {
        mode: 0o600,
      });
      writeFileSync(pubPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake test\n");
    }
  } else {
    const result = Bun.spawnSync(
      [
        "ssh-keygen",
        "-t",
        "rsa",
        "-b",
        "2048",
        "-f",
        privPath,
        "-N",
        "",
        "-q",
        "-C",
        "test",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
      },
    );
    if (result.exitCode !== 0) {
      writeFileSync(privPath, "fake-private-key\n", {
        mode: 0o600,
      });
      writeFileSync(pubPath, "ssh-rsa AAAAFake test\n");
    }
  }

  return {
    privPath,
    pubPath,
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  _resetCache();
  process.env.SPAWN_NON_INTERACTIVE = "";
  setupTmpHome();
});

afterEach(() => {
  cleanupTmpHome();
});

// ─── discoverSshKeys ────────────────────────────────────────────────────────

describe("discoverSshKeys", () => {
  it("returns empty array when ~/.ssh does not exist", () => {
    const keys = discoverSshKeys();
    expect(keys).toEqual([]);
  });

  it("returns empty array when no .pub files exist", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
    });
    writeFileSync(join(sshDir, "config"), "Host *\n");
    const keys = discoverSshKeys();
    expect(keys).toEqual([]);
  });

  it("skips .pub files without matching private key", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
    });
    writeFileSync(join(sshDir, "orphan_key.pub"), "ssh-ed25519 AAAA...\n");
    // No private key
    const keys = discoverSshKeys();
    expect(keys).toEqual([]);
  });

  it("discovers a single key pair", () => {
    createFakeKeyPair("id_ed25519", "ed25519");
    const keys = discoverSshKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("id_ed25519");
    expect(keys[0].type).toContain("ED25519");
    expect(keys[0].privPath).toContain("id_ed25519");
    expect(keys[0].pubPath).toContain("id_ed25519.pub");
  });

  it("discovers multiple key pairs and sorts ed25519 first", () => {
    createFakeKeyPair("id_rsa", "rsa");
    createFakeKeyPair("id_ed25519", "ed25519");

    const keys = discoverSshKeys();
    expect(keys).toHaveLength(2);
    // ED25519 should sort first
    expect(keys[0].name).toBe("id_ed25519");
    expect(keys[1].name).toBe("id_rsa");
  });
});

// ─── generateSshKey ─────────────────────────────────────────────────────────

describe("generateSshKey", () => {
  it("generates an ed25519 key and returns the pair", () => {
    const pair = generateSshKey();
    expect(pair.name).toBe("id_ed25519");
    expect(pair.type).toBe("ED25519");
    expect(pair.privPath).toContain("id_ed25519");
    expect(pair.pubPath).toContain("id_ed25519.pub");
    expect(existsSync(pair.privPath)).toBe(true);
    expect(existsSync(pair.pubPath)).toBe(true);
  });
});

// ─── getSshFingerprint ──────────────────────────────────────────────────────

describe("getSshFingerprint", () => {
  it("extracts MD5 fingerprint from a real key", () => {
    const { pubPath } = createFakeKeyPair("id_ed25519", "ed25519");
    const fp = getSshFingerprint(pubPath);
    // Should be a colon-separated hex string
    expect(fp).toMatch(/^[a-f0-9:]+$/);
    expect(fp.split(":")).toHaveLength(16);
  });

  it("returns empty string for non-existent file", () => {
    const fp = getSshFingerprint("/tmp/nonexistent.pub");
    expect(fp).toBe("");
  });
});

// ─── ensureSshKeys ──────────────────────────────────────────────────────────

describe("ensureSshKeys", () => {
  it("generates a key when no keys are found", async () => {
    const keys = await ensureSshKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("id_ed25519");
    expect(existsSync(keys[0].privPath)).toBe(true);
  });

  it("uses single key silently when only one is found", async () => {
    createFakeKeyPair("id_rsa", "rsa");
    const keys = await ensureSshKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("id_rsa");
  });

  it("uses all keys in non-interactive mode when multiple exist", async () => {
    process.env.SPAWN_NON_INTERACTIVE = "1";
    createFakeKeyPair("id_ed25519", "ed25519");
    createFakeKeyPair("id_rsa", "rsa");

    const keys = await ensureSshKeys();
    expect(keys).toHaveLength(2);
  });

  it("uses all keys when multiselect is unavailable", async () => {
    // In test environments, @clack/prompts multiselect may not be available
    // due to global mock.module ordering — ensureSshKeys falls back to all keys
    createFakeKeyPair("id_ed25519", "ed25519");
    createFakeKeyPair("id_rsa", "rsa");

    const keys = await ensureSshKeys();
    expect(keys).toHaveLength(2);
  });

  it("caches results across calls", async () => {
    createFakeKeyPair("id_ed25519", "ed25519");

    const keys1 = await ensureSshKeys();
    const keys2 = await ensureSshKeys();
    expect(keys1).toEqual(keys2);
  });
});

// ─── getSshKeyOpts ──────────────────────────────────────────────────────────

describe("getSshKeyOpts", () => {
  it("builds -i flags for each key", () => {
    const keys = [
      {
        privPath: "/home/user/.ssh/id_ed25519",
        pubPath: "/home/user/.ssh/id_ed25519.pub",
        name: "id_ed25519",
        type: "ED25519",
      },
      {
        privPath: "/home/user/.ssh/id_rsa",
        pubPath: "/home/user/.ssh/id_rsa.pub",
        name: "id_rsa",
        type: "RSA",
      },
    ];
    const opts = getSshKeyOpts(keys);
    expect(opts).toEqual([
      "-i",
      "/home/user/.ssh/id_ed25519",
      "-i",
      "/home/user/.ssh/id_rsa",
    ]);
  });

  it("returns empty array for empty keys", () => {
    expect(getSshKeyOpts([])).toEqual([]);
  });
});

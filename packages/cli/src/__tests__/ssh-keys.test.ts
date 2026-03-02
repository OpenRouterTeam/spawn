/**
 * ssh-keys.test.ts — Tests for shared SSH key discovery, selection, and generation.
 *
 * Uses real temp directories for filesystem tests and spyOn(Bun, "spawnSync")
 * to mock ssh-keygen invocations — no real subprocess calls.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts({
  select: mock(() => Promise.resolve("")),
  text: mock(() => Promise.resolve("")),
});

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

/**
 * Create a fake SSH key pair in the temp ~/.ssh directory.
 * Writes placeholder key files — no subprocess calls.
 * The getKeyType function internally calls Bun.spawnSync(["ssh-keygen", "-lf", ...]);
 * tests that exercise key type detection must mock Bun.spawnSync separately.
 */
function createFakeKeyPair(name: string, keyType: "ed25519" | "rsa" = "ed25519") {
  const sshDir = join(tmpDir, ".ssh");
  mkdirSync(sshDir, {
    recursive: true,
    mode: 0o700,
  });
  const privPath = join(sshDir, name);
  const pubPath = `${privPath}.pub`;

  writeFileSync(privPath, "fake-private-key\n", {
    mode: 0o600,
  });
  if (keyType === "ed25519") {
    writeFileSync(pubPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake test\n");
  } else {
    writeFileSync(pubPath, "ssh-rsa AAAAFake test\n");
  }

  return {
    privPath,
    pubPath,
  };
}

/** Build a minimal ReadableSyncSubprocess with stdout containing text. */
function makeSyncResult(text: string, exitCode = 0): Bun.SyncSubprocess<"pipe", "pipe"> {
  const buf = Buffer.from(text);
  return {
    exitCode,
    stdout: buf,
    stderr: Buffer.alloc(0),
    success: exitCode === 0,
    pid: 0,
    resourceUsage: {
      cpuTime: {
        system: 0,
        user: 0,
        total: 0,
      },
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFaults: 0,
      majorPageFaults: 0,
      swapCount: 0,
      inBlock: 0,
      outBlock: 0,
      ipcMessagesSent: 0,
      ipcMessagesReceived: 0,
      signalsReceived: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    },
  };
}

/**
 * Build a mock spawnSync implementation that returns ssh-keygen -lf output
 * for a given key type ("ED25519" or "RSA").
 */
function sshKeygenLfResult(keyType: string): Bun.SyncSubprocess<"pipe", "pipe"> {
  return makeSyncResult(`256 SHA256:fakehash user@host (${keyType})`);
}

/**
 * Build a mock spawnSync result that simulates ssh-keygen -lf -E md5 output.
 */
function sshKeygenMd5Result(): Bun.SyncSubprocess<"pipe", "pipe"> {
  return makeSyncResult("256 MD5:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99 user@host (ED25519)");
}

/**
 * Build a mock spawnSync result that simulates successful ssh-keygen key generation.
 * Also writes the expected output files so existsSync checks pass.
 */
function sshKeygenGenerateResult(privPath: string): Bun.SyncSubprocess<"pipe", "pipe"> {
  const pubPath = `${privPath}.pub`;
  writeFileSync(privPath, "fake-private-key\n", {
    mode: 0o600,
  });
  writeFileSync(pubPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake spawn\n");
  return makeSyncResult("");
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
    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(sshKeygenLfResult("ED25519"));
    const keys = discoverSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("id_ed25519");
    expect(keys[0].type).toContain("ED25519");
    expect(keys[0].privPath).toContain("id_ed25519");
    expect(keys[0].pubPath).toContain("id_ed25519.pub");
  });

  it("discovers multiple key pairs and sorts ed25519 first", () => {
    createFakeKeyPair("id_rsa", "rsa");
    createFakeKeyPair("id_ed25519", "ed25519");

    const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((args: string[]) => {
      const pubPath = args[args.length - 1];
      const type = pubPath.includes("ed25519") ? "ED25519" : "RSA";
      return sshKeygenLfResult(type);
    });

    const keys = discoverSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(2);
    // ED25519 should sort first
    expect(keys[0].name).toBe("id_ed25519");
    expect(keys[1].name).toBe("id_rsa");
  });
});

// ─── generateSshKey ─────────────────────────────────────────────────────────

describe("generateSshKey", () => {
  it("generates an ed25519 key and returns the pair", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });
    const privPath = join(sshDir, "id_ed25519");

    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(sshKeygenGenerateResult(privPath));

    const pair = generateSshKey();
    spawnSpy.mockRestore();
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
  it("extracts MD5 fingerprint from key output", () => {
    const { pubPath } = createFakeKeyPair("id_ed25519", "ed25519");
    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(sshKeygenMd5Result());
    const fp = getSshFingerprint(pubPath);
    spawnSpy.mockRestore();
    // Should be a colon-separated hex string
    expect(fp).toMatch(/^[a-f0-9:]+$/);
    expect(fp.split(":")).toHaveLength(16);
  });

  it("returns empty string for non-existent file", () => {
    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(makeSyncResult("", 1));
    const fp = getSshFingerprint("/tmp/nonexistent.pub");
    spawnSpy.mockRestore();
    expect(fp).toBe("");
  });
});

// ─── ensureSshKeys ──────────────────────────────────────────────────────────

describe("ensureSshKeys", () => {
  it("generates a key when no keys are found", async () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });
    const privPath = join(sshDir, "id_ed25519");

    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(sshKeygenGenerateResult(privPath));

    const keys = await ensureSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("id_ed25519");
    expect(existsSync(keys[0].privPath)).toBe(true);
  });

  it("uses single key silently when only one is found", async () => {
    createFakeKeyPair("id_rsa", "rsa");
    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(sshKeygenLfResult("RSA"));
    const keys = await ensureSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("id_rsa");
  });

  it("uses all keys in non-interactive mode when multiple exist", async () => {
    process.env.SPAWN_NON_INTERACTIVE = "1";
    createFakeKeyPair("id_ed25519", "ed25519");
    createFakeKeyPair("id_rsa", "rsa");

    const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((args: string[]) => {
      const pubPath = args[args.length - 1];
      const type = pubPath.includes("ed25519") ? "ED25519" : "RSA";
      return sshKeygenLfResult(type);
    });

    const keys = await ensureSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(2);
  });

  it("uses all keys when multiselect is unavailable", async () => {
    // In test environments, @clack/prompts multiselect may not be available
    // due to global mock.module ordering — ensureSshKeys falls back to all keys
    createFakeKeyPair("id_ed25519", "ed25519");
    createFakeKeyPair("id_rsa", "rsa");

    const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((args: string[]) => {
      const pubPath = args[args.length - 1];
      const type = pubPath.includes("ed25519") ? "ED25519" : "RSA";
      return sshKeygenLfResult(type);
    });

    const keys = await ensureSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(2);
  });

  it("caches results across calls", async () => {
    createFakeKeyPair("id_ed25519", "ed25519");
    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(sshKeygenLfResult("ED25519"));

    const keys1 = await ensureSshKeys();
    const keys2 = await ensureSshKeys();
    spawnSpy.mockRestore();
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

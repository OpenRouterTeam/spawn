/**
 * ssh-keys-cov.test.ts — Additional coverage for shared/ssh-keys.ts
 *
 * Covers edge cases: generateSshKey failure + race recovery,
 * getSshFingerprint empty output, discoverSshKeys with UNKNOWN type
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryCatch } from "@openrouter/spawn-shared";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts({
  select: mock(() => Promise.resolve("")),
  text: mock(() => Promise.resolve("")),
});

const { discoverSshKeys, generateSshKey, getSshFingerprint, _resetCache } = await import("../shared/ssh-keys.js");

let tmpDir: string;
let origHome: string | undefined;

function makeSyncResult(text: string, exitCode = 0): Bun.SyncSubprocess<"pipe", "pipe"> {
  return {
    exitCode,
    stdout: Buffer.from(text),
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

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  _resetCache();
  tmpDir = `/tmp/spawn-sshkeys-cov-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpDir, {
    recursive: true,
  });
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  stderrSpy?.mockRestore();
  process.env.HOME = origHome;
  tryCatch(() =>
    rmSync(tmpDir, {
      recursive: true,
      force: true,
    }),
  );
});

// Suppress stderr — restored in afterEach to avoid contaminating other tests
let stderrSpy: ReturnType<typeof spyOn>;

describe("generateSshKey race recovery", () => {
  it("recovers when ssh-keygen fails but key was created by another process", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });
    const privPath = join(sshDir, "id_ed25519");
    const pubPath = `${privPath}.pub`;

    let callCount = 0;
    const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: ssh-keygen -t ed25519 fails, but files appear (race)
        writeFileSync(privPath, "fake-priv\n", {
          mode: 0o600,
        });
        writeFileSync(pubPath, "ssh-ed25519 AAAA fake\n");
        return makeSyncResult("", 1); // non-zero exit
      }
      // Second call: ssh-keygen -lf for getKeyType
      return makeSyncResult("256 SHA256:abc user@host (ED25519)");
    });

    const pair = generateSshKey();
    spawnSpy.mockRestore();
    expect(pair.name).toBe("id_ed25519");
    expect(existsSync(pair.privPath)).toBe(true);
  });

  it("throws when ssh-keygen fails and no files created", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });

    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(makeSyncResult("", 1));

    expect(() => generateSshKey()).toThrow("SSH key generation failed");
    spawnSpy.mockRestore();
  });
});

describe("discoverSshKeys with unknown key type", () => {
  it("labels key as UNKNOWN when ssh-keygen fails", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(sshDir, "id_custom"), "fake-priv\n", {
      mode: 0o600,
    });
    writeFileSync(join(sshDir, "id_custom.pub"), "some-key AAAA fake\n");

    // ssh-keygen throws
    const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("command not found");
    });

    const keys = discoverSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(1);
    expect(keys[0].type).toBe("UNKNOWN");
  });

  it("labels key as UNKNOWN when ssh-keygen output has no parenthesized type", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(sshDir, "id_weird"), "fake-priv\n", {
      mode: 0o600,
    });
    writeFileSync(join(sshDir, "id_weird.pub"), "weird-key AAAA fake\n");

    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(
      makeSyncResult("256 SHA256:abc user@host"), // no (TYPE) suffix
    );

    const keys = discoverSshKeys();
    spawnSpy.mockRestore();
    expect(keys).toHaveLength(1);
    expect(keys[0].type).toBe("UNKNOWN");
  });
});

describe("getSshFingerprint edge cases", () => {
  it("returns empty string when output has no MD5 match", () => {
    const spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(
      makeSyncResult("256 SHA256:abc user@host (ED25519)"), // No MD5
    );
    const fp = getSshFingerprint("/tmp/fake.pub");
    spawnSpy.mockRestore();
    expect(fp).toBe("");
  });
});

describe("discoverSshKeys sorting", () => {
  it("sorts ed25519 before rsa before unknown types", () => {
    const sshDir = join(tmpDir, ".ssh");
    mkdirSync(sshDir, {
      recursive: true,
      mode: 0o700,
    });
    // Create 3 key pairs
    writeFileSync(join(sshDir, "id_rsa"), "fake\n", {
      mode: 0o600,
    });
    writeFileSync(join(sshDir, "id_rsa.pub"), "ssh-rsa AAAA\n");
    writeFileSync(join(sshDir, "id_ecdsa"), "fake\n", {
      mode: 0o600,
    });
    writeFileSync(join(sshDir, "id_ecdsa.pub"), "ecdsa-sha2 AAAA\n");
    writeFileSync(join(sshDir, "id_ed25519"), "fake\n", {
      mode: 0o600,
    });
    writeFileSync(join(sshDir, "id_ed25519.pub"), "ssh-ed25519 AAAA\n");

    const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((args: string[]) => {
      const path = String(args[args.length - 1]);
      if (path.includes("ed25519")) {
        return makeSyncResult("256 SHA256:x (ED25519)");
      }
      if (path.includes("rsa")) {
        return makeSyncResult("2048 SHA256:x (RSA)");
      }
      return makeSyncResult("256 SHA256:x (ECDSA)");
    });

    const keys = discoverSshKeys();
    spawnSpy.mockRestore();

    expect(keys[0].type).toBe("ED25519");
    expect(keys[1].type).toBe("RSA");
    expect(keys[2].type).toBe("ECDSA");
  });
});

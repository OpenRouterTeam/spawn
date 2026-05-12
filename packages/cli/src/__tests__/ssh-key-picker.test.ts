/**
 * ssh-key-picker.test.ts — Tests for the interactive SSH-key picker that's
 * triggered when waitForSsh sees repeated "Permission denied (publickey)"
 * handshake failures, plus the saved-preference helpers that remember the
 * user's choice across spawn runs.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryCatch } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { mockClackPrompts } from "./test-helpers";

// Schema for the options array clack's `select` receives. We validate at the
// mock callsite so the test never reaches for `as` to peek inside an
// `unknown`-typed arg.
const SelectOptionSchema = v.object({
  value: v.string(),
  label: v.string(),
  hint: v.optional(v.string()),
});
const SelectArgsSchema = v.object({
  options: v.array(SelectOptionSchema),
});
type SelectOption = v.InferOutput<typeof SelectOptionSchema>;

// Default clack mocks — individual tests override `select` / `text` as needed.
const clackMocks = mockClackPrompts({
  select: mock(() => Promise.resolve("__skip__")),
  text: mock(() => Promise.resolve("")),
});

const {
  promptForSshKey,
  getPreferredSshKeyPath,
  setPreferredSshKeyPath,
  clearPreferredSshKeyPath,
  ensureSshKeys,
  _resetCache,
} = await import("../shared/ssh-keys");

// ─── Temp dir helpers (mirror ssh-keys.test.ts) ─────────────────────────────

let tmpDir: string;
let origHome: string | undefined;
let origNonInteractive: string | undefined;

function setupTmpHome() {
  tmpDir = `/tmp/spawn-ssh-picker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpDir, {
    recursive: true,
  });
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
}

function cleanupTmpHome() {
  process.env.HOME = origHome;
  tryCatch(() =>
    rmSync(tmpDir, {
      recursive: true,
      force: true,
    }),
  );
}

function createFakeKeyPair(
  name: string,
  keyType = "ed25519",
): {
  priv: string;
  pub: string;
} {
  const sshDir = join(tmpDir, ".ssh");
  mkdirSync(sshDir, {
    recursive: true,
  });
  const priv = join(sshDir, name);
  const pub = `${priv}.pub`;
  writeFileSync(priv, `fake-private-${keyType}\n`, {
    mode: 0o600,
  });
  // Embed the basename in the .pub contents so a single ssh-keygen mock can
  // tell which key it's being asked about (it returns the .pub contents from
  // disk for verifyKeyPair, so the keys must "pair" with themselves).
  writeFileSync(pub, `ssh-${keyType} AAAA${name} spawn@host\n`);
  return {
    priv,
    pub,
  };
}

/**
 * Build a minimal Bun.SyncSubprocess literal. Mirrors the helper in
 * ssh-keys.test.ts — ssh-keys.ts only reads exitCode + stdout, but the
 * SyncSubprocess type requires the full resourceUsage shape.
 */
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
 * Mock ssh-keygen so that:
 *   - `ssh-keygen -y -P "" -f <priv>` returns the corresponding .pub contents
 *     verbatim, so verifyKeyPair sees a "match"
 *   - `ssh-keygen -lf <pub>` returns "(ED25519)" (or "(RSA)" if the path hints)
 */
function smartSshKeygenMock(): (args: string[]) => Bun.SyncSubprocess<"pipe", "pipe"> {
  return (args: string[]) => {
    if (args[1] === "-y") {
      const privPath = args[args.length - 1];
      const pubPath = `${privPath}.pub`;
      const pubText = tryCatch(() => readFileSync(pubPath, "utf-8"));
      return makeSyncResult(pubText.ok ? pubText.data : "");
    }
    if (args[1] === "-lf") {
      const pubPath = args[2] ?? "";
      const type = pubPath.includes("rsa") ? "RSA" : "ED25519";
      return makeSyncResult(`256 SHA256:fakehash user@host (${type})`);
    }
    return makeSyncResult("");
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

let spawnSyncSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  _resetCache();
  setupTmpHome();
  origNonInteractive = process.env.SPAWN_NON_INTERACTIVE;
  process.env.SPAWN_NON_INTERACTIVE = "";
  // Reset shared mocks between tests so .toHaveBeenCalled assertions
  // don't carry state from earlier tests.
  clackMocks.select.mockReset();
  clackMocks.text.mockReset();
  // Mock ssh-keygen invocations so discoverSshKeys() returns our fake keys
  // without spawning the real binary.
  spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(smartSshKeygenMock());
});

afterEach(() => {
  spawnSyncSpy?.mockRestore();
  spawnSyncSpy = undefined;
  cleanupTmpHome();
  if (origNonInteractive === undefined) {
    delete process.env.SPAWN_NON_INTERACTIVE;
  } else {
    process.env.SPAWN_NON_INTERACTIVE = origNonInteractive;
  }
});

// ── promptForSshKey ─────────────────────────────────────────────────────────

describe("promptForSshKey", () => {
  it("returns null without prompting in non-interactive mode", async () => {
    process.env.SPAWN_NON_INTERACTIVE = "1";
    clackMocks.select.mockImplementation(() => Promise.resolve("__skip__"));

    const result = await promptForSshKey([]);

    expect(result).toBeNull();
    expect(clackMocks.select).not.toHaveBeenCalled();
  });

  it("returns null when the user picks 'Continue with current keys'", async () => {
    createFakeKeyPair("id_ed25519");
    clackMocks.select.mockImplementation(() => Promise.resolve("__skip__"));

    const result = await promptForSshKey([]);

    expect(result).toBeNull();
    expect(clackMocks.select).toHaveBeenCalledTimes(1);
  });

  it("returns the chosen private-key path when a discovered key is selected", async () => {
    const { priv } = createFakeKeyPair("id_ed25519");
    clackMocks.select.mockImplementation(() => Promise.resolve(priv));

    const result = await promptForSshKey([]);

    expect(result).toBe(priv);
  });

  it("offers a custom-path branch and returns the entered path", async () => {
    const { priv: existingKey } = createFakeKeyPair("id_ed25519");
    clackMocks.select.mockImplementation(() => Promise.resolve("__custom__"));
    clackMocks.text.mockImplementation(() => Promise.resolve(existingKey));

    const result = await promptForSshKey([]);

    expect(result).toBe(existingKey);
    expect(clackMocks.text).toHaveBeenCalledTimes(1);
  });

  it("expands a leading ~/ in the custom path to $HOME", async () => {
    const { priv } = createFakeKeyPair("id_ed25519");
    // The user types the path with a leading ~/ — the picker should
    // resolve it relative to HOME (which is our tmpDir in this test).
    const tildePath = "~/.ssh/id_ed25519";
    clackMocks.select.mockImplementation(() => Promise.resolve("__custom__"));
    clackMocks.text.mockImplementation(() => Promise.resolve(tildePath));

    const result = await promptForSshKey([]);

    expect(result).toBe(priv);
  });

  it("includes an 'already tried' hint for keys passed in currentKeyPaths", async () => {
    const { priv: a } = createFakeKeyPair("id_ed25519");
    const { priv: b } = createFakeKeyPair("other_key", "rsa");

    let capturedOptions: SelectOption[] = [];
    clackMocks.select.mockImplementation((args: unknown) => {
      // Capture the options passed to clack via valibot validation so we
      // never have to reach for `as` to inspect the unknown arg.
      const parsed = v.safeParse(SelectArgsSchema, args);
      capturedOptions = parsed.success ? parsed.output.options : [];
      return Promise.resolve("__skip__");
    });

    await promptForSshKey([
      a,
    ]);

    const aOpt = capturedOptions.find((o) => o.value === a);
    const bOpt = capturedOptions.find((o) => o.value === b);
    expect(aOpt?.hint ?? "").toContain("already tried");
    // b was never tried — its hint should NOT mention "already tried"
    expect(bOpt?.hint ?? "").not.toContain("already tried");
    // Sentinels for custom and skip must always be available
    expect(capturedOptions.some((o) => o.value === "__custom__")).toBe(true);
    expect(capturedOptions.some((o) => o.value === "__skip__")).toBe(true);
  });
});

// ── Saved-preference helpers ────────────────────────────────────────────────

describe("preferred SSH key persistence", () => {
  function prefsPath(): string {
    return join(tmpDir, ".config", "spawn", "preferences.json");
  }

  it("getPreferredSshKeyPath returns null when no preferences file exists", () => {
    expect(getPreferredSshKeyPath()).toBeNull();
  });

  it("getPreferredSshKeyPath returns null when preferences file has no sshKeyPath", () => {
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        models: {
          codex: "openai/gpt-5",
        },
      }),
    );
    expect(getPreferredSshKeyPath()).toBeNull();
  });

  it("getPreferredSshKeyPath returns null when sshKeyPath points at a missing file", () => {
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        sshKeyPath: "/tmp/this-file-definitely-does-not-exist-12345",
      }),
    );
    expect(getPreferredSshKeyPath()).toBeNull();
  });

  it("getPreferredSshKeyPath returns the saved path when it points at a real file", () => {
    const { priv } = createFakeKeyPair("id_ed25519");
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        sshKeyPath: priv,
      }),
    );
    expect(getPreferredSshKeyPath()).toBe(priv);
  });

  it("getPreferredSshKeyPath returns null when the file is malformed JSON", () => {
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(prefsPath(), "{this is not json");
    expect(getPreferredSshKeyPath()).toBeNull();
  });

  it("setPreferredSshKeyPath writes the value and preserves other fields", () => {
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        models: {
          codex: "openai/gpt-5",
        },
        starPromptShownAt: "2026-01-01T00:00:00Z",
      }),
    );
    const { priv } = createFakeKeyPair("id_ed25519");
    setPreferredSshKeyPath(priv);

    const PreservedSchema = v.object({
      sshKeyPath: v.string(),
      models: v.object({
        codex: v.string(),
      }),
      starPromptShownAt: v.string(),
    });
    const written = v.parse(PreservedSchema, JSON.parse(readFileSync(prefsPath(), "utf-8")));
    expect(written.sshKeyPath).toBe(priv);
    expect(written.models.codex).toBe("openai/gpt-5");
    expect(written.starPromptShownAt).toBe("2026-01-01T00:00:00Z");
  });

  it("setPreferredSshKeyPath creates the preferences directory if missing", () => {
    const { priv } = createFakeKeyPair("id_ed25519");
    setPreferredSshKeyPath(priv);
    const written = JSON.parse(readFileSync(prefsPath(), "utf-8"));
    const SchemaWithKey = v.object({
      sshKeyPath: v.string(),
    });
    expect(v.parse(SchemaWithKey, written).sshKeyPath).toBe(priv);
  });

  it("clearPreferredSshKeyPath removes only the sshKeyPath field", () => {
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    const { priv } = createFakeKeyPair("id_ed25519");
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        sshKeyPath: priv,
        models: {
          codex: "openai/gpt-5",
        },
      }),
    );
    clearPreferredSshKeyPath();
    const after = JSON.parse(readFileSync(prefsPath(), "utf-8"));
    expect("sshKeyPath" in after).toBe(false);
    const ModelsSchema = v.object({
      models: v.object({
        codex: v.string(),
      }),
    });
    expect(v.parse(ModelsSchema, after).models.codex).toBe("openai/gpt-5");
  });

  it("ensureSshKeys honors a saved preference and returns only that key", async () => {
    const { priv: pickedPriv } = createFakeKeyPair("id_rsa", "rsa");
    // Also create the spawn-managed key so getSpawnKey doesn't try to ssh-keygen
    createFakeKeyPair("spawn_ed25519");
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        sshKeyPath: pickedPriv,
      }),
    );

    const keys = await ensureSshKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].privPath).toBe(pickedPriv);
  });

  it("ensureSshKeys falls back to spawn key + legacy when the saved preference points at a missing file", async () => {
    createFakeKeyPair("spawn_ed25519");
    mkdirSync(join(tmpDir, ".config", "spawn"), {
      recursive: true,
    });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        sshKeyPath: "/tmp/nope-xyz-not-here",
      }),
    );

    const keys = await ensureSshKeys();
    // Spawn key is always first when no preference is honored
    expect(keys[0].name).toBe("spawn_ed25519");
  });
});

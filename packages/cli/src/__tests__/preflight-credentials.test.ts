import type { Manifest } from "../manifest";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { preflightCredentialCheck } from "../commands/index.js";
import { mockClackPrompts } from "./test-helpers";

// Must be called before dynamic imports that use @clack/prompts
const clack = mockClackPrompts();

function makeManifest(cloudAuth: string, cloudKey = "testcloud"): Manifest {
  return {
    agents: {},
    clouds: {
      [cloudKey]: {
        name: cloudKey === "digitalocean" ? "DigitalOcean" : "Test Cloud",
        description: "A test cloud",
        price: "test",
        url: "https://test.cloud",
        type: "vps",
        auth: cloudAuth,
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: {},
  };
}

describe("preflightCredentialCheck", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string) {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    process.env[key] = value;
  }

  function clearEnv(key: string) {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    delete process.env[key];
  }

  beforeEach(() => {
    clack.logWarn.mockClear();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const k of Object.keys(savedEnv)) {
      delete savedEnv[k];
    }
  });

  it("emits no warnings when all credentials are present", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    setEnv("HCLOUD_TOKEN", "test-token");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBe(0);
  });

  it("warns with cloud credential name when cloud token is missing", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    clearEnv("HCLOUD_TOKEN");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBeGreaterThan(0);
    const warnText = String(clack.logWarn.mock.calls[0]?.[0] ?? "");
    expect(warnText).toContain("HCLOUD_TOKEN");
  });

  it("warns with OPENROUTER_API_KEY name when API key is missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    setEnv("HCLOUD_TOKEN", "test-token");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBeGreaterThan(0);
    const warnText = String(clack.logWarn.mock.calls[0]?.[0] ?? "");
    expect(warnText).toContain("OPENROUTER_API_KEY");
  });

  it("warns about all missing credentials when both are absent", async () => {
    clearEnv("OPENROUTER_API_KEY");
    clearEnv("HCLOUD_TOKEN");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBeGreaterThan(0);
    const warnText = String(clack.logWarn.mock.calls[0]?.[0] ?? "");
    expect(warnText).toContain("OPENROUTER_API_KEY");
    expect(warnText).toContain("HCLOUD_TOKEN");
  });

  it("emits no warnings for cli auth when OPENROUTER_API_KEY is present", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    await preflightCredentialCheck(makeManifest("cli"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBe(0);
  });

  it("warns about OPENROUTER_API_KEY for cli auth when key is missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    await preflightCredentialCheck(makeManifest("cli"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBeGreaterThan(0);
    const warnText = String(clack.logWarn.mock.calls[0]?.[0] ?? "");
    expect(warnText).toContain("OPENROUTER_API_KEY");
  });

  it("emits no warnings for auth=none even when all credentials are missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    await preflightCredentialCheck(makeManifest("none"), "testcloud");
    expect(clack.logWarn.mock.calls.length).toBe(0);
  });

  describe("digitalocean + TTY gating", () => {
    // Drive isInteractiveTTY() via the underlying process.std*.isTTY flags
    // instead of spyOn(shared, "isInteractiveTTY"): ESM live bindings mean the
    // same-module call inside preflightCredentialCheck keeps the original
    // reference, so a module-level spy doesn't intercept it. Other tests in
    // the suite can redefine these properties (sometimes as read-only), so use
    // defineProperty and capture/restore the full descriptors.
    let savedStdin: PropertyDescriptor | undefined;
    let savedStdout: PropertyDescriptor | undefined;

    function setTTY(value: boolean): void {
      Object.defineProperty(process.stdin, "isTTY", {
        value,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value,
        configurable: true,
        writable: true,
      });
    }

    beforeEach(() => {
      savedStdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      savedStdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      // Other tests may leave ~/.config/spawn/digitalocean.json in the shared
      // sandbox HOME; its presence causes collectMissingCredentials to return
      // empty and suppresses the warning we're asserting here.
      const doConfig = path.join(process.env.HOME ?? "", ".config", "spawn", "digitalocean.json");
      if (fs.existsSync(doConfig)) {
        fs.rmSync(doConfig);
      }
    });

    afterEach(() => {
      // Restore the original descriptor if present; otherwise reset to a
      // writable undefined so subsequent property writes in other tests don't
      // hit the read-only descriptor we installed above.
      Object.defineProperty(
        process.stdin,
        "isTTY",
        savedStdin ?? {
          value: undefined,
          configurable: true,
          writable: true,
        },
      );
      Object.defineProperty(
        process.stdout,
        "isTTY",
        savedStdout ?? {
          value: undefined,
          configurable: true,
          writable: true,
        },
      );
    });

    it("skips warnings when interactive (guided checklist supplies credentials)", async () => {
      setTTY(true);
      clearEnv("OPENROUTER_API_KEY");
      clearEnv("DIGITALOCEAN_ACCESS_TOKEN");
      await preflightCredentialCheck(makeManifest("DIGITALOCEAN_ACCESS_TOKEN", "digitalocean"), "digitalocean");
      expect(clack.logWarn.mock.calls.length).toBe(0);
    });

    it("still warns when not interactive", async () => {
      setTTY(false);
      clearEnv("OPENROUTER_API_KEY");
      clearEnv("DIGITALOCEAN_ACCESS_TOKEN");
      await preflightCredentialCheck(makeManifest("DIGITALOCEAN_ACCESS_TOKEN", "digitalocean"), "digitalocean");
      expect(clack.logWarn.mock.calls.length).toBeGreaterThan(0);
      const warnText = String(clack.logWarn.mock.calls[0]?.[0] ?? "");
      expect(warnText).toContain("Missing credentials");
      expect(warnText).toMatch(/DIGITALOCEAN_ACCESS_TOKEN|OPENROUTER_API_KEY/);
    });
  });
});

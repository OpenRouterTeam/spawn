import type { Manifest } from "../manifest";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { preflightCredentialCheck } from "../commands/index.js";
import { mockClackPrompts } from "./test-helpers";

// Must be called before dynamic imports that use @clack/prompts
const clack = mockClackPrompts();

function makeManifest(cloudAuth: string): Manifest {
  return {
    agents: {},
    clouds: {
      testcloud: {
        name: "Test Cloud",
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
});

import type { Manifest } from "../manifest";

import { afterEach, beforeEach, describe, it, spyOn } from "bun:test";
import { preflightCredentialCheck } from "../commands/index.js";
import { mockClackPrompts } from "./test-helpers";

// Must be called before dynamic imports that use @clack/prompts
mockClackPrompts();

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
  let stderrSpy: ReturnType<typeof spyOn>;
  let stderrOutput: string[];

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
    stderrOutput = [];
    // Capture all stderr output — clack log functions eventually write here
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    // Also capture console.warn/log which clack might use
    spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
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

  it("should pass when all credentials are present", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    setEnv("HCLOUD_TOKEN", "test-token");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
    // No crash = pass
  });

  it("should warn when cloud-specific credential is missing", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    clearEnv("HCLOUD_TOKEN");
    // Should not throw
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
  });

  it("should warn when OPENROUTER_API_KEY is missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    setEnv("HCLOUD_TOKEN", "test-token");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
  });

  it("should warn about multiple missing credentials", async () => {
    clearEnv("OPENROUTER_API_KEY");
    clearEnv("HCLOUD_TOKEN");
    await preflightCredentialCheck(makeManifest("HCLOUD_TOKEN"), "testcloud");
  });

  it("should not warn when auth is cli and OPENROUTER_API_KEY is present", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    await preflightCredentialCheck(makeManifest("cli"), "testcloud");
  });

  it("should warn for CLI-based auth when OPENROUTER_API_KEY is missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    await preflightCredentialCheck(makeManifest("cli"), "testcloud");
  });

  it("should handle auth=none without warnings", async () => {
    clearEnv("OPENROUTER_API_KEY");
    await preflightCredentialCheck(makeManifest("none"), "testcloud");
  });
});

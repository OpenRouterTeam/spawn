import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { showPreflightCredentialCheck, parseAuthEnvVars } from "../commands";
import type { Manifest } from "../manifest";
import { createConsoleMocks, restoreMocks } from "./test-helpers";

function makeManifest(cloudAuth: string): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: {},
      },
    },
    clouds: {
      hetzner: {
        name: "Hetzner Cloud",
        description: "European cloud provider",
        url: "https://hetzner.com",
        type: "cloud",
        auth: cloudAuth,
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: { "hetzner/claude": "implemented" },
  };
}

describe("showPreflightCredentialCheck", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
      DO_API_TOKEN: process.env.DO_API_TOKEN,
      CONTABO_CLIENT_ID: process.env.CONTABO_CLIENT_ID,
      CONTABO_CLIENT_SECRET: process.env.CONTABO_CLIENT_SECRET,
    };
  });

  afterEach(() => {
    restoreMocks(consoleMocks.log, consoleMocks.error);
    // Restore environment
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("shows nothing when all credentials are set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    process.env.HCLOUD_TOKEN = "test-token";
    const manifest = makeManifest("HCLOUD_TOKEN");

    showPreflightCredentialCheck(manifest, "hetzner");

    // Should not output anything
    expect(consoleMocks.log).not.toHaveBeenCalled();
  });

  it("shows OPENROUTER_API_KEY warning when not set", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.HCLOUD_TOKEN = "test-token";
    const manifest = makeManifest("HCLOUD_TOKEN");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("OPENROUTER_API_KEY");
    expect(output).toContain("authenticate via browser");
  });

  it("shows cloud auth var warning when not set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    delete process.env.HCLOUD_TOKEN;
    const manifest = makeManifest("HCLOUD_TOKEN");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("HCLOUD_TOKEN");
    expect(output).toContain("spawn hetzner");
  });

  it("shows both warnings when both are missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HCLOUD_TOKEN;
    const manifest = makeManifest("HCLOUD_TOKEN");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("OPENROUTER_API_KEY");
    expect(output).toContain("HCLOUD_TOKEN");
  });

  it("handles multiple cloud auth vars", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    delete process.env.CONTABO_CLIENT_ID;
    delete process.env.CONTABO_CLIENT_SECRET;
    const manifest = makeManifest("CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("CONTABO_CLIENT_ID");
    expect(output).toContain("CONTABO_CLIENT_SECRET");
  });

  it("shows non-env-var auth as info when no env vars detected", () => {
    delete process.env.OPENROUTER_API_KEY;
    const manifest = makeManifest("aws configure (AWS credentials)");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("aws configure");
  });

  it("shows nothing when auth is 'none' and OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    const manifest = makeManifest("none");

    showPreflightCredentialCheck(manifest, "hetzner");

    expect(consoleMocks.log).not.toHaveBeenCalled();
  });

  it("shows only OPENROUTER_API_KEY warning when auth is 'none' and key missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    const manifest = makeManifest("none");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("OPENROUTER_API_KEY");
    expect(output).not.toContain("spawn hetzner");  // no setup instructions for none auth
  });

  it("does not show 'setup instructions' hint when only OPENROUTER_API_KEY is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.HCLOUD_TOKEN = "test-token";
    const manifest = makeManifest("HCLOUD_TOKEN");

    showPreflightCredentialCheck(manifest, "hetzner");

    const output = consoleMocks.log.mock.calls.flat().join("\n");
    // Should show OPENROUTER_API_KEY warning but not cloud setup instructions
    expect(output).toContain("OPENROUTER_API_KEY");
    // The setup instructions line should not be shown because cloud vars are fine
    expect(output).not.toContain("for setup instructions");
  });
});

describe("parseAuthEnvVars", () => {
  it("extracts single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("extracts multiple env vars joined by +", () => {
    expect(parseAuthEnvVars("CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET")).toEqual([
      "CONTABO_CLIENT_ID",
      "CONTABO_CLIENT_SECRET",
    ]);
  });

  it("returns empty for non-env-var auth strings", () => {
    expect(parseAuthEnvVars("aws configure (AWS credentials)")).toEqual([]);
    expect(parseAuthEnvVars("modal setup")).toEqual([]);
    expect(parseAuthEnvVars("none")).toEqual([]);
    expect(parseAuthEnvVars("gcloud auth login")).toEqual([]);
  });

  it("extracts env vars even with descriptive text", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });
});

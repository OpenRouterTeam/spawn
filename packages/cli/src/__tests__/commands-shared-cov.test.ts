import type { Manifest } from "../manifest.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildAgentPickerHints, formatCredStatusLine, isAuthEnvVarSet } from "../commands/index.js";

// ── isAuthEnvVarSet ─────────────────────────────────────────────────────────

describe("isAuthEnvVarSet", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = {
      ...process.env,
    };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns true when the env var is set", () => {
    process.env.HCLOUD_TOKEN = "test-value";
    expect(isAuthEnvVarSet("HCLOUD_TOKEN")).toBe(true);
  });

  it("returns false when the env var is not set", () => {
    delete process.env.HCLOUD_TOKEN;
    expect(isAuthEnvVarSet("HCLOUD_TOKEN")).toBe(false);
  });

  it("returns false for empty string env var", () => {
    process.env.HCLOUD_TOKEN = "";
    expect(isAuthEnvVarSet("HCLOUD_TOKEN")).toBe(false);
  });

  it("returns true when a legacy alias is set (DIGITALOCEAN_API_TOKEN)", () => {
    delete process.env.DIGITALOCEAN_ACCESS_TOKEN;
    process.env.DIGITALOCEAN_API_TOKEN = "alias-val";
    expect(isAuthEnvVarSet("DIGITALOCEAN_ACCESS_TOKEN")).toBe(true);
  });

  it("returns true when a legacy alias is set (DO_API_TOKEN)", () => {
    delete process.env.DIGITALOCEAN_ACCESS_TOKEN;
    delete process.env.DIGITALOCEAN_API_TOKEN;
    process.env.DO_API_TOKEN = "alias-val";
    expect(isAuthEnvVarSet("DIGITALOCEAN_ACCESS_TOKEN")).toBe(true);
  });

  it("returns true when canonical var is set even if aliases are empty", () => {
    process.env.DIGITALOCEAN_ACCESS_TOKEN = "canonical";
    delete process.env.DIGITALOCEAN_API_TOKEN;
    delete process.env.DO_API_TOKEN;
    expect(isAuthEnvVarSet("DIGITALOCEAN_ACCESS_TOKEN")).toBe(true);
  });

  it("returns false when neither canonical nor aliases are set", () => {
    delete process.env.DIGITALOCEAN_ACCESS_TOKEN;
    delete process.env.DIGITALOCEAN_API_TOKEN;
    delete process.env.DO_API_TOKEN;
    expect(isAuthEnvVarSet("DIGITALOCEAN_ACCESS_TOKEN")).toBe(false);
  });

  it("returns false for a var with no aliases that is not set", () => {
    delete process.env.SOME_UNKNOWN_VAR;
    expect(isAuthEnvVarSet("SOME_UNKNOWN_VAR")).toBe(false);
  });
});

// ── formatCredStatusLine ────────────────────────────────────────────────────

describe("formatCredStatusLine", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = {
      ...process.env,
    };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("shows 'set' when env var is present", () => {
    process.env.HCLOUD_TOKEN = "test-value";
    const line = formatCredStatusLine("HCLOUD_TOKEN");
    expect(line).toContain("HCLOUD_TOKEN");
    expect(line).toContain("set");
  });

  it("shows 'not set' when env var is missing", () => {
    delete process.env.HCLOUD_TOKEN;
    const line = formatCredStatusLine("HCLOUD_TOKEN");
    expect(line).toContain("HCLOUD_TOKEN");
    expect(line).toContain("not set");
  });

  it("includes URL hint when provided and var is missing", () => {
    delete process.env.HCLOUD_TOKEN;
    const line = formatCredStatusLine("HCLOUD_TOKEN", "https://hetzner.com/console");
    expect(line).toContain("HCLOUD_TOKEN");
    expect(line).toContain("not set");
    expect(line).toContain("https://hetzner.com/console");
  });

  it("omits URL hint when var is set (even if hint provided)", () => {
    process.env.HCLOUD_TOKEN = "test-value";
    const line = formatCredStatusLine("HCLOUD_TOKEN", "https://hetzner.com/console");
    expect(line).toContain("HCLOUD_TOKEN");
    expect(line).toContain("set");
    // When var is set, URL hint should not appear
    expect(line).not.toContain("https://hetzner.com/console");
  });

  it("works with alias-based env var detection", () => {
    delete process.env.DIGITALOCEAN_ACCESS_TOKEN;
    process.env.DO_API_TOKEN = "alias-val";
    const line = formatCredStatusLine("DIGITALOCEAN_ACCESS_TOKEN");
    // Should detect via alias and show as set
    expect(line).toContain("DIGITALOCEAN_ACCESS_TOKEN");
    expect(line).toContain("set");
    expect(line).not.toContain("not set");
  });
});

// ── buildAgentPickerHints ───────────────────────────────────────────────────

describe("buildAgentPickerHints", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = {
      ...process.env,
    };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  const makeManifest = (overrides?: {
    matrix?: Record<string, string>;
    cloudAuth?: Record<string, string>;
  }): Manifest => ({
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: {
          ANTHROPIC_API_KEY: "test-key",
        },
      },
      codex: {
        name: "Codex",
        description: "AI pair programmer",
        url: "https://codex.dev",
        install: "npm install -g codex",
        launch: "codex",
        env: {
          OPENAI_API_KEY: "test-key",
        },
      },
    },
    clouds: {
      hetzner: {
        name: "Hetzner Cloud",
        description: "European cloud provider",
        price: "$3.49/mo",
        url: "https://hetzner.com",
        type: "cloud",
        auth: overrides?.cloudAuth?.hetzner ?? "HCLOUD_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      aws: {
        name: "Amazon Web Services",
        description: "AWS cloud",
        price: "$3.50/mo",
        url: "https://aws.amazon.com",
        type: "cloud",
        auth: overrides?.cloudAuth?.aws ?? "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: overrides?.matrix ?? {
      "hetzner/claude": "implemented",
      "hetzner/codex": "missing",
      "aws/claude": "implemented",
      "aws/codex": "implemented",
    },
  });

  it("returns hints for all agents in the manifest", () => {
    const hints = buildAgentPickerHints(makeManifest());
    expect(Object.keys(hints)).toContain("claude");
    expect(Object.keys(hints)).toContain("codex");
  });

  it("shows cloud count for agents with implementations", () => {
    delete process.env.HCLOUD_TOKEN;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const hints = buildAgentPickerHints(makeManifest());
    // claude: implemented on hetzner and aws = 2 clouds
    expect(hints.claude).toContain("2 clouds");
    // codex: implemented on aws only = 1 cloud
    expect(hints.codex).toContain("1 cloud");
  });

  it("uses singular 'cloud' for agents on exactly one cloud", () => {
    delete process.env.HCLOUD_TOKEN;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const hints = buildAgentPickerHints(makeManifest());
    expect(hints.codex).toMatch(/1 cloud(?!s)/);
  });

  it("shows 'no clouds available yet' for agents with zero implementations", () => {
    const hints = buildAgentPickerHints(
      makeManifest({
        matrix: {
          "hetzner/claude": "implemented",
          "hetzner/codex": "missing",
          "aws/claude": "implemented",
          "aws/codex": "missing",
        },
      }),
    );
    expect(hints.codex).toBe("no clouds available yet");
  });

  it("shows ready count when credentials are set", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    process.env.AWS_ACCESS_KEY_ID = "test-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    const hints = buildAgentPickerHints(makeManifest());
    // claude: 2 clouds, 2 ready
    expect(hints.claude).toContain("2 ready");
  });

  it("shows ready count for partially credentialed clouds", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const hints = buildAgentPickerHints(makeManifest());
    // claude: 2 clouds, 1 ready (hetzner only)
    expect(hints.claude).toContain("2 clouds");
    expect(hints.claude).toContain("1 ready");
  });

  it("omits ready count when no credentials are set", () => {
    delete process.env.HCLOUD_TOKEN;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const hints = buildAgentPickerHints(makeManifest());
    expect(hints.claude).not.toContain("ready");
  });

  it("handles empty manifest", () => {
    const emptyManifest: Manifest = {
      agents: {},
      clouds: {},
      matrix: {},
    };
    const hints = buildAgentPickerHints(emptyManifest);
    expect(Object.keys(hints)).toHaveLength(0);
  });
});

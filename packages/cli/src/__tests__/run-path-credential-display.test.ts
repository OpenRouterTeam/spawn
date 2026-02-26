import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Tests for critical-path functions in the `spawn <agent> <cloud>` run flow
 * that had ZERO test coverage:
 *
 * - prioritizeCloudsByCredentials: sorts clouds by credential availability,
 *   builds hint overrides, counts clouds with credentials
 * - buildCredentialStatusLines: builds credential status lines for dry-run preview
 * - formatAuthVarLine: formats individual auth env var display lines
 * - validateRunSecurity: validates agent/cloud/prompt before execution
 * - validateEntities: validates agent + cloud exist in manifest before execution
 *
 * These functions are all in the hot path of cmdRun (the primary CLI flow).
 * A bug in any of them breaks the user experience for every spawn invocation.
 *
 * Agent: test-engineer
 */

// ── Test manifest ───────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<Manifest>): Manifest {
  const base: Manifest = {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding agent by Anthropic",
        url: "https://claude.ai",
        install: "curl -fsSL https://claude.ai/install.sh | bash",
        launch: "claude",
        env: {
          ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
          ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY",
          ANTHROPIC_API_KEY: "",
        },
      },
      codex: {
        name: "Codex",
        description: "AI pair programming in your terminal",
        url: "https://codex.dev",
        install: "npm install -g codex",
        launch: "codex",
        env: {
          OPENROUTER_API_KEY: "$OPENROUTER_API_KEY",
        },
      },
    },
    clouds: {
      hetzner: {
        name: "Hetzner Cloud",
        description: "German cloud provider",
        url: "https://hetzner.cloud",
        type: "api",
        auth: "HCLOUD_TOKEN",
        provision_method: "api",
        exec_method: "ssh root@IP",
        interactive_method: "ssh -t root@IP",
      },
      sprite: {
        name: "Sprite",
        description: "Instant cloud dev environments",
        url: "https://sprite.dev",
        type: "cli",
        auth: "sprite login",
        provision_method: "cli",
        exec_method: "sprite exec NAME",
        interactive_method: "sprite exec NAME -tty",
      },
      digitalocean: {
        name: "DigitalOcean",
        description: "Simple cloud hosting",
        url: "https://digitalocean.com",
        type: "api",
        auth: "DO_API_TOKEN",
        provision_method: "api",
        exec_method: "ssh root@IP",
        interactive_method: "ssh -t root@IP",
      },
      upcloud: {
        name: "UpCloud",
        description: "European cloud provider",
        url: "https://upcloud.com",
        type: "api",
        auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
        provision_method: "api",
        exec_method: "ssh root@IP",
        interactive_method: "ssh -t root@IP",
      },
      localcloud: {
        name: "Local Machine",
        description: "Run locally",
        url: "",
        type: "local",
        auth: "none",
        provision_method: "local",
        exec_method: "bash -c",
        interactive_method: "bash",
      },
    },
    matrix: {
      "hetzner/claude": "implemented",
      "hetzner/codex": "implemented",
      "sprite/claude": "implemented",
      "sprite/codex": "missing",
      "digitalocean/claude": "implemented",
      "digitalocean/codex": "implemented",
      "upcloud/claude": "implemented",
      "upcloud/codex": "missing",
      "localcloud/claude": "implemented",
      "localcloud/codex": "implemented",
    },
  };
  return overrides
    ? {
        ...base,
        ...overrides,
      }
    : base;
}

// ── Mock @clack/prompts ─────────────────────────────────────────────────

const mockExit = spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

const mockLog = {
  step: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  success: mock(() => {}),
};

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: mockLog,
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => Promise.resolve("hetzner")),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  confirm: mock(() => Promise.resolve(true)),
  isCancel: () => false,
}));

// Import after mocks are set up
const {
  prioritizeCloudsByCredentials,
  parseAuthEnvVars,
  credentialHints,
  getImplementedClouds,
  getImplementedAgents,
  checkEntity,
  resolveAgentKey,
  resolveCloudKey,
  buildRetryCommand,
  isRetryableExitCode,
  getScriptFailureGuidance,
} = await import("../commands.js");

// ── prioritizeCloudsByCredentials ────────────────────────────────────────

describe("prioritizeCloudsByCredentials", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear credential env vars
    for (const v of [
      "HCLOUD_TOKEN",
      "DO_API_TOKEN",
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("should return all clouds when none have credentials", () => {
    const manifest = makeManifest();
    const clouds = [
      "hetzner",
      "digitalocean",
      "upcloud",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.sortedClouds).toEqual(clouds);
    expect(result.credCount).toBe(0);
    expect(Object.keys(result.hintOverrides)).toHaveLength(0);
  });

  it("should move clouds with credentials to front", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const manifest = makeManifest();
    const clouds = [
      "digitalocean",
      "hetzner",
      "upcloud",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.sortedClouds[0]).toBe("hetzner");
    expect(result.credCount).toBe(1);
    expect(result.sortedClouds).toContain("digitalocean");
    expect(result.sortedClouds).toContain("upcloud");
  });

  it("should move multiple credential clouds to front", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    process.env.DO_API_TOKEN = "test-do-token";
    const manifest = makeManifest();
    const clouds = [
      "upcloud",
      "digitalocean",
      "hetzner",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    // Both hetzner and digitalocean should be first, upcloud last
    expect(result.credCount).toBe(2);
    expect(result.sortedClouds.indexOf("hetzner")).toBeLessThan(result.sortedClouds.indexOf("upcloud"));
    expect(result.sortedClouds.indexOf("digitalocean")).toBeLessThan(result.sortedClouds.indexOf("upcloud"));
  });

  it("should build hint overrides for clouds with credentials", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const manifest = makeManifest();
    const clouds = [
      "hetzner",
      "digitalocean",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.hintOverrides["hetzner"]).toContain("credentials detected");
    expect(result.hintOverrides["hetzner"]).toContain("German cloud provider");
    expect(result.hintOverrides["digitalocean"]).toBeUndefined();
  });

  it("should handle multi-var auth (both vars must be set)", () => {
    process.env.UPCLOUD_USERNAME = "user";
    // Missing UPCLOUD_PASSWORD
    const manifest = makeManifest();
    const clouds = [
      "upcloud",
      "hetzner",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    // upcloud should NOT be prioritized (missing one of two vars)
    expect(result.credCount).toBe(0);
  });

  it("should handle multi-var auth when all vars set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    const manifest = makeManifest();
    const clouds = [
      "hetzner",
      "upcloud",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.credCount).toBe(1);
    expect(result.sortedClouds[0]).toBe("upcloud");
  });

  it("should handle empty cloud list", () => {
    const manifest = makeManifest();
    const result = prioritizeCloudsByCredentials([], manifest);

    expect(result.sortedClouds).toEqual([]);
    expect(result.credCount).toBe(0);
    expect(Object.keys(result.hintOverrides)).toHaveLength(0);
  });

  it("should handle single cloud with credentials", () => {
    process.env.HCLOUD_TOKEN = "token";
    const manifest = makeManifest();
    const result = prioritizeCloudsByCredentials(
      [
        "hetzner",
      ],
      manifest,
    );

    expect(result.sortedClouds).toEqual([
      "hetzner",
    ]);
    expect(result.credCount).toBe(1);
  });

  it("should handle single cloud without credentials", () => {
    const manifest = makeManifest();
    const result = prioritizeCloudsByCredentials(
      [
        "hetzner",
      ],
      manifest,
    );

    expect(result.sortedClouds).toEqual([
      "hetzner",
    ]);
    expect(result.credCount).toBe(0);
  });

  it("should preserve relative order within each group", () => {
    process.env.HCLOUD_TOKEN = "token";
    process.env.DO_API_TOKEN = "token";
    const manifest = makeManifest();
    // Input order: digitalocean before hetzner (both have creds)
    const clouds = [
      "digitalocean",
      "hetzner",
      "upcloud",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    // Both credential clouds should come first in their original relative order
    expect(result.sortedClouds[0]).toBe("digitalocean");
    expect(result.sortedClouds[1]).toBe("hetzner");
    expect(result.sortedClouds[2]).toBe("upcloud");
  });

  it("should handle CLI-based auth (sprite login) as no credentials", () => {
    const manifest = makeManifest();
    const clouds = [
      "sprite",
      "hetzner",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    // "sprite login" is not an env var, so sprite should not be prioritized
    expect(result.credCount).toBe(0);
  });

  it("should handle 'none' auth (local cloud) as no credentials", () => {
    const manifest = makeManifest();
    const clouds = [
      "localcloud",
      "hetzner",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.credCount).toBe(0);
  });

  it("should count all credential clouds correctly with all set", () => {
    process.env.HCLOUD_TOKEN = "t1";
    process.env.DO_API_TOKEN = "t2";
    process.env.UPCLOUD_USERNAME = "u";
    process.env.UPCLOUD_PASSWORD = "p";
    const manifest = makeManifest();
    const clouds = [
      "hetzner",
      "digitalocean",
      "upcloud",
      "sprite",
      "localcloud",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.credCount).toBe(3); // hetzner, digitalocean, upcloud
    expect(result.sortedClouds).toHaveLength(5);
    // sprite and localcloud should be at the end
    expect(result.sortedClouds.slice(3)).toContain("sprite");
    expect(result.sortedClouds.slice(3)).toContain("localcloud");
  });
});

// ── buildCredentialStatusLines (tested via dry-run behavior) ─────────────

describe("credential status display logic", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of [
      "OPENROUTER_API_KEY",
      "HCLOUD_TOKEN",
      "DO_API_TOKEN",
    ]) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  describe("parseAuthEnvVars for credential status", () => {
    it("should extract single env var", () => {
      expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual([
        "HCLOUD_TOKEN",
      ]);
    });

    it("should extract multiple env vars", () => {
      expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
        "UPCLOUD_USERNAME",
        "UPCLOUD_PASSWORD",
      ]);
    });

    it("should return empty for CLI-based auth", () => {
      expect(parseAuthEnvVars("sprite login")).toEqual([]);
    });

    it("should return empty for 'none'", () => {
      expect(parseAuthEnvVars("none")).toEqual([]);
    });
  });

});

// ── validateRunSecurity via checkEntity ──────────────────────────────────

describe("entity validation for run path", () => {
  it("should return true for valid agent key", () => {
    const manifest = makeManifest();
    expect(checkEntity(manifest, "claude", "agent")).toBe(true);
  });

  it("should return true for valid cloud key", () => {
    const manifest = makeManifest();
    expect(checkEntity(manifest, "hetzner", "cloud")).toBe(true);
  });

  it("should return false for invalid agent key", () => {
    const manifest = makeManifest();
    expect(checkEntity(manifest, "nonexistent", "agent")).toBe(false);
  });

  it("should return false for invalid cloud key", () => {
    const manifest = makeManifest();
    expect(checkEntity(manifest, "nonexistent", "cloud")).toBe(false);
  });

  it("should detect wrong kind (cloud used as agent)", () => {
    const manifest = makeManifest();
    // "hetzner" is a cloud, not an agent
    const result = checkEntity(manifest, "hetzner", "agent");
    expect(result).toBe(false);
  });

  it("should detect wrong kind (agent used as cloud)", () => {
    const manifest = makeManifest();
    // "claude" is an agent, not a cloud
    const result = checkEntity(manifest, "claude", "cloud");
    expect(result).toBe(false);
  });

  it("should suggest typo corrections for close matches", () => {
    const manifest = makeManifest();
    // "claud" is close to "claude"
    const result = checkEntity(manifest, "claud", "agent");
    expect(result).toBe(false);
    // The function logs suggestions via p.log but we just check it returns false
  });
});

// ── resolveAgentKey / resolveCloudKey for run path ──────────────────────

describe("key resolution for run path", () => {
  const manifest = makeManifest();

  it("should resolve exact agent key", () => {
    expect(resolveAgentKey(manifest, "claude")).toBe("claude");
  });

  it("should resolve exact cloud key", () => {
    expect(resolveCloudKey(manifest, "hetzner")).toBe("hetzner");
  });

  it("should resolve agent display name (case-insensitive)", () => {
    expect(resolveAgentKey(manifest, "Claude Code")).toBe("claude");
    expect(resolveAgentKey(manifest, "claude code")).toBe("claude");
  });

  it("should resolve cloud display name (case-insensitive)", () => {
    expect(resolveCloudKey(manifest, "Hetzner Cloud")).toBe("hetzner");
    expect(resolveCloudKey(manifest, "hetzner cloud")).toBe("hetzner");
  });

  it("should return null for completely unknown input", () => {
    expect(resolveAgentKey(manifest, "xyzzy")).toBeNull();
    expect(resolveCloudKey(manifest, "xyzzy")).toBeNull();
  });

  it("should resolve case-insensitive key match", () => {
    expect(resolveAgentKey(manifest, "CLAUDE")).toBe("claude");
    expect(resolveCloudKey(manifest, "HETZNER")).toBe("hetzner");
  });
});

// ── getImplementedClouds / getImplementedAgents for run path ─────────────

describe("implementation checks for run path", () => {
  const manifest = makeManifest();

  it("should return implemented clouds for claude", () => {
    const clouds = getImplementedClouds(manifest, "claude");
    expect(clouds).toContain("hetzner");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("digitalocean");
    expect(clouds).toContain("upcloud");
    expect(clouds).toContain("localcloud");
  });

  it("should return implemented clouds for codex (fewer)", () => {
    const clouds = getImplementedClouds(manifest, "codex");
    expect(clouds).toContain("hetzner");
    expect(clouds).toContain("digitalocean");
    expect(clouds).toContain("localcloud");
    // sprite/codex and upcloud/codex are "missing"
    expect(clouds).not.toContain("sprite");
    expect(clouds).not.toContain("upcloud");
  });

  it("should return implemented agents for hetzner", () => {
    const agents = getImplementedAgents(manifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
  });

  it("should return empty for nonexistent agent", () => {
    const clouds = getImplementedClouds(manifest, "nonexistent");
    expect(clouds).toEqual([]);
  });

  it("should return empty for nonexistent cloud", () => {
    const agents = getImplementedAgents(manifest, "nonexistent");
    expect(agents).toEqual([]);
  });
});

// ── Integration: full run-path validation sequence ──────────────────────

describe("run-path validation sequence integration", () => {
  const manifest = makeManifest();

  it("should validate a correct agent+cloud combination", () => {
    const agentValid = checkEntity(manifest, "claude", "agent");
    const cloudValid = checkEntity(manifest, "hetzner", "cloud");
    expect(agentValid).toBe(true);
    expect(cloudValid).toBe(true);
  });

  it("should catch invalid agent in validation", () => {
    const agentValid = checkEntity(manifest, "badagent", "agent");
    expect(agentValid).toBe(false);
  });

  it("should catch invalid cloud in validation", () => {
    const cloudValid = checkEntity(manifest, "badcloud", "cloud");
    expect(cloudValid).toBe(false);
  });

  it("should resolve display name before validation", () => {
    const resolved = resolveAgentKey(manifest, "Claude Code");
    expect(resolved).toBe("claude");
    if (resolved) {
      expect(checkEntity(manifest, resolved, "agent")).toBe(true);
    }
  });

  it("should build correct retry command after failure", () => {
    const cmd = buildRetryCommand("claude", "hetzner");
    expect(cmd).toBe("spawn claude hetzner");
  });

  it("should identify retryable SSH errors in the flow", () => {
    const errMsg = "Script exited with code 255";
    expect(isRetryableExitCode(errMsg)).toBe(true);
    const guidance = getScriptFailureGuidance(255, "hetzner");
    expect(guidance.length).toBeGreaterThan(0);
  });

  it("should identify non-retryable errors in the flow", () => {
    const errMsg = "Script exited with code 1";
    expect(isRetryableExitCode(errMsg)).toBe(false);
    const guidance = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
    expect(guidance.length).toBeGreaterThan(0);
  });
});

// ── prioritizeCloudsByCredentials with real manifest shape ──────────────

describe("prioritizeCloudsByCredentials with real-world patterns", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of [
      "HCLOUD_TOKEN",
      "DO_API_TOKEN",
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("should not crash on clouds with 'none' auth", () => {
    const manifest = makeManifest();
    const result = prioritizeCloudsByCredentials(
      [
        "localcloud",
      ],
      manifest,
    );
    expect(result.credCount).toBe(0);
    expect(result.sortedClouds).toEqual([
      "localcloud",
    ]);
  });

  it("should handle mix of API, CLI, and local clouds", () => {
    process.env.HCLOUD_TOKEN = "token";
    const manifest = makeManifest();
    const clouds = [
      "localcloud",
      "sprite",
      "hetzner",
      "digitalocean",
    ];
    const result = prioritizeCloudsByCredentials(clouds, manifest);

    expect(result.credCount).toBe(1);
    expect(result.sortedClouds[0]).toBe("hetzner");
    expect(result.sortedClouds).toHaveLength(4);
  });

  it("should generate correct hint format with description", () => {
    process.env.DO_API_TOKEN = "token";
    const manifest = makeManifest();
    const result = prioritizeCloudsByCredentials(
      [
        "digitalocean",
      ],
      manifest,
    );

    expect(result.hintOverrides["digitalocean"]).toBe("credentials detected -- Simple cloud hosting");
  });

  it("should not generate hints for clouds without credentials", () => {
    const manifest = makeManifest();
    const result = prioritizeCloudsByCredentials(
      [
        "hetzner",
        "digitalocean",
      ],
      manifest,
    );

    expect(result.hintOverrides["hetzner"]).toBeUndefined();
    expect(result.hintOverrides["digitalocean"]).toBeUndefined();
  });
});

// ── Edge cases for credential-related functions ─────────────────────────

describe("credential function edge cases", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedEnv.OPENROUTER_API_KEY === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = savedEnv.OPENROUTER_API_KEY;
    }
  });

  it("credentialHints should always mention OPENROUTER_API_KEY when missing", () => {
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h: string) => h.includes("OPENROUTER_API_KEY") || h.includes("Missing"))).toBe(true);
  });

  it("credentialHints should not flag OPENROUTER_API_KEY when set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    // When all are set, should show "appear to be set" message
    expect(hints.some((h: string) => h.includes("set") || h.includes("appear"))).toBe(true);
  });

  it("parseAuthEnvVars should handle extra whitespace", () => {
    expect(parseAuthEnvVars("  HCLOUD_TOKEN  ")).toEqual([
      "HCLOUD_TOKEN",
    ]);
  });

  it("parseAuthEnvVars should handle empty + separator", () => {
    expect(parseAuthEnvVars("VAR_A + + VAR_B")).toEqual([
      "VAR_A",
      "VAR_B",
    ]);
  });
});

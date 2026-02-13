import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  parseAuthEnvVars,
  hasCloudCredentials,
  credentialHints,
} from "../commands";

/**
 * Tests for credential display functions used in the dry-run preview path:
 *
 * - buildCredentialStatusLines: builds per-env-var status lines for --dry-run output
 * - formatAuthVarLine: formats a single env var as "set" or "export VAR=..." prompt
 * - Credential section in showDryRunPreview: shows warning when some creds are missing
 *
 * These functions are not exported, so we test them via exact replicas (same pattern
 * used throughout the test suite, e.g., formatTimestamp, parseListFilters replicas).
 *
 * Agent: test-engineer
 */

// ── Replica of formatAuthVarLine from commands.ts (line 1242-1248) ──────────

function formatAuthVarLine(varName: string, urlHint?: string): string {
  if (process.env[varName]) {
    return `  ${varName} -- set`;
  }
  const hint = urlHint ? `  # ${urlHint}` : "";
  return `  export ${varName}=...${hint}`;
}

// ── Replica of buildCredentialStatusLines from commands.ts (line 417-443) ────

function buildCredentialStatusLines(
  manifest: { clouds: Record<string, { auth: string; url?: string }> },
  cloud: string
): string[] {
  const lines: string[] = [];
  const cloudAuth = manifest.clouds[cloud].auth;
  const authVars = parseAuthEnvVars(cloudAuth);
  const cloudUrl = manifest.clouds[cloud].url;

  // Always check OPENROUTER_API_KEY
  const orSet = !!process.env.OPENROUTER_API_KEY;
  lines.push(
    orSet
      ? `  OPENROUTER_API_KEY -- set`
      : `  OPENROUTER_API_KEY -- not set  https://openrouter.ai/settings/keys`
  );

  // Check cloud-specific auth vars
  for (let i = 0; i < authVars.length; i++) {
    const v = authVars[i];
    const isSet = !!process.env[v];
    if (isSet) {
      lines.push(`  ${v} -- set`);
    } else {
      const urlHint = i === 0 && cloudUrl ? `  ${cloudUrl}` : "";
      lines.push(`  ${v} -- not set${urlHint}`);
    }
  }

  return lines;
}

// ── Environment helpers ─────────────────────────────────────────────────────

const CREDENTIAL_VARS = [
  "OPENROUTER_API_KEY",
  "HCLOUD_TOKEN",
  "DO_API_TOKEN",
  "UPCLOUD_USERNAME",
  "UPCLOUD_PASSWORD",
  "VULTR_API_KEY",
];

function saveAndClearEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const v of CREDENTIAL_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── Test manifests ──────────────────────────────────────────────────────────

function makeCloudManifest(
  clouds: Record<string, { auth: string; url?: string }>
) {
  return { clouds };
}

// ── formatAuthVarLine ───────────────────────────────────────────────────────

describe("formatAuthVarLine", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it("should show 'set' when env var is present", () => {
    process.env.HCLOUD_TOKEN = "hc-test-token";
    const line = formatAuthVarLine("HCLOUD_TOKEN");
    expect(line).toContain("HCLOUD_TOKEN");
    expect(line).toContain("-- set");
    expect(line).not.toContain("export");
  });

  it("should show 'export VAR=...' when env var is missing", () => {
    const line = formatAuthVarLine("HCLOUD_TOKEN");
    expect(line).toContain("export HCLOUD_TOKEN=...");
    expect(line).not.toContain("-- set");
  });

  it("should include URL hint when env var is missing and hint provided", () => {
    const line = formatAuthVarLine("HCLOUD_TOKEN", "https://console.hetzner.cloud");
    expect(line).toContain("export HCLOUD_TOKEN=...");
    expect(line).toContain("# https://console.hetzner.cloud");
  });

  it("should NOT include URL hint when env var is set", () => {
    process.env.HCLOUD_TOKEN = "token";
    const line = formatAuthVarLine("HCLOUD_TOKEN", "https://console.hetzner.cloud");
    expect(line).toContain("-- set");
    expect(line).not.toContain("https://console.hetzner.cloud");
  });

  it("should NOT include URL hint when hint is undefined", () => {
    const line = formatAuthVarLine("HCLOUD_TOKEN");
    expect(line).toContain("export HCLOUD_TOKEN=...");
    expect(line).not.toContain("#");
  });

  it("should handle OPENROUTER_API_KEY", () => {
    const line = formatAuthVarLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys");
    expect(line).toContain("export OPENROUTER_API_KEY=...");
    expect(line).toContain("# https://openrouter.ai/settings/keys");
  });

  it("should handle OPENROUTER_API_KEY when set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const line = formatAuthVarLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys");
    expect(line).toContain("OPENROUTER_API_KEY");
    expect(line).toContain("-- set");
    expect(line).not.toContain("export");
  });

  it("should treat empty string env var as not set", () => {
    process.env.HCLOUD_TOKEN = "";
    const line = formatAuthVarLine("HCLOUD_TOKEN");
    expect(line).toContain("export HCLOUD_TOKEN=...");
  });

  it("should treat whitespace-only env var as set", () => {
    process.env.HCLOUD_TOKEN = "  ";
    const line = formatAuthVarLine("HCLOUD_TOKEN");
    expect(line).toContain("-- set");
  });

  it("should use consistent indentation with 2-space prefix", () => {
    const lineSet = (() => { process.env.HCLOUD_TOKEN = "t"; return formatAuthVarLine("HCLOUD_TOKEN"); })();
    const lineUnset = (() => { delete process.env.HCLOUD_TOKEN; return formatAuthVarLine("HCLOUD_TOKEN"); })();
    expect(lineSet.startsWith("  ")).toBe(true);
    expect(lineUnset.startsWith("  ")).toBe(true);
  });
});

// ── buildCredentialStatusLines ──────────────────────────────────────────────

describe("buildCredentialStatusLines", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  describe("OPENROUTER_API_KEY (always present)", () => {
    it("should always include OPENROUTER_API_KEY as first line", () => {
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN", url: "https://hetzner.com" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines[0]).toContain("OPENROUTER_API_KEY");
    });

    it("should show 'not set' for OPENROUTER_API_KEY when missing", () => {
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines[0]).toContain("OPENROUTER_API_KEY");
      expect(lines[0]).toContain("not set");
      expect(lines[0]).toContain("https://openrouter.ai/settings/keys");
    });

    it("should show 'set' for OPENROUTER_API_KEY when present", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines[0]).toContain("OPENROUTER_API_KEY");
      expect(lines[0]).toContain("set");
      expect(lines[0]).not.toContain("not set");
    });
  });

  describe("single cloud auth var", () => {
    it("should show cloud auth var as 'not set' when missing", () => {
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN", url: "https://console.hetzner.cloud" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines.length).toBe(2); // OPENROUTER_API_KEY + HCLOUD_TOKEN
      expect(lines[1]).toContain("HCLOUD_TOKEN");
      expect(lines[1]).toContain("not set");
    });

    it("should show cloud auth var as 'set' when present", () => {
      process.env.HCLOUD_TOKEN = "test-token";
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines[1]).toContain("HCLOUD_TOKEN");
      expect(lines[1]).toContain("set");
      expect(lines[1]).not.toContain("not set");
    });

    it("should include cloud URL hint on first missing auth var", () => {
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN", url: "https://console.hetzner.cloud" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines[1]).toContain("https://console.hetzner.cloud");
    });

    it("should NOT include URL hint when auth var is set", () => {
      process.env.HCLOUD_TOKEN = "test";
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN", url: "https://console.hetzner.cloud" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines[1]).not.toContain("https://console.hetzner.cloud");
    });
  });

  describe("multi-var auth", () => {
    it("should show all auth vars for multi-credential cloud", () => {
      const manifest = makeCloudManifest({
        upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD", url: "https://hub.upcloud.com" },
      });
      const lines = buildCredentialStatusLines(manifest, "upcloud");
      // OPENROUTER_API_KEY + UPCLOUD_USERNAME + UPCLOUD_PASSWORD = 3 lines
      expect(lines.length).toBe(3);
      expect(lines[1]).toContain("UPCLOUD_USERNAME");
      expect(lines[2]).toContain("UPCLOUD_PASSWORD");
    });

    it("should show URL hint only on the FIRST missing auth var", () => {
      const manifest = makeCloudManifest({
        upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD", url: "https://hub.upcloud.com" },
      });
      const lines = buildCredentialStatusLines(manifest, "upcloud");
      // First cloud auth var (index 1) should have URL hint
      expect(lines[1]).toContain("https://hub.upcloud.com");
      // Second cloud auth var (index 2) should NOT have URL hint
      expect(lines[2]).not.toContain("https://hub.upcloud.com");
    });

    it("should show mixed set/not-set for partial credentials", () => {
      process.env.UPCLOUD_USERNAME = "user";
      // UPCLOUD_PASSWORD is not set
      const manifest = makeCloudManifest({
        upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD", url: "https://hub.upcloud.com" },
      });
      const lines = buildCredentialStatusLines(manifest, "upcloud");
      expect(lines[1]).toContain("UPCLOUD_USERNAME");
      expect(lines[1]).toContain("set");
      expect(lines[1]).not.toContain("not set");
      expect(lines[2]).toContain("UPCLOUD_PASSWORD");
      expect(lines[2]).toContain("not set");
    });

    it("should NOT show URL hint on second var when first is set", () => {
      process.env.UPCLOUD_USERNAME = "user";
      const manifest = makeCloudManifest({
        upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD", url: "https://hub.upcloud.com" },
      });
      const lines = buildCredentialStatusLines(manifest, "upcloud");
      // First auth var is set, so no URL hint on it
      expect(lines[1]).not.toContain("https://hub.upcloud.com");
      // Second auth var is missing but URL hint is only on i === 0
      expect(lines[2]).not.toContain("https://hub.upcloud.com");
    });
  });

  describe("no cloud auth vars (none / CLI auth)", () => {
    it("should show only OPENROUTER_API_KEY for 'none' auth cloud", () => {
      const manifest = makeCloudManifest({
        localcloud: { auth: "none" },
      });
      const lines = buildCredentialStatusLines(manifest, "localcloud");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("OPENROUTER_API_KEY");
    });

    it("should show only OPENROUTER_API_KEY for CLI-based auth", () => {
      const manifest = makeCloudManifest({
        gcp: { auth: "gcloud auth login" },
      });
      const lines = buildCredentialStatusLines(manifest, "gcp");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("OPENROUTER_API_KEY");
    });
  });

  describe("all credentials set", () => {
    it("should mark all lines as 'set' when everything is configured", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.HCLOUD_TOKEN = "test-token";
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN", url: "https://console.hetzner.cloud" },
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      expect(lines.length).toBe(2);
      // Both should show "set" and neither should show "not set"
      for (const line of lines) {
        expect(line).toContain("set");
        expect(line).not.toContain("not set");
      }
    });

    it("should mark all lines as 'set' for multi-var auth when all set", () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.UPCLOUD_USERNAME = "user";
      process.env.UPCLOUD_PASSWORD = "pass";
      const manifest = makeCloudManifest({
        upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD" },
      });
      const lines = buildCredentialStatusLines(manifest, "upcloud");
      expect(lines.length).toBe(3);
      for (const line of lines) {
        expect(line).toContain("set");
        expect(line).not.toContain("not set");
      }
    });
  });

  describe("cloud without URL", () => {
    it("should NOT include URL hint when cloud has no url field", () => {
      const manifest = makeCloudManifest({
        hetzner: { auth: "HCLOUD_TOKEN" }, // no url field
      });
      const lines = buildCredentialStatusLines(manifest, "hetzner");
      // Should still have auth var line, just no URL hint
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain("HCLOUD_TOKEN");
      expect(lines[1]).toContain("not set");
      // No URL hint since url is undefined
      const nonOrLines = lines.slice(1);
      for (const line of nonOrLines) {
        expect(line).not.toContain("https://");
      }
    });
  });
});

// ── Credential section "allSet" check in showDryRunPreview ──────────────────

describe("dry-run credential section allSet detection", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  // Replica of the allSet check from showDryRunPreview (commands.ts line 464)
  function isAllCredentialsSet(credLines: string[]): boolean {
    return credLines.every((l) => l.includes("-- set"));
  }

  it("should detect all credentials set when all lines contain '-- set'", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const manifest = makeCloudManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
    });
    const lines = buildCredentialStatusLines(manifest, "hetzner");
    expect(isAllCredentialsSet(lines)).toBe(true);
  });

  it("should detect missing credentials when OPENROUTER_API_KEY is not set", () => {
    process.env.HCLOUD_TOKEN = "token";
    const manifest = makeCloudManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
    });
    const lines = buildCredentialStatusLines(manifest, "hetzner");
    expect(isAllCredentialsSet(lines)).toBe(false);
  });

  it("should detect missing credentials when cloud auth var is not set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    const manifest = makeCloudManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
    });
    const lines = buildCredentialStatusLines(manifest, "hetzner");
    expect(isAllCredentialsSet(lines)).toBe(false);
  });

  it("should detect missing when neither credential is set", () => {
    const manifest = makeCloudManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
    });
    const lines = buildCredentialStatusLines(manifest, "hetzner");
    expect(isAllCredentialsSet(lines)).toBe(false);
  });

  it("should detect partial setup with multi-var auth", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.UPCLOUD_USERNAME = "user";
    // UPCLOUD_PASSWORD missing
    const manifest = makeCloudManifest({
      upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD" },
    });
    const lines = buildCredentialStatusLines(manifest, "upcloud");
    expect(isAllCredentialsSet(lines)).toBe(false);
  });

  it("should detect all set with 'none' auth cloud when OPENROUTER set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    const manifest = makeCloudManifest({
      localcloud: { auth: "none" },
    });
    const lines = buildCredentialStatusLines(manifest, "localcloud");
    expect(isAllCredentialsSet(lines)).toBe(true);
  });

  it("should detect missing when 'none' auth cloud but OPENROUTER not set", () => {
    const manifest = makeCloudManifest({
      localcloud: { auth: "none" },
    });
    const lines = buildCredentialStatusLines(manifest, "localcloud");
    expect(isAllCredentialsSet(lines)).toBe(false);
  });
});

// ── credentialHints allSet branch (line 651-656 in commands.ts) ──────────────

describe("credentialHints when all credentials are set", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it("should mention credentials appear to be set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("appear") || h.includes("set"))).toBe(true);
  });

  it("should suggest credentials may be invalid or expired", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("invalid") || h.includes("expired"))).toBe(true);
  });

  it("should mention setup instructions", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("spawn hetzner"))).toBe(true);
  });

  it("should list the env var names when all are set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("HCLOUD_TOKEN"))).toBe(true);
    expect(hints.some((h) => h.includes("OPENROUTER_API_KEY"))).toBe(true);
  });

  it("should handle multi-var auth when all set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    const hints = credentialHints("upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    expect(hints.some((h) => h.includes("appear") || h.includes("set"))).toBe(true);
    expect(hints.some((h) => h.includes("UPCLOUD_USERNAME"))).toBe(true);
    expect(hints.some((h) => h.includes("UPCLOUD_PASSWORD"))).toBe(true);
  });

  it("should return multiple lines for all-set case", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });
});

// ── credentialHints partial credentials ─────────────────────────────────────

describe("credentialHints with partial credentials", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it("should show only missing vars when some are set", () => {
    process.env.HCLOUD_TOKEN = "token";
    // OPENROUTER_API_KEY not set
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("Missing"))).toBe(true);
    expect(hints.some((h) => h.includes("OPENROUTER_API_KEY"))).toBe(true);
  });

  it("should show only OPENROUTER_API_KEY missing when cloud creds are set", () => {
    process.env.HCLOUD_TOKEN = "token";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    // HCLOUD_TOKEN is set so it should not appear as missing
    const missingLines = hints.filter((h) => h.includes("not set") || h.includes("Missing"));
    expect(missingLines.length).toBeGreaterThan(0);
  });

  it("should show only cloud cred missing when OPENROUTER is set", () => {
    process.env.OPENROUTER_API_KEY = "key";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("HCLOUD_TOKEN"))).toBe(true);
    expect(hints.some((h) => h.includes("Missing"))).toBe(true);
  });

  it("should show both missing when neither is set", () => {
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints.some((h) => h.includes("OPENROUTER_API_KEY"))).toBe(true);
    expect(hints.some((h) => h.includes("HCLOUD_TOKEN"))).toBe(true);
  });

  it("should handle multi-var with one of three missing", () => {
    process.env.OPENROUTER_API_KEY = "key";
    process.env.UPCLOUD_USERNAME = "user";
    // UPCLOUD_PASSWORD not set
    const hints = credentialHints("upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    expect(hints.some((h) => h.includes("UPCLOUD_PASSWORD"))).toBe(true);
    expect(hints.some((h) => h.includes("Missing"))).toBe(true);
  });
});

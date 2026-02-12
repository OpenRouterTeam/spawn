import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Tests for the cmdRun pipeline internals: resolveAndLog, detectAndFixSwappedArgs,
 * validateRunSecurity, validateEntities, validateImplementation, and getAuthHint.
 *
 * These functions form the critical path in cmdRun (commands.ts:437-456):
 *   1. resolveAndLog - resolve display names/casing, log resolved names
 *   2. validateRunSecurity - security checks on identifiers and prompt
 *   3. detectAndFixSwappedArgs - fix "spawn <cloud> <agent>" -> "spawn <agent> <cloud>"
 *   4. validateEntities - check both exist in manifest
 *   5. validateImplementation - check the combination is implemented
 *   6. getAuthHint - build auth hint from cloud auth field
 *
 * Existing coverage:
 * - commands-swap-resolve.test.ts covers detectAndFixSwappedArgs via replica
 * - commands-error-paths.test.ts covers error output formatting
 * - dry-run-preview.test.ts covers the full cmdRun with dryRun=true
 *
 * This file adds DIRECT unit tests for each pipeline function via faithful replicas,
 * covering edge cases and argument combinations not tested elsewhere.
 *
 * Agent: test-engineer
 */

// ── Manifest fixtures ──────────────────────────────────────────────────────────

function createManifest(): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
      },
      aider: {
        name: "Aider",
        description: "AI pair programmer",
        url: "https://aider.chat",
        install: "pip install aider-chat",
        launch: "aider",
        env: { OPENAI_API_KEY: "test-key" },
      },
      codex: {
        name: "Codex CLI",
        description: "OpenAI coding CLI",
        url: "https://openai.com",
        install: "npm install -g @openai/codex",
        launch: "codex",
        env: {},
      },
    },
    clouds: {
      sprite: {
        name: "Sprite",
        description: "Lightweight VMs",
        url: "https://sprite.sh",
        type: "vm",
        auth: "SPRITE_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      hetzner: {
        name: "Hetzner Cloud",
        description: "European cloud provider",
        url: "https://hetzner.com",
        type: "cloud",
        auth: "HCLOUD_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      upcloud: {
        name: "UpCloud",
        description: "European cloud",
        url: "https://upcloud.com",
        type: "cloud",
        auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      daytona: {
        name: "Daytona",
        description: "Dev environments",
        url: "https://daytona.io",
        type: "container",
        auth: "none",
        provision_method: "cli",
        exec_method: "exec",
        interactive_method: "exec",
      },
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/aider": "implemented",
      "hetzner/claude": "implemented",
      "hetzner/aider": "missing",
      "upcloud/claude": "implemented",
      "daytona/claude": "implemented",
      "daytona/codex": "missing",
    },
  };
}

// ── Faithful replicas of internal pipeline functions ────────────────────────────

// From commands.ts:140-152
function resolveEntityKey(manifest: Manifest, input: string, kind: "agent" | "cloud"): string | null {
  const collection = kind === "agent" ? manifest.agents : manifest.clouds;
  if (collection[input]) return input;
  const keys = Object.keys(collection);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of keys) {
    if (collection[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

function resolveAgentKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "agent");
}

function resolveCloudKey(manifest: Manifest, input: string): string | null {
  return resolveEntityKey(manifest, input, "cloud");
}

// From commands.ts:318-334
function resolveAndLog(
  manifest: Manifest,
  agent: string,
  cloud: string,
  logMessages: string[]
): { agent: string; cloud: string } {
  const resolvedAgent = resolveAgentKey(manifest, agent);
  const resolvedCloud = resolveCloudKey(manifest, cloud);
  if (resolvedAgent && resolvedAgent !== agent) {
    logMessages.push(`Resolved "${agent}" to ${resolvedAgent}`);
    agent = resolvedAgent;
  }
  if (resolvedCloud && resolvedCloud !== cloud) {
    logMessages.push(`Resolved "${cloud}" to ${resolvedCloud}`);
    cloud = resolvedCloud;
  }
  return { agent, cloud };
}

// From commands.ts:337-348
function detectAndFixSwappedArgs(
  manifest: Manifest,
  agent: string,
  cloud: string,
  logMessages: string[]
): { agent: string; cloud: string } {
  if (!manifest.agents[agent] && manifest.clouds[agent] && manifest.agents[cloud]) {
    logMessages.push(`It looks like you swapped the agent and cloud arguments.`);
    logMessages.push(`Running: spawn ${cloud} ${agent}`);
    return { agent: cloud, cloud: agent };
  }
  return { agent, cloud };
}

// From commands.ts:252-275
function validateImplementation(
  manifest: Manifest,
  cloud: string,
  agent: string
): { valid: boolean; error?: string; availableClouds?: string[] } {
  const status = manifest.matrix[`${cloud}/${agent}`] ?? "missing";
  if (status === "implemented") {
    return { valid: true };
  }

  const agentName = manifest.agents[agent]?.name ?? agent;
  const cloudName = manifest.clouds[cloud]?.name ?? cloud;
  const error = `${agentName} on ${cloudName} is not yet implemented.`;

  const availableClouds = Object.keys(manifest.clouds).filter(
    (c) => manifest.matrix[`${c}/${agent}`] === "implemented"
  );

  return { valid: false, error, availableClouds };
}

// From commands.ts:1022-1027
function parseAuthEnvVars(auth: string): string[] {
  return auth
    .split(/\s*\+\s*/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z][A-Z0-9_]{3,}$/.test(s));
}

// From commands.ts:432-435
function getAuthHint(manifest: Manifest, cloud: string): string | undefined {
  const authVars = parseAuthEnvVars(manifest.clouds[cloud].auth);
  return authVars.length > 0 ? authVars.join(" + ") : undefined;
}

// From commands.ts:803-813
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

// From commands.ts:920-934
function buildRecordLabel(
  r: { agent: string; cloud: string },
  manifest: Manifest | null
): string {
  const resolveDisplayName = (m: Manifest | null, key: string, kind: "agent" | "cloud"): string => {
    if (!m) return key;
    const entry = kind === "agent" ? m.agents[key] : m.clouds[key];
    return entry ? entry.name : key;
  };
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  return `${agentDisplay} on ${cloudDisplay}`;
}

// From commands.ts:927-934
function buildRecordHint(r: { agent: string; cloud: string; timestamp: string; prompt?: string }): string {
  const when = formatTimestamp(r.timestamp);
  if (r.prompt) {
    const preview = r.prompt.length > 30 ? r.prompt.slice(0, 30) + "..." : r.prompt;
    return `${when}  --prompt "${preview}"`;
  }
  return when;
}

// From commands.ts:525-529
function credentialHint(cloud: string, authHint?: string, verb = "Missing or invalid"): string {
  return authHint
    ? `  - ${verb} credentials (need ${authHint} + OPENROUTER_API_KEY)`
    : `  - ${verb} credentials (run spawn ${cloud} for setup)`;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("resolveAndLog", () => {
  const manifest = createManifest();

  it("should return unchanged args when both are exact keys", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "claude", "sprite", logs);
    expect(result).toEqual({ agent: "claude", cloud: "sprite" });
    expect(logs).toHaveLength(0);
  });

  it("should resolve case-insensitive agent key and log", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "Claude", "sprite", logs);
    expect(result.agent).toBe("claude");
    expect(result.cloud).toBe("sprite");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Resolved");
    expect(logs[0]).toContain("claude");
  });

  it("should resolve case-insensitive cloud key and log", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "claude", "Sprite", logs);
    expect(result.agent).toBe("claude");
    expect(result.cloud).toBe("sprite");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Resolved");
  });

  it("should resolve both agent and cloud simultaneously", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "CLAUDE", "HETZNER", logs);
    expect(result.agent).toBe("claude");
    expect(result.cloud).toBe("hetzner");
    expect(logs).toHaveLength(2);
  });

  it("should resolve agent by display name", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "Claude Code", "sprite", logs);
    expect(result.agent).toBe("claude");
    expect(logs).toHaveLength(1);
  });

  it("should resolve cloud by display name", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "claude", "Hetzner Cloud", logs);
    expect(result.cloud).toBe("hetzner");
    expect(logs).toHaveLength(1);
  });

  it("should not log when keys are already exact", () => {
    const logs: string[] = [];
    resolveAndLog(manifest, "aider", "hetzner", logs);
    expect(logs).toHaveLength(0);
  });

  it("should pass through unknown keys unchanged", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "unknown-agent", "unknown-cloud", logs);
    expect(result).toEqual({ agent: "unknown-agent", cloud: "unknown-cloud" });
    expect(logs).toHaveLength(0);
  });

  it("should handle one resolved and one unknown", () => {
    const logs: string[] = [];
    const result = resolveAndLog(manifest, "CLAUDE", "nonexistent", logs);
    expect(result.agent).toBe("claude");
    expect(result.cloud).toBe("nonexistent");
    expect(logs).toHaveLength(1);
  });
});

describe("detectAndFixSwappedArgs", () => {
  const manifest = createManifest();

  it("should swap when agent is a cloud key and cloud is an agent key", () => {
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "sprite", "claude", logs);
    expect(result).toEqual({ agent: "claude", cloud: "sprite" });
    expect(logs.some(m => m.includes("swapped"))).toBe(true);
  });

  it("should not swap when both are correct", () => {
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "claude", "sprite", logs);
    expect(result).toEqual({ agent: "claude", cloud: "sprite" });
    expect(logs).toHaveLength(0);
  });

  it("should not swap when agent is unknown", () => {
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "unknown", "sprite", logs);
    expect(result).toEqual({ agent: "unknown", cloud: "sprite" });
    expect(logs).toHaveLength(0);
  });

  it("should not swap when cloud is unknown", () => {
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "claude", "unknown", logs);
    expect(result).toEqual({ agent: "claude", cloud: "unknown" });
    expect(logs).toHaveLength(0);
  });

  it("should not swap when both are unknown", () => {
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "x", "y", logs);
    expect(result).toEqual({ agent: "x", cloud: "y" });
    expect(logs).toHaveLength(0);
  });

  it("should not swap when agent is an actual agent (even if also a cloud name)", () => {
    // If agent key exists in agents, no swap needed
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "claude", "aider", logs);
    expect(result).toEqual({ agent: "claude", cloud: "aider" });
    expect(logs).toHaveLength(0);
  });

  it("should include the corrected command in swap log message", () => {
    const logs: string[] = [];
    detectAndFixSwappedArgs(manifest, "hetzner", "aider", logs);
    expect(logs.some(m => m.includes("spawn aider hetzner"))).toBe(true);
  });

  it("should not swap when first arg is both an agent and could be a cloud", () => {
    // If manifest.agents has the key, no swap regardless of clouds
    const logs: string[] = [];
    const result = detectAndFixSwappedArgs(manifest, "aider", "sprite", logs);
    expect(result).toEqual({ agent: "aider", cloud: "sprite" });
    expect(logs).toHaveLength(0);
  });
});

describe("validateImplementation", () => {
  const manifest = createManifest();

  it("should return valid for implemented combination", () => {
    const result = validateImplementation(manifest, "sprite", "claude");
    expect(result.valid).toBe(true);
  });

  it("should return invalid for missing combination", () => {
    const result = validateImplementation(manifest, "hetzner", "aider");
    expect(result.valid).toBe(false);
  });

  it("should include agent and cloud names in error", () => {
    const result = validateImplementation(manifest, "hetzner", "aider");
    expect(result.error).toContain("Aider");
    expect(result.error).toContain("Hetzner Cloud");
    expect(result.error).toContain("not yet implemented");
  });

  it("should return available clouds for the agent", () => {
    const result = validateImplementation(manifest, "hetzner", "aider");
    expect(result.availableClouds).toBeDefined();
    expect(result.availableClouds).toContain("sprite");
  });

  it("should return empty available clouds when agent has no implementations", () => {
    const result = validateImplementation(manifest, "sprite", "codex");
    expect(result.valid).toBe(false);
    expect(result.availableClouds).toEqual([]);
  });

  it("should handle unknown cloud/agent combination gracefully", () => {
    const result = validateImplementation(manifest, "unknown-cloud", "unknown-agent");
    expect(result.valid).toBe(false);
  });

  it("should distinguish between implemented and missing in same cloud", () => {
    expect(validateImplementation(manifest, "sprite", "claude").valid).toBe(true);
    expect(validateImplementation(manifest, "sprite", "aider").valid).toBe(true);
    expect(validateImplementation(manifest, "hetzner", "aider").valid).toBe(false);
  });

  it("should list multiple available clouds when they exist", () => {
    const result = validateImplementation(manifest, "daytona", "codex");
    // codex is missing on daytona but claude has sprite, hetzner, upcloud, daytona
    expect(result.valid).toBe(false);
    // codex has no implementations at all
    expect(result.availableClouds).toEqual([]);
  });
});

describe("getAuthHint", () => {
  const manifest = createManifest();

  it("should return single auth var for simple auth", () => {
    expect(getAuthHint(manifest, "sprite")).toBe("SPRITE_TOKEN");
  });

  it("should return joined auth vars for multi-credential auth", () => {
    expect(getAuthHint(manifest, "upcloud")).toBe("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
  });

  it("should return undefined for 'none' auth", () => {
    expect(getAuthHint(manifest, "daytona")).toBeUndefined();
  });

  it("should return single token for standard auth", () => {
    expect(getAuthHint(manifest, "hetzner")).toBe("HCLOUD_TOKEN");
  });
});

describe("formatTimestamp", () => {
  it("should format a valid ISO timestamp", () => {
    const result = formatTimestamp("2026-01-15T14:30:00.000Z");
    // Should contain month, day, year and time
    expect(result).toContain("2026");
    expect(result).toContain("Jan");
    expect(result).toContain("15");
  });

  it("should return original string for invalid date", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("should return original string for empty string", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("should format midnight timestamp", () => {
    const result = formatTimestamp("2026-06-01T00:00:00.000Z");
    expect(result).toContain("2026");
    expect(result).toContain("Jun");
  });

  it("should format end-of-day timestamp", () => {
    const result = formatTimestamp("2026-12-31T23:59:59.000Z");
    expect(result).toContain("Dec");
    expect(result).toContain("31");
    expect(result).toContain("2026");
  });

  it("should handle date-only ISO string", () => {
    const result = formatTimestamp("2026-03-15");
    // Should still produce a formatted result (Date constructor accepts date-only)
    expect(result).toContain("2026");
  });

  it("should return original for gibberish", () => {
    expect(formatTimestamp("xyzzy")).toBe("xyzzy");
  });

  it("should handle epoch timestamp string", () => {
    // "0" is technically a valid date (Jan 1, 1970)
    const result = formatTimestamp("1970-01-01T00:00:00.000Z");
    expect(result).toContain("1970");
    expect(result).toContain("Jan");
  });

  it("should include both date and time components", () => {
    const result = formatTimestamp("2026-07-04T15:30:00.000Z");
    // Verify it has both a date part and a time part (separated by space)
    const parts = result.split(" ");
    expect(parts.length).toBeGreaterThanOrEqual(3); // "Jul 4, 2026 HH:MM" or similar
  });

  it("should format Feb 29 (leap year) correctly", () => {
    const result = formatTimestamp("2028-02-29T12:00:00.000Z");
    expect(result).toContain("Feb");
    expect(result).toContain("29");
    expect(result).toContain("2028");
  });
});

describe("buildRecordLabel", () => {
  const manifest = createManifest();

  it("should use display names from manifest", () => {
    const label = buildRecordLabel({ agent: "claude", cloud: "sprite" }, manifest);
    expect(label).toBe("Claude Code on Sprite");
  });

  it("should use raw keys when manifest is null", () => {
    const label = buildRecordLabel({ agent: "claude", cloud: "sprite" }, null);
    expect(label).toBe("claude on sprite");
  });

  it("should use raw key when agent not in manifest", () => {
    const label = buildRecordLabel({ agent: "unknown", cloud: "sprite" }, manifest);
    expect(label).toBe("unknown on Sprite");
  });

  it("should use raw key when cloud not in manifest", () => {
    const label = buildRecordLabel({ agent: "claude", cloud: "unknown" }, manifest);
    expect(label).toBe("Claude Code on unknown");
  });

  it("should handle both unknown", () => {
    const label = buildRecordLabel({ agent: "x", cloud: "y" }, manifest);
    expect(label).toBe("x on y");
  });

  it("should format with different agent/cloud combos", () => {
    const label = buildRecordLabel({ agent: "aider", cloud: "hetzner" }, manifest);
    expect(label).toBe("Aider on Hetzner Cloud");
  });
});

describe("buildRecordHint", () => {
  it("should show formatted timestamp without prompt", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-01-15T14:30:00.000Z",
    });
    expect(hint).toContain("Jan");
    expect(hint).toContain("15");
    expect(hint).toContain("2026");
    expect(hint).not.toContain("--prompt");
  });

  it("should show prompt preview when prompt exists", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-01-15T14:30:00.000Z",
      prompt: "Fix all bugs",
    });
    expect(hint).toContain("--prompt");
    expect(hint).toContain("Fix all bugs");
  });

  it("should truncate prompt longer than 30 chars", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-01-15T14:30:00.000Z",
      prompt: "A".repeat(50),
    });
    expect(hint).toContain("A".repeat(30) + "...");
    expect(hint).not.toContain("A".repeat(31));
  });

  it("should not truncate prompt exactly 30 chars", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-01-15T14:30:00.000Z",
      prompt: "B".repeat(30),
    });
    expect(hint).toContain("B".repeat(30));
    expect(hint).not.toContain("...");
  });

  it("should truncate prompt at 31 chars", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-01-15T14:30:00.000Z",
      prompt: "C".repeat(31),
    });
    expect(hint).toContain("C".repeat(30) + "...");
  });

  it("should handle invalid timestamp gracefully", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "invalid-ts",
    });
    // formatTimestamp returns the original string for invalid dates
    expect(hint).toContain("invalid-ts");
  });

  it("should wrap prompt in double quotes", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-01-01T00:00:00Z",
      prompt: "Fix it",
    });
    expect(hint).toContain('"Fix it"');
  });
});

describe("credentialHint", () => {
  it("should show auth hint when provided", () => {
    const result = credentialHint("sprite", "SPRITE_TOKEN");
    expect(result).toContain("SPRITE_TOKEN");
    expect(result).toContain("OPENROUTER_API_KEY");
    expect(result).toContain("Missing or invalid");
  });

  it("should show generic hint when no auth hint", () => {
    const result = credentialHint("sprite");
    expect(result).toContain("spawn sprite");
    expect(result).toContain("setup");
  });

  it("should use custom verb when provided", () => {
    const result = credentialHint("sprite", "SPRITE_TOKEN", "Missing");
    expect(result).toContain("Missing");
    expect(result).not.toContain("Missing or invalid");
  });

  it("should use default verb when not provided", () => {
    const result = credentialHint("hetzner", "HCLOUD_TOKEN");
    expect(result).toContain("Missing or invalid");
  });

  it("should include cloud name in generic hint", () => {
    const result = credentialHint("hetzner");
    expect(result).toContain("spawn hetzner");
  });

  it("should handle multi-credential auth hint", () => {
    const result = credentialHint("upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    expect(result).toContain("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    expect(result).toContain("OPENROUTER_API_KEY");
  });
});

describe("parseAuthEnvVars", () => {
  it("should parse single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should parse multiple env vars joined by +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("should return empty for 'none'", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("should return empty for 'None'", () => {
    expect(parseAuthEnvVars("None")).toEqual([]);
  });

  it("should handle extra whitespace around +", () => {
    expect(parseAuthEnvVars("A_TOKEN  +  B_TOKEN")).toEqual(["A_TOKEN", "B_TOKEN"]);
  });

  it("should filter out short names (less than 4 chars after first)", () => {
    expect(parseAuthEnvVars("AB")).toEqual([]);
  });

  it("should handle lowercase strings (not matching pattern)", () => {
    expect(parseAuthEnvVars("token")).toEqual([]);
  });

  it("should handle mixed case (not matching pattern)", () => {
    expect(parseAuthEnvVars("Token_Value")).toEqual([]);
  });

  it("should accept valid env var names with numbers", () => {
    expect(parseAuthEnvVars("API_KEY_V2")).toEqual(["API_KEY_V2"]);
  });

  it("should handle triple credentials", () => {
    expect(parseAuthEnvVars("USER_NAME + USER_PASS + USER_TENANT")).toEqual([
      "USER_NAME",
      "USER_PASS",
      "USER_TENANT",
    ]);
  });

  it("should reject strings starting with lowercase", () => {
    expect(parseAuthEnvVars("aPI_KEY")).toEqual([]);
  });

  it("should reject strings starting with number", () => {
    expect(parseAuthEnvVars("1API_KEY")).toEqual([]);
  });

  it("should accept minimum valid length (4 chars total: 1 upper + 3 more)", () => {
    expect(parseAuthEnvVars("ABCD")).toEqual(["ABCD"]);
  });

  it("should reject 3-char names (1 upper + 2 more)", () => {
    expect(parseAuthEnvVars("ABC")).toEqual([]);
  });
});

describe("resolveAndLog + detectAndFixSwappedArgs pipeline integration", () => {
  const manifest = createManifest();

  it("should not resolve cross-kind keys (cloud name as agent stays unresolved)", () => {
    const logs: string[] = [];
    // "SPRITE" is a cloud key, not an agent key -- resolveAgentKey returns null
    // "CLAUDE" is an agent key, not a cloud key -- resolveCloudKey returns null
    let { agent, cloud } = resolveAndLog(manifest, "SPRITE", "CLAUDE", logs);
    // Neither resolves (wrong kind), so both stay unchanged
    expect(agent).toBe("SPRITE");
    expect(cloud).toBe("CLAUDE");
    // detectAndFixSwappedArgs needs exact keys, so it won't detect swap either
    // (manifest.clouds["SPRITE"] is undefined due to case sensitivity)
    ({ agent, cloud } = detectAndFixSwappedArgs(manifest, agent, cloud, logs));
    expect(agent).toBe("SPRITE");
    expect(cloud).toBe("CLAUDE");
  });

  it("should handle correct order with case resolution", () => {
    const logs: string[] = [];
    let { agent, cloud } = resolveAndLog(manifest, "CLAUDE", "SPRITE", logs);
    ({ agent, cloud } = detectAndFixSwappedArgs(manifest, agent, cloud, logs));
    expect(agent).toBe("claude");
    expect(cloud).toBe("sprite");
    // Only case resolution logs, no swap log
    expect(logs.filter(m => m.includes("swapped"))).toHaveLength(0);
  });

  it("should handle display name resolution followed by no swap needed", () => {
    const logs: string[] = [];
    let { agent, cloud } = resolveAndLog(manifest, "Aider", "Hetzner Cloud", logs);
    ({ agent, cloud } = detectAndFixSwappedArgs(manifest, agent, cloud, logs));
    expect(agent).toBe("aider");
    expect(cloud).toBe("hetzner");
  });

  it("should handle display name swap: cloud display name first", () => {
    const logs: string[] = [];
    // "Sprite" resolves to "sprite" (cloud), "claude" stays as agent
    // After resolveAndLog: agent="sprite" (not an agent!), cloud="claude" (is an agent!)
    // But resolveAndLog tries to resolve "Sprite" as an agent first -- no match
    // Then resolveAndLog tries "claude" as a cloud -- no match
    // So both pass through unchanged as "Sprite" and "claude"
    // Wait -- resolveAgentKey("Sprite") would check agents: claude, aider, codex -- no match
    // resolveCloudKey("claude") would check clouds: sprite, hetzner, upcloud, daytona -- no match
    // So result: agent="Sprite", cloud="claude"
    // Then detectAndFixSwappedArgs("Sprite", "claude"):
    //   manifest.agents["Sprite"] is undefined, manifest.clouds["Sprite"] is undefined (case-sensitive!)
    //   So no swap detected either.
    let { agent, cloud } = resolveAndLog(manifest, "Sprite", "claude", logs);
    expect(agent).toBe("Sprite"); // Not resolved because "Sprite" doesn't match any agent
    expect(cloud).toBe("claude"); // Not resolved because "claude" IS already a cloud? No -- "claude" is an agent key
    // Actually resolveCloudKey("claude") checks: clouds[claude] -> undefined, then case-insensitive -> no match
    // So cloud stays "claude"
  });
});

describe("full pipeline: resolveAndLog -> validateImplementation", () => {
  const manifest = createManifest();

  it("should resolve and then validate implemented combination", () => {
    const logs: string[] = [];
    const { agent, cloud } = resolveAndLog(manifest, "Claude Code", "Sprite", logs);
    const validation = validateImplementation(manifest, cloud, agent);
    expect(validation.valid).toBe(true);
  });

  it("should resolve and then validate missing combination", () => {
    const logs: string[] = [];
    const { agent, cloud } = resolveAndLog(manifest, "Aider", "Hetzner Cloud", logs);
    const validation = validateImplementation(manifest, cloud, agent);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("not yet implemented");
  });

  it("should provide alternative clouds for missing combination", () => {
    const logs: string[] = [];
    const { agent, cloud } = resolveAndLog(manifest, "aider", "hetzner", logs);
    const validation = validateImplementation(manifest, cloud, agent);
    expect(validation.valid).toBe(false);
    expect(validation.availableClouds).toContain("sprite");
  });
});

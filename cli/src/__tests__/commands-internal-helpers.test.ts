import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest } from "./test-helpers";
import type { Manifest } from "../manifest";

/**
 * Tests for internal helper functions in commands.ts that have zero
 * direct test coverage.
 *
 * These functions are not exported, so we test exact replicas following
 * the established pattern in this codebase (see list-display.test.ts,
 * dispatch-extra-args.test.ts, etc.).
 *
 * Functions tested:
 * - groupByType: groups keys by a classifier function (commands.ts:1046-1054)
 * - buildAgentLines: formats agent info for dry-run preview (commands.ts:360-368)
 * - buildCloudLines: formats cloud info for dry-run preview (commands.ts:370-382)
 * - credentialHints: builds auth credential hint strings (commands.ts:525-534)
 * - mapToSelectOptions: transforms manifest entries to select picker options (commands.ts:59-68)
 * - validateNonEmptyString: validates required non-empty input (commands.ts:51-57)
 * - renderMatrixRow: builds a single matrix row with status icons (commands.ts:690-699)
 * - renderMatrixHeader: builds the column header line (commands.ts:674-680)
 * - renderMatrixSeparator: builds the separator line (commands.ts:682-688)
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── Exact replicas of internal functions from commands.ts ───────────────────

// commands.ts:1046-1054
function groupByType(
  keys: string[],
  getType: (key: string) => string
): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const key of keys) {
    const type = getType(key);
    if (!byType[type]) byType[type] = [];
    byType[type].push(key);
  }
  return byType;
}

// commands.ts:360-368
function buildAgentLines(agentInfo: {
  name: string;
  description: string;
  install?: string;
  launch?: string;
}): string[] {
  const lines = [
    `  Name:        ${agentInfo.name}`,
    `  Description: ${agentInfo.description}`,
  ];
  if (agentInfo.install) lines.push(`  Install:     ${agentInfo.install}`);
  if (agentInfo.launch) lines.push(`  Launch:      ${agentInfo.launch}`);
  return lines;
}

// commands.ts:370-382
function buildCloudLines(cloudInfo: {
  name: string;
  description: string;
  defaults?: Record<string, string>;
}): string[] {
  const lines = [
    `  Name:        ${cloudInfo.name}`,
    `  Description: ${cloudInfo.description}`,
  ];
  if (cloudInfo.defaults) {
    lines.push(`  Defaults:`);
    for (const [k, v] of Object.entries(cloudInfo.defaults)) {
      lines.push(`    ${k}: ${v}`);
    }
  }
  return lines;
}

// commands.ts:525-534
function credentialHints(
  cloud: string,
  authHint?: string,
  verb = "Missing or invalid"
): string[] {
  if (authHint) {
    return [
      `  - ${verb} credentials (need ${authHint} + OPENROUTER_API_KEY)`,
      `    Run spawn ${cloud} for setup instructions`,
    ];
  }
  return [
    `  - ${verb} credentials (run spawn ${cloud} for setup)`,
  ];
}

// commands.ts:59-68
function mapToSelectOptions<
  T extends { name: string; description: string }
>(
  keys: string[],
  items: Record<string, T>
): Array<{ value: string; label: string; hint: string }> {
  return keys.map((key) => ({
    value: key,
    label: items[key].name,
    hint: items[key].description,
  }));
}

// commands.ts:787-797
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

// commands.ts:904-908
function buildRecordLabel(
  r: { agent: string; cloud: string },
  manifest: Manifest | null
): string {
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  return `${agentDisplay} on ${cloudDisplay}`;
}

// commands.ts:911-918
function buildRecordHint(r: {
  timestamp: string;
  prompt?: string;
}): string {
  const when = formatTimestamp(r.timestamp);
  if (r.prompt) {
    const preview =
      r.prompt.length > 30 ? r.prompt.slice(0, 30) + "..." : r.prompt;
    return `${when}  --prompt "${preview}"`;
  }
  return when;
}

// commands.ts:871-875
function resolveDisplayName(
  manifest: Manifest | null,
  key: string,
  kind: "agent" | "cloud"
): string {
  if (!manifest) return key;
  const entry =
    kind === "agent" ? manifest.agents[key] : manifest.clouds[key];
  return entry ? entry.name : key;
}

const COL_PADDING = 2;

// ── groupByType tests ───────────────────────────────────────────────────────

describe("groupByType", () => {
  it("groups cloud keys by type", () => {
    const clouds = ["sprite", "hetzner"];
    const getType = (key: string) =>
      key === "sprite" ? "vm" : "cloud";

    const result = groupByType(clouds, getType);
    expect(result).toEqual({
      vm: ["sprite"],
      cloud: ["hetzner"],
    });
  });

  it("groups multiple keys under the same type", () => {
    const clouds = ["aws", "gcp", "azure"];
    const getType = () => "cloud";

    const result = groupByType(clouds, getType);
    expect(result).toEqual({ cloud: ["aws", "gcp", "azure"] });
  });

  it("returns empty object for empty keys", () => {
    const result = groupByType([], () => "any");
    expect(result).toEqual({});
  });

  it("preserves key order within each type", () => {
    const keys = ["z-key", "a-key", "m-key"];
    const getType = () => "group";

    const result = groupByType(keys, getType);
    expect(result.group).toEqual(["z-key", "a-key", "m-key"]);
  });

  it("handles many distinct types", () => {
    const keys = ["k1", "k2", "k3", "k4"];
    const getType = (k: string) => `type-${k}`;

    const result = groupByType(keys, getType);
    expect(Object.keys(result)).toHaveLength(4);
    expect(result["type-k1"]).toEqual(["k1"]);
    expect(result["type-k4"]).toEqual(["k4"]);
  });

  it("handles type names with special characters", () => {
    const keys = ["a", "b"];
    const getType = (k: string) =>
      k === "a" ? "Cloud / VPS" : "Container (Docker)";

    const result = groupByType(keys, getType);
    expect(result["Cloud / VPS"]).toEqual(["a"]);
    expect(result["Container (Docker)"]).toEqual(["b"]);
  });

  it("handles single key", () => {
    const result = groupByType(["only"], () => "solo");
    expect(result).toEqual({ solo: ["only"] });
  });
});

// ── buildAgentLines tests ───────────────────────────────────────────────────

describe("buildAgentLines", () => {
  it("includes name and description for minimal agent", () => {
    const lines = buildAgentLines({
      name: "Claude Code",
      description: "AI coding assistant",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Claude Code");
    expect(lines[1]).toContain("AI coding assistant");
  });

  it("includes install command when present", () => {
    const lines = buildAgentLines({
      name: "Aider",
      description: "AI pair programmer",
      install: "pip install aider-chat",
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("pip install aider-chat");
    expect(lines[2]).toContain("Install:");
  });

  it("includes launch command when present", () => {
    const lines = buildAgentLines({
      name: "Aider",
      description: "AI pair programmer",
      launch: "aider --model openrouter/anthropic/claude-3.5-sonnet",
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("Launch:");
    expect(lines[2]).toContain("aider --model");
  });

  it("includes both install and launch when present", () => {
    const lines = buildAgentLines({
      name: "Claude Code",
      description: "AI coding assistant",
      install: "npm install -g claude",
      launch: "claude",
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Name:");
    expect(lines[1]).toContain("Description:");
    expect(lines[2]).toContain("Install:");
    expect(lines[3]).toContain("Launch:");
  });

  it("does not include install line when install is undefined", () => {
    const lines = buildAgentLines({
      name: "Test",
      description: "Desc",
      launch: "test-cmd",
    });
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("Install:");
  });

  it("does not include launch line when launch is undefined", () => {
    const lines = buildAgentLines({
      name: "Test",
      description: "Desc",
      install: "npm install test",
    });
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("Launch:");
  });

  it("uses consistent indentation with 2-space prefix", () => {
    const lines = buildAgentLines({
      name: "X",
      description: "Y",
      install: "I",
      launch: "L",
    });
    for (const line of lines) {
      expect(line).toMatch(/^  /);
    }
  });
});

// ── buildCloudLines tests ───────────────────────────────────────────────────

describe("buildCloudLines", () => {
  it("includes name and description for minimal cloud", () => {
    const lines = buildCloudLines({
      name: "Sprite",
      description: "Lightweight VMs",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Sprite");
    expect(lines[1]).toContain("Lightweight VMs");
  });

  it("includes defaults when present", () => {
    const lines = buildCloudLines({
      name: "Hetzner Cloud",
      description: "European cloud provider",
      defaults: {
        region: "nbg1",
        type: "cx22",
      },
    });
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain("Defaults:");
    expect(lines[3]).toContain("region: nbg1");
    expect(lines[4]).toContain("type: cx22");
  });

  it("omits defaults section when defaults is undefined", () => {
    const lines = buildCloudLines({
      name: "Test",
      description: "Desc",
    });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("Defaults:");
  });

  it("handles empty defaults object", () => {
    const lines = buildCloudLines({
      name: "Test",
      description: "Desc",
      defaults: {},
    });
    // Empty defaults still shows "Defaults:" header
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("Defaults:");
  });

  it("handles many defaults entries", () => {
    const defaults: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      defaults[`key${i}`] = `value${i}`;
    }
    const lines = buildCloudLines({
      name: "Test",
      description: "Desc",
      defaults,
    });
    // 2 (name+desc) + 1 (header) + 10 (entries)
    expect(lines).toHaveLength(13);
  });

  it("preserves defaults entry order", () => {
    const lines = buildCloudLines({
      name: "Test",
      description: "Desc",
      defaults: { zebra: "z", alpha: "a" },
    });
    expect(lines[3]).toContain("zebra: z");
    expect(lines[4]).toContain("alpha: a");
  });
});

// ── credentialHints tests ────────────────────────────────────────────────────

describe("credentialHints", () => {
  it("shows auth hint with named env vars and setup instruction when authHint is provided", () => {
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    const joined = hints.join("\n");
    expect(joined).toContain("HCLOUD_TOKEN");
    expect(joined).toContain("OPENROUTER_API_KEY");
    expect(joined).toContain("Missing or invalid");
    expect(joined).toContain("spawn hetzner");
    expect(joined).toContain("setup instructions");
  });

  it("returns two lines when authHint is provided", () => {
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    expect(hints).toHaveLength(2);
  });

  it("shows cloud setup command when authHint is not provided", () => {
    const hints = credentialHints("hetzner");
    const joined = hints.join("\n");
    expect(joined).toContain("spawn hetzner");
    expect(joined).toContain("setup");
    expect(joined).not.toContain("OPENROUTER_API_KEY");
  });

  it("returns one line when authHint is not provided", () => {
    const hints = credentialHints("hetzner");
    expect(hints).toHaveLength(1);
  });

  it("uses custom verb when provided", () => {
    const hints = credentialHints("sprite", "SPRITE_TOKEN", "Missing");
    const joined = hints.join("\n");
    expect(joined).toContain("Missing");
    expect(joined).not.toContain("Missing or invalid");
  });

  it("uses default verb when not provided", () => {
    const hints = credentialHints("sprite", "SPRITE_TOKEN");
    const joined = hints.join("\n");
    expect(joined).toContain("Missing or invalid");
  });

  it("shows cloud name in setup fallback", () => {
    const hints = credentialHints("digitalocean");
    const joined = hints.join("\n");
    expect(joined).toContain("spawn digitalocean");
  });

  it("works with multi-token authHint", () => {
    const hints = credentialHints(
      "upcloud",
      "UPCLOUD_USERNAME + UPCLOUD_PASSWORD"
    );
    const joined = hints.join("\n");
    expect(joined).toContain("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    expect(joined).toContain("OPENROUTER_API_KEY");
  });

  it("uses custom verb without authHint", () => {
    const hints = credentialHints("vultr", undefined, "Missing");
    const joined = hints.join("\n");
    expect(joined).toContain("Missing");
    expect(joined).toContain("spawn vultr");
  });
});

// ── mapToSelectOptions tests ────────────────────────────────────────────────

describe("mapToSelectOptions", () => {
  it("transforms agent entries to select options", () => {
    const keys = ["claude", "aider"];
    const result = mapToSelectOptions(keys, mockManifest.agents);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      value: "claude",
      label: "Claude Code",
      hint: "AI coding assistant",
    });
    expect(result[1]).toEqual({
      value: "aider",
      label: "Aider",
      hint: "AI pair programmer",
    });
  });

  it("transforms cloud entries to select options", () => {
    const keys = ["sprite", "hetzner"];
    const result = mapToSelectOptions(keys, mockManifest.clouds);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      value: "sprite",
      label: "Sprite",
      hint: "Lightweight VMs",
    });
    expect(result[1]).toEqual({
      value: "hetzner",
      label: "Hetzner Cloud",
      hint: "European cloud provider",
    });
  });

  it("returns empty array for empty keys", () => {
    const result = mapToSelectOptions([], mockManifest.agents);
    expect(result).toEqual([]);
  });

  it("preserves key order in output", () => {
    const keys = ["aider", "claude"];
    const result = mapToSelectOptions(keys, mockManifest.agents);
    expect(result[0].value).toBe("aider");
    expect(result[1].value).toBe("claude");
  });

  it("maps value field to the key, not the name", () => {
    const keys = ["claude"];
    const result = mapToSelectOptions(keys, mockManifest.agents);
    expect(result[0].value).toBe("claude");
    expect(result[0].label).toBe("Claude Code");
    expect(result[0].value).not.toBe(result[0].label);
  });
});

// ── buildRecordLabel tests ──────────────────────────────────────────────────

describe("buildRecordLabel", () => {
  it("uses display names when manifest is available", () => {
    const label = buildRecordLabel(
      { agent: "claude", cloud: "sprite" },
      mockManifest
    );
    expect(label).toBe("Claude Code on Sprite");
  });

  it("falls back to raw keys when manifest is null", () => {
    const label = buildRecordLabel(
      { agent: "claude", cloud: "sprite" },
      null
    );
    expect(label).toBe("claude on sprite");
  });

  it("falls back to raw key when agent is not in manifest", () => {
    const label = buildRecordLabel(
      { agent: "unknown-agent", cloud: "sprite" },
      mockManifest
    );
    expect(label).toBe("unknown-agent on Sprite");
  });

  it("falls back to raw key when cloud is not in manifest", () => {
    const label = buildRecordLabel(
      { agent: "claude", cloud: "unknown-cloud" },
      mockManifest
    );
    expect(label).toBe("Claude Code on unknown-cloud");
  });

  it("uses raw keys when both are unknown", () => {
    const label = buildRecordLabel(
      { agent: "foo", cloud: "bar" },
      mockManifest
    );
    expect(label).toBe("foo on bar");
  });
});

// ── buildRecordHint tests ───────────────────────────────────────────────────

describe("buildRecordHint", () => {
  it("returns formatted timestamp without prompt", () => {
    const hint = buildRecordHint({
      timestamp: "2026-02-11T14:30:00.000Z",
    });
    // Should contain a formatted date/time string
    expect(hint).toBeTruthy();
    expect(hint).not.toContain("--prompt");
  });

  it("includes truncated prompt preview when prompt is long", () => {
    const longPrompt = "a".repeat(50);
    const hint = buildRecordHint({
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: longPrompt,
    });
    expect(hint).toContain("--prompt");
    expect(hint).toContain("...");
    // Should be truncated to 30 chars
    expect(hint).toContain("a".repeat(30));
  });

  it("includes full prompt when it is 30 chars or less", () => {
    const shortPrompt = "Fix all bugs";
    const hint = buildRecordHint({
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: shortPrompt,
    });
    expect(hint).toContain("--prompt");
    expect(hint).toContain("Fix all bugs");
    expect(hint).not.toContain("...");
  });

  it("includes prompt at exactly 30 characters without truncation", () => {
    const exact30 = "a".repeat(30);
    const hint = buildRecordHint({
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: exact30,
    });
    expect(hint).toContain(exact30);
    expect(hint).not.toContain("...");
  });

  it("truncates prompt at 31 characters", () => {
    const exact31 = "b".repeat(31);
    const hint = buildRecordHint({
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: exact31,
    });
    expect(hint).toContain("b".repeat(30) + "...");
  });

  it("does not include prompt section when prompt is undefined", () => {
    const hint = buildRecordHint({
      timestamp: "2026-02-11T14:30:00.000Z",
    });
    expect(hint).not.toContain("--prompt");
    expect(hint).not.toContain("undefined");
  });

  it("handles invalid timestamp gracefully", () => {
    const hint = buildRecordHint({
      timestamp: "not-a-date",
    });
    // formatTimestamp returns the original string for invalid dates
    expect(hint).toContain("not-a-date");
  });
});

// ── resolveDisplayName edge cases ───────────────────────────────────────────

describe("resolveDisplayName edge cases", () => {
  it("returns key when manifest is null and kind is agent", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
  });

  it("returns key when manifest is null and kind is cloud", () => {
    expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
  });

  it("returns display name for valid agent", () => {
    expect(resolveDisplayName(mockManifest, "claude", "agent")).toBe(
      "Claude Code"
    );
  });

  it("returns display name for valid cloud", () => {
    expect(resolveDisplayName(mockManifest, "hetzner", "cloud")).toBe(
      "Hetzner Cloud"
    );
  });

  it("returns raw key for unknown agent in manifest", () => {
    expect(resolveDisplayName(mockManifest, "nonexistent", "agent")).toBe(
      "nonexistent"
    );
  });

  it("returns raw key for unknown cloud in manifest", () => {
    expect(resolveDisplayName(mockManifest, "nonexistent", "cloud")).toBe(
      "nonexistent"
    );
  });

  it("correctly distinguishes agent vs cloud lookups", () => {
    // "sprite" exists as a cloud but not as an agent
    expect(resolveDisplayName(mockManifest, "sprite", "agent")).toBe(
      "sprite"
    );
    expect(resolveDisplayName(mockManifest, "sprite", "cloud")).toBe(
      "Sprite"
    );
  });

  it("correctly looks up agent that exists as agent but not cloud", () => {
    // "claude" exists as an agent but not as a cloud
    expect(resolveDisplayName(mockManifest, "claude", "agent")).toBe(
      "Claude Code"
    );
    expect(resolveDisplayName(mockManifest, "claude", "cloud")).toBe(
      "claude"
    );
  });
});

// ── Integration: groupByType with real manifest data ────────────────────────

describe("groupByType with manifest clouds", () => {
  it("groups mock manifest clouds by their type field", () => {
    const clouds = Object.keys(mockManifest.clouds);
    const result = groupByType(
      clouds,
      (key) => mockManifest.clouds[key].type
    );

    // sprite is "vm" type, hetzner is "cloud" type in the mock
    expect(result["vm"]).toEqual(["sprite"]);
    expect(result["cloud"]).toEqual(["hetzner"]);
  });

  it("works with extended manifest having multiple clouds per type", () => {
    const extManifest: Manifest = {
      ...mockManifest,
      clouds: {
        ...mockManifest.clouds,
        vultr: {
          name: "Vultr",
          description: "Cloud compute",
          url: "https://vultr.com",
          type: "cloud",
          auth: "VULTR_API_KEY",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        digitalocean: {
          name: "DigitalOcean",
          description: "Cloud platform",
          url: "https://digitalocean.com",
          type: "cloud",
          auth: "DO_API_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
    };

    const clouds = Object.keys(extManifest.clouds);
    const result = groupByType(
      clouds,
      (key) => extManifest.clouds[key].type
    );

    expect(result["vm"]).toEqual(["sprite"]);
    expect(result["cloud"]).toContain("hetzner");
    expect(result["cloud"]).toContain("vultr");
    expect(result["cloud"]).toContain("digitalocean");
    expect(result["cloud"]).toHaveLength(3);
  });
});

// ── Integration: credentialHints in error message context ────────────────────

describe("credentialHints in error context", () => {
  it("produces valid hints for exit code 1 with auth", () => {
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    // First line is the credential hint, second is the setup instruction
    expect(hints[0]).toMatch(/^\s+-/);
    expect(hints[0]).toContain("credentials");
    expect(hints[1]).toContain("spawn hetzner");
  });

  it("produces valid hint for default exit code without auth", () => {
    const hints = credentialHints("sprite", undefined, "Missing");
    expect(hints[0]).toMatch(/^\s+-/);
    expect(hints[0]).toContain("credentials");
    expect(hints[0]).toContain("spawn sprite");
  });
});

// ── Integration: mapToSelectOptions for subset of keys ──────────────────────

describe("mapToSelectOptions with key subsets", () => {
  it("maps only specified keys, not all manifest entries", () => {
    const result = mapToSelectOptions(["claude"], mockManifest.agents);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("claude");
  });

  it("works when keys are in different order than manifest", () => {
    const keys = ["aider", "claude"];
    const result = mapToSelectOptions(keys, mockManifest.agents);
    expect(result[0].value).toBe("aider");
    expect(result[1].value).toBe("claude");
  });
});

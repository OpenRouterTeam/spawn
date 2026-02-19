import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  parseAuthEnvVars,
  hasCloudCredentials,
  getImplementedClouds,
} from "../commands";
import { createMockManifest } from "./test-helpers";
import type { Manifest } from "../manifest";

/**
 * Tests for credential-based cloud prioritization in the interactive picker.
 *
 * PR #752 added logic to prioritize clouds where the user already has
 * auth credentials set. This test file covers:
 *
 * - parseAuthEnvVars: extracting env var names from auth strings
 * - hasCloudCredentials: checking if auth env vars are set
 * - Cloud sorting: clouds with credentials appear first
 * - mapToSelectOptions with hintOverrides: credential hints in picker
 * - getImplementedClouds: filtering by implementation status
 * - Integration: full credential prioritization flow
 *
 * Agent: test-engineer
 * Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
 */

// ── parseAuthEnvVars ─────────────────────────────────────────────────────────

describe("parseAuthEnvVars", () => {
  it("should extract single env var from simple auth string", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should extract multiple env vars separated by +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("should extract four env vars from complex auth", () => {
    const result = parseAuthEnvVars(
      "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"
    );
    expect(result).toEqual([
      "CONTABO_CLIENT_ID",
      "CONTABO_CLIENT_SECRET",
      "CONTABO_API_USER",
      "CONTABO_API_PASSWORD",
    ]);
  });

  it("should return empty array for 'none'", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("should return empty array for CLI-based auth", () => {
    expect(parseAuthEnvVars("gcloud auth login")).toEqual([]);
  });

  it("should return empty array for 'sprite login'", () => {
    expect(parseAuthEnvVars("sprite login")).toEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(parseAuthEnvVars("")).toEqual([]);
  });

  it("should reject vars shorter than 4 chars", () => {
    // The regex requires [A-Z][A-Z0-9_]{3,} which means minimum 4 chars total
    expect(parseAuthEnvVars("ABC")).toEqual([]);
  });

  it("should accept vars with exactly 4 chars", () => {
    expect(parseAuthEnvVars("ABCD")).toEqual(["ABCD"]);
  });

  it("should reject vars starting with a digit", () => {
    expect(parseAuthEnvVars("1TOKEN")).toEqual([]);
  });

  it("should reject vars starting with underscore", () => {
    expect(parseAuthEnvVars("_TOKEN")).toEqual([]);
  });

  it("should reject lowercase env vars", () => {
    expect(parseAuthEnvVars("hcloud_token")).toEqual([]);
  });

  it("should accept vars with digits", () => {
    expect(parseAuthEnvVars("AWS_S3_TOKEN")).toEqual(["AWS_S3_TOKEN"]);
  });

  it("should handle whitespace around + separators", () => {
    expect(parseAuthEnvVars("AKEY +  BKEY")).toEqual(["AKEY", "BKEY"]);
  });

  it("should handle no whitespace around + separator", () => {
    expect(parseAuthEnvVars("AKEY+BKEY")).toEqual(["AKEY", "BKEY"]);
  });

  it("should filter out non-matching parts in mixed auth strings", () => {
    // e.g. "aws configure (AWS credentials)"
    expect(parseAuthEnvVars("aws configure (AWS credentials)")).toEqual([]);
  });

  it("should handle auth string with token keyword", () => {
    expect(parseAuthEnvVars("token")).toEqual([]);
  });

  it("should extract from DO_API_TOKEN format", () => {
    expect(parseAuthEnvVars("DO_API_TOKEN")).toEqual(["DO_API_TOKEN"]);
  });

  it("should extract from VULTR_API_KEY format", () => {
    expect(parseAuthEnvVars("VULTR_API_KEY")).toEqual(["VULTR_API_KEY"]);
  });
});

// ── hasCloudCredentials ──────────────────────────────────────────────────────

describe("hasCloudCredentials", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function clearEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  it("should return true when required env var is set to a non-empty value", () => {
    setEnv("HCLOUD_TOKEN", "test-token");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("should return false when required env var is not set", () => {
    clearEnv("HCLOUD_TOKEN");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should return false when env var is empty string", () => {
    setEnv("HCLOUD_TOKEN", "");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should return true when all multi-var auth is set", () => {
    setEnv("UPCLOUD_USERNAME", "user");
    setEnv("UPCLOUD_PASSWORD", "pass");
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(
      true
    );
  });

  it("should return false when only some multi-var auth is set", () => {
    setEnv("UPCLOUD_USERNAME", "user");
    clearEnv("UPCLOUD_PASSWORD");
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(
      false
    );
  });

  it("should return false for 'none' auth", () => {
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("should return false for CLI-based auth", () => {
    expect(hasCloudCredentials("gcloud auth login")).toBe(false);
  });

  it("should return false for generic token auth without env var pattern", () => {
    expect(hasCloudCredentials("token")).toBe(false);
  });

  it("should return true when all four complex auth vars are set", () => {
    setEnv("CONTABO_CLIENT_ID", "id");
    setEnv("CONTABO_CLIENT_SECRET", "secret");
    setEnv("CONTABO_API_USER", "user");
    setEnv("CONTABO_API_PASSWORD", "pass");
    expect(
      hasCloudCredentials(
        "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"
      )
    ).toBe(true);
  });

  it("should return false when one of four complex auth vars is missing", () => {
    setEnv("CONTABO_CLIENT_ID", "id");
    setEnv("CONTABO_CLIENT_SECRET", "secret");
    clearEnv("CONTABO_API_USER");
    setEnv("CONTABO_API_PASSWORD", "pass");
    expect(
      hasCloudCredentials(
        "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"
      )
    ).toBe(false);
  });

  it("should return false when one of four complex auth vars is empty string", () => {
    setEnv("CONTABO_CLIENT_ID", "id");
    setEnv("CONTABO_CLIENT_SECRET", "");
    setEnv("CONTABO_API_USER", "user");
    setEnv("CONTABO_API_PASSWORD", "pass");
    // !!("") is false, so the every() check fails
    expect(
      hasCloudCredentials(
        "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"
      )
    ).toBe(false);
  });
});

// ── Cloud sorting by credentials ─────────────────────────────────────────────

describe("Cloud sorting by credentials", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function clearEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  // Replicate the sorting logic from cmdInteractive (commands.ts:301-311)
  function sortCloudsByCredentials(
    clouds: string[],
    manifest: Manifest
  ): { withCreds: string[]; withoutCreds: string[]; sorted: string[] } {
    const withCreds: string[] = [];
    const withoutCreds: string[] = [];
    for (const c of clouds) {
      if (hasCloudCredentials(manifest.clouds[c].auth)) {
        withCreds.push(c);
      } else {
        withoutCreds.push(c);
      }
    }
    return {
      withCreds,
      withoutCreds,
      sorted: [...withCreds, ...withoutCreds],
    };
  }

  it("should place clouds with credentials first", () => {
    const manifest: Manifest = {
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
        alpha: {
          name: "Alpha Cloud",
          description: "Cloud A",
          url: "https://alpha.com",
          type: "cloud",
          auth: "ALPHA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        beta: {
          name: "Beta Cloud",
          description: "Cloud B",
          url: "https://beta.com",
          type: "cloud",
          auth: "BETA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        gamma: {
          name: "Gamma Cloud",
          description: "Cloud C",
          url: "https://gamma.com",
          type: "cloud",
          auth: "GAMMA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {
        "alpha/claude": "implemented",
        "beta/claude": "implemented",
        "gamma/claude": "implemented",
      },
    };

    // Only beta has credentials set
    clearEnv("ALPHA_TOKEN");
    setEnv("BETA_TOKEN", "test-token");
    clearEnv("GAMMA_TOKEN");

    const result = sortCloudsByCredentials(
      ["alpha", "beta", "gamma"],
      manifest
    );
    expect(result.withCreds).toEqual(["beta"]);
    expect(result.withoutCreds).toEqual(["alpha", "gamma"]);
    expect(result.sorted).toEqual(["beta", "alpha", "gamma"]);
  });

  it("should keep original order when no credentials are set", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        alpha: {
          name: "Alpha",
          description: "A",
          url: "",
          type: "cloud",
          auth: "ALPHA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        beta: {
          name: "Beta",
          description: "B",
          url: "",
          type: "cloud",
          auth: "BETA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };

    clearEnv("ALPHA_TOKEN");
    clearEnv("BETA_TOKEN");

    const result = sortCloudsByCredentials(["alpha", "beta"], manifest);
    expect(result.withCreds).toEqual([]);
    expect(result.sorted).toEqual(["alpha", "beta"]);
  });

  it("should keep original order when all clouds have credentials", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        alpha: {
          name: "Alpha",
          description: "A",
          url: "",
          type: "cloud",
          auth: "ALPHA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        beta: {
          name: "Beta",
          description: "B",
          url: "",
          type: "cloud",
          auth: "BETA_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };

    setEnv("ALPHA_TOKEN", "a");
    setEnv("BETA_TOKEN", "b");

    const result = sortCloudsByCredentials(["alpha", "beta"], manifest);
    expect(result.withCreds).toEqual(["alpha", "beta"]);
    expect(result.withoutCreds).toEqual([]);
    expect(result.sorted).toEqual(["alpha", "beta"]);
  });

  it("should handle clouds with 'none' auth correctly", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        local: {
          name: "Local",
          description: "Local VM",
          url: "",
          type: "local",
          auth: "none",
          provision_method: "local",
          exec_method: "local",
          interactive_method: "local",
        },
        remote: {
          name: "Remote",
          description: "Remote cloud",
          url: "",
          type: "cloud",
          auth: "REMOTE_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };

    setEnv("REMOTE_TOKEN", "token");

    const result = sortCloudsByCredentials(["local", "remote"], manifest);
    // 'none' auth means hasCloudCredentials returns false
    expect(result.withCreds).toEqual(["remote"]);
    expect(result.withoutCreds).toEqual(["local"]);
    expect(result.sorted).toEqual(["remote", "local"]);
  });

  it("should handle multi-var auth where only some vars are set", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        upcloud: {
          name: "UpCloud",
          description: "Finnish cloud",
          url: "",
          type: "cloud",
          auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        hetzner: {
          name: "Hetzner",
          description: "German cloud",
          url: "",
          type: "cloud",
          auth: "HCLOUD_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };

    // UpCloud: only username set, missing password
    setEnv("UPCLOUD_USERNAME", "user");
    clearEnv("UPCLOUD_PASSWORD");
    // Hetzner: fully set
    setEnv("HCLOUD_TOKEN", "token");

    const result = sortCloudsByCredentials(["upcloud", "hetzner"], manifest);
    expect(result.withCreds).toEqual(["hetzner"]);
    expect(result.withoutCreds).toEqual(["upcloud"]);
    expect(result.sorted).toEqual(["hetzner", "upcloud"]);
  });

  it("should handle empty cloud list", () => {
    const manifest = createMockManifest();
    const result = sortCloudsByCredentials([], manifest);
    expect(result.withCreds).toEqual([]);
    expect(result.withoutCreds).toEqual([]);
    expect(result.sorted).toEqual([]);
  });

  it("should handle single cloud with credentials", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        only: {
          name: "Only",
          description: "Solo",
          url: "",
          type: "cloud",
          auth: "ONLY_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };

    setEnv("ONLY_TOKEN", "token");

    const result = sortCloudsByCredentials(["only"], manifest);
    expect(result.withCreds).toEqual(["only"]);
    expect(result.sorted).toEqual(["only"]);
  });

  it("should handle single cloud without credentials", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        only: {
          name: "Only",
          description: "Solo",
          url: "",
          type: "cloud",
          auth: "ONLY_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };

    clearEnv("ONLY_TOKEN");

    const result = sortCloudsByCredentials(["only"], manifest);
    expect(result.withCreds).toEqual([]);
    expect(result.withoutCreds).toEqual(["only"]);
    expect(result.sorted).toEqual(["only"]);
  });
});

// ── mapToSelectOptions with hintOverrides ────────────────────────────────────

describe("mapToSelectOptions with hintOverrides", () => {
  // Exact replica of mapToSelectOptions from commands.ts (lines 59-69)
  function mapToSelectOptions<
    T extends { name: string; description: string }
  >(
    keys: string[],
    items: Record<string, T>,
    hintOverrides?: Record<string, string>
  ): Array<{ value: string; label: string; hint: string }> {
    return keys.map((key) => ({
      value: key,
      label: items[key].name,
      hint: hintOverrides?.[key] ?? items[key].description,
    }));
  }

  const mockItems: Record<string, { name: string; description: string }> = {
    sprite: { name: "Sprite", description: "Lightweight VMs" },
    hetzner: { name: "Hetzner Cloud", description: "European cloud provider" },
    vultr: { name: "Vultr", description: "Cloud compute" },
  };

  it("should use description as hint when no overrides provided", () => {
    const result = mapToSelectOptions(["sprite", "hetzner"], mockItems);
    expect(result[0].hint).toBe("Lightweight VMs");
    expect(result[1].hint).toBe("European cloud provider");
  });

  it("should use description as hint when overrides is undefined", () => {
    const result = mapToSelectOptions(
      ["sprite", "hetzner"],
      mockItems,
      undefined
    );
    expect(result[0].hint).toBe("Lightweight VMs");
    expect(result[1].hint).toBe("European cloud provider");
  });

  it("should use override hint for keys in the override map", () => {
    const overrides = {
      sprite: "credentials detected -- Lightweight VMs",
    };
    const result = mapToSelectOptions(
      ["sprite", "hetzner"],
      mockItems,
      overrides
    );
    expect(result[0].hint).toBe("credentials detected -- Lightweight VMs");
    expect(result[1].hint).toBe("European cloud provider");
  });

  it("should override multiple keys", () => {
    const overrides = {
      sprite: "credentials detected -- Lightweight VMs",
      hetzner: "credentials detected -- European cloud provider",
    };
    const result = mapToSelectOptions(
      ["sprite", "hetzner", "vultr"],
      mockItems,
      overrides
    );
    expect(result[0].hint).toBe("credentials detected -- Lightweight VMs");
    expect(result[1].hint).toBe(
      "credentials detected -- European cloud provider"
    );
    expect(result[2].hint).toBe("Cloud compute");
  });

  it("should ignore override keys not in the keys list", () => {
    const overrides = {
      nonexistent: "should be ignored",
    };
    const result = mapToSelectOptions(["sprite"], mockItems, overrides);
    expect(result[0].hint).toBe("Lightweight VMs");
  });

  it("should use empty override map same as no overrides", () => {
    const result = mapToSelectOptions(["sprite"], mockItems, {});
    expect(result[0].hint).toBe("Lightweight VMs");
  });

  it("should preserve value and label regardless of hint overrides", () => {
    const overrides = { sprite: "custom hint" };
    const result = mapToSelectOptions(["sprite"], mockItems, overrides);
    expect(result[0].value).toBe("sprite");
    expect(result[0].label).toBe("Sprite");
    expect(result[0].hint).toBe("custom hint");
  });
});

// ── getImplementedClouds ─────────────────────────────────────────────────────

describe("getImplementedClouds", () => {
  const manifest = createMockManifest();

  it("should return implemented clouds for an agent", () => {
    const clouds = getImplementedClouds(manifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
  });

  it("should exclude missing matrix entries", () => {
    const clouds = getImplementedClouds(manifest, "codex");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
  });

  it("should return empty array for unknown agent", () => {
    const clouds = getImplementedClouds(manifest, "nonexistent");
    expect(clouds).toEqual([]);
  });

  it("should return empty array when no clouds are implemented", () => {
    const emptyManifest: Manifest = {
      agents: {
        claude: manifest.agents.claude,
      },
      clouds: {
        sprite: manifest.clouds.sprite,
      },
      matrix: {
        "sprite/claude": "missing",
      },
    };
    const clouds = getImplementedClouds(emptyManifest, "claude");
    expect(clouds).toEqual([]);
  });
});

// ── Integration: credential hint building ────────────────────────────────────

describe("Credential hint building", () => {
  // Replica of getAuthHint from commands.ts:455-458
  function getAuthHint(
    manifest: Manifest,
    cloud: string
  ): string | undefined {
    const authVars = parseAuthEnvVars(manifest.clouds[cloud].auth);
    return authVars.length > 0 ? authVars.join(" + ") : undefined;
  }

  it("should return joined env var names for single-var auth", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        hetzner: {
          name: "Hetzner",
          description: "Cloud",
          url: "",
          type: "cloud",
          auth: "HCLOUD_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };
    expect(getAuthHint(manifest, "hetzner")).toBe("HCLOUD_TOKEN");
  });

  it("should return joined env var names for multi-var auth", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        upcloud: {
          name: "UpCloud",
          description: "Cloud",
          url: "",
          type: "cloud",
          auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };
    expect(getAuthHint(manifest, "upcloud")).toBe(
      "UPCLOUD_USERNAME + UPCLOUD_PASSWORD"
    );
  });

  it("should return undefined for 'none' auth", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        local: {
          name: "Local",
          description: "Local",
          url: "",
          type: "local",
          auth: "none",
          provision_method: "local",
          exec_method: "local",
          interactive_method: "local",
        },
      },
      matrix: {},
    };
    expect(getAuthHint(manifest, "local")).toBeUndefined();
  });

  it("should return undefined for CLI-based auth", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        gcp: {
          name: "GCP",
          description: "Google Cloud",
          url: "",
          type: "cloud",
          auth: "gcloud auth login",
          provision_method: "cli",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };
    expect(getAuthHint(manifest, "gcp")).toBeUndefined();
  });

  it("should return four joined vars for complex auth", () => {
    const manifest: Manifest = {
      agents: {},
      clouds: {
        contabo: {
          name: "Contabo",
          description: "VPS",
          url: "",
          type: "cloud",
          auth: "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };
    expect(getAuthHint(manifest, "contabo")).toBe(
      "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"
    );
  });
});

// ── Integration: full prioritization flow ────────────────────────────────────

describe("Full credential prioritization flow", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function clearEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  // Simulate the full flow from cmdInteractive
  function simulateCloudPrioritization(
    manifest: Manifest,
    agent: string
  ): {
    sortedClouds: string[];
    hintOverrides: Record<string, string>;
    credsCount: number;
  } {
    const clouds = getImplementedClouds(manifest, agent);

    const withCreds: string[] = [];
    const withoutCreds: string[] = [];
    for (const c of clouds) {
      if (hasCloudCredentials(manifest.clouds[c].auth)) {
        withCreds.push(c);
      } else {
        withoutCreds.push(c);
      }
    }
    const sortedClouds = [...withCreds, ...withoutCreds];

    const hintOverrides: Record<string, string> = {};
    for (const c of withCreds) {
      hintOverrides[c] = `credentials detected -- ${manifest.clouds[c].description}`;
    }

    return { sortedClouds, hintOverrides, credsCount: withCreds.length };
  }

  it("should prioritize cloud with credentials in real manifest-like data", () => {
    const manifest: Manifest = {
      agents: {
        claude: {
          name: "Claude Code",
          description: "AI assistant",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {
        sprite: {
          name: "Sprite",
          description: "Lightweight VMs",
          url: "",
          type: "vm",
          auth: "sprite login",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        hetzner: {
          name: "Hetzner Cloud",
          description: "European cloud provider",
          url: "",
          type: "cloud",
          auth: "HCLOUD_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        digitalocean: {
          name: "DigitalOcean",
          description: "Cloud platform",
          url: "",
          type: "cloud",
          auth: "DO_API_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
        vultr: {
          name: "Vultr",
          description: "Cloud compute",
          url: "",
          type: "cloud",
          auth: "VULTR_API_KEY",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {
        "sprite/claude": "implemented",
        "hetzner/claude": "implemented",
        "digitalocean/claude": "implemented",
        "vultr/claude": "implemented",
      },
    };

    // User has Hetzner and Vultr credentials set
    clearEnv("HCLOUD_TOKEN");
    setEnv("HCLOUD_TOKEN", "hetzner-token");
    clearEnv("DO_API_TOKEN");
    clearEnv("VULTR_API_KEY");
    setEnv("VULTR_API_KEY", "vultr-key");

    const result = simulateCloudPrioritization(manifest, "claude");

    // Hetzner and Vultr should come first (in original order)
    expect(result.sortedClouds[0]).toBe("hetzner");
    expect(result.sortedClouds[1]).toBe("vultr");
    // Sprite and DigitalOcean should follow
    expect(result.sortedClouds[2]).toBe("sprite");
    expect(result.sortedClouds[3]).toBe("digitalocean");

    expect(result.credsCount).toBe(2);
    expect(result.hintOverrides["hetzner"]).toBe(
      "credentials detected -- European cloud provider"
    );
    expect(result.hintOverrides["vultr"]).toBe(
      "credentials detected -- Cloud compute"
    );
    expect(result.hintOverrides["sprite"]).toBeUndefined();
    expect(result.hintOverrides["digitalocean"]).toBeUndefined();
  });

  it("should handle agent with no implemented clouds", () => {
    const manifest: Manifest = {
      agents: {
        newagent: {
          name: "New Agent",
          description: "New",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {
        sprite: {
          name: "Sprite",
          description: "VMs",
          url: "",
          type: "vm",
          auth: "SPRITE_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {
        "sprite/newagent": "missing",
      },
    };

    const result = simulateCloudPrioritization(manifest, "newagent");
    expect(result.sortedClouds).toEqual([]);
    expect(result.hintOverrides).toEqual({});
    expect(result.credsCount).toBe(0);
  });

  it("should produce correct hint override format", () => {
    const manifest: Manifest = {
      agents: {
        claude: {
          name: "Claude Code",
          description: "AI",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {
        hetzner: {
          name: "Hetzner Cloud",
          description: "European cloud provider",
          url: "",
          type: "cloud",
          auth: "HCLOUD_TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {
        "hetzner/claude": "implemented",
      },
    };

    setEnv("HCLOUD_TOKEN", "token");

    const result = simulateCloudPrioritization(manifest, "claude");
    // Hint format should be: "credentials detected -- {description}"
    expect(result.hintOverrides["hetzner"]).toMatch(
      /^credentials detected -- /
    );
    expect(result.hintOverrides["hetzner"]).toContain(
      "European cloud provider"
    );
  });
});

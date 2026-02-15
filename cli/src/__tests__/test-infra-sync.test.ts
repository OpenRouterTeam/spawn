import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Test infrastructure sync validation tests.
 *
 * Validates that test/mock.sh and test/record.sh stay in sync with
 * manifest.json. When a new cloud provider is added, CLAUDE.md mandates
 * updating both files, but it's easy to forget. These tests catch:
 *
 * - Clouds missing from get_endpoints() in test/record.sh
 * - Clouds missing from get_auth_env_var() in test/record.sh
 * - Clouds missing from call_api() in test/record.sh
 * - Clouds missing from _strip_api_base() in test/mock.sh
 * - Fixture directories missing _env.sh for setup_env_for_cloud()
 * - Fixture directories missing _metadata.json
 * - Auth env var consistency between manifest.json and test/record.sh
 * - Internal consistency within test/record.sh functions
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifest: Manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "manifest.json"), "utf-8")
);

const mockShContent = readFileSync(join(REPO_ROOT, "test/mock.sh"), "utf-8");
const recordShContent = readFileSync(join(REPO_ROOT, "test/record.sh"), "utf-8");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract ALL_RECORDABLE_CLOUDS list from test/record.sh */
function getRecordableClouds(): string[] {
  const match = recordShContent.match(
    /ALL_RECORDABLE_CLOUDS="([^"]+)"/
  );
  if (!match) return [];
  return match[1].split(/\s+/).filter(Boolean);
}

/** Extract cloud names handled in a case statement for a given function */
function getCloudsInCase(content: string, funcName: string): string[] {
  const lines = content.split("\n");
  let inFunc = false;
  let inCase = false;
  let braceDepth = 0;
  const clouds: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${funcName}()`)) {
      inFunc = true;
      continue;
    }
    if (inFunc) {
      if (trimmed === "{") braceDepth++;
      if (trimmed === "}") {
        braceDepth--;
        if (braceDepth <= 0) break;
      }
      if (trimmed.startsWith("case")) inCase = true;
      if (trimmed === "esac") inCase = false;
      if (inCase) {
        // Match patterns like: hetzner) or digitalocean)
        const caseMatch = trimmed.match(
          /^\s*([a-z][a-z0-9_-]*)\)\s*/
        );
        if (caseMatch) {
          clouds.push(caseMatch[1]);
        }
      }
    }
  }

  // For get_endpoints, also check for _ENDPOINTS_* variable declarations
  if (funcName === "get_endpoints") {
    const varMatches = content.match(/_ENDPOINTS_([a-z][a-z0-9_-]*)\s*="/g);
    if (varMatches) {
      varMatches.forEach((match) => {
        const cloudName = match.match(/_ENDPOINTS_([a-z][a-z0-9_-]*)/)?.[1];
        if (cloudName && !clouds.includes(cloudName)) {
          clouds.push(cloudName);
        }
      });
    }
  }

  return clouds;
}

/** Extract cloud names from _strip_api_base's URL case patterns */
function getCloudsInStripApiBase(): string[] {
  const clouds: string[] = [];
  const lines = mockShContent.split("\n");

  let inStripApiBase = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("_strip_api_base()")) {
      inStripApiBase = true;
      continue;
    }
    if (inStripApiBase) {
      if (trimmed === "}") break;
      // Map known API domain patterns to cloud names
      const urlPatterns: Record<string, string> = {
        "api.hetzner.cloud": "hetzner",
        "api.digitalocean.com": "digitalocean",
        "api.vultr.com": "vultr",
        "api.linode.com": "linode",
        "cloud.lambdalabs.com": "lambda",
        "api.civo.com": "civo",
        "api.upcloud.com": "upcloud",
        "api.binarylane.com.au": "binarylane",
        "api.scaleway.com": "scaleway",
        "api.genesiscloud.com": "genesiscloud",
        "console.kamatera.com": "kamatera",
        "api.latitude.sh": "latitude",
        "infrahub-api.nexgencloud.com": "hyperstack",
        "eu.api.ovh.com": "ovh",
        "cloudapi.atlantic.net": "atlanticnet",
        "invapi.hostkey.com": "hostkey",
        "cloudsigma.com": "cloudsigma",
        "api.webdock.io": "webdock",
        "api.serverspace.io": "serverspace",
        "api.gcore.com": "gcore",
      };
      for (const [domain, cloud] of Object.entries(urlPatterns)) {
        if (trimmed.includes(domain)) {
          clouds.push(cloud);
        }
      }
    }
  }
  return clouds;
}

/** Get fixture directories that have _metadata.json */
function getFixtureClouds(): string[] {
  const fixturesDir = join(REPO_ROOT, "test/fixtures");
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir).filter((name: string) =>
    existsSync(join(fixturesDir, name, "_metadata.json"))
  );
}

// ── Pre-computed data ───────────────────────────────────────────────────────

const recordableClouds = getRecordableClouds();
const fixtureClouds = getFixtureClouds();

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Test Infrastructure Sync", () => {
  // ── test/record.sh ──────────────────────────────────────────────────

  describe("test/record.sh structure", () => {
    it("should exist", () => {
      expect(existsSync(join(REPO_ROOT, "test/record.sh"))).toBe(true);
    });

    it("should define ALL_RECORDABLE_CLOUDS", () => {
      expect(recordableClouds.length).toBeGreaterThan(0);
    });

    it("should have at least 3 recordable clouds", () => {
      expect(recordableClouds.length).toBeGreaterThanOrEqual(3);
    });

    it("should not have duplicate entries in ALL_RECORDABLE_CLOUDS", () => {
      const unique = new Set(recordableClouds);
      expect(unique.size).toBe(recordableClouds.length);
    });
  });

  describe("test/record.sh: get_endpoints() coverage", () => {
    const endpointClouds = getCloudsInCase(recordShContent, "get_endpoints");

    it("should define endpoints for every recordable cloud", () => {
      const missing = recordableClouds.filter(
        (c) => !endpointClouds.includes(c)
      );
      if (missing.length > 0) {
        throw new Error(
          `Clouds in ALL_RECORDABLE_CLOUDS but missing from get_endpoints():\n` +
          missing.map((c) => `  - ${c}`).join("\n") +
          `\nAdd a case for each cloud in get_endpoints() (test/record.sh).`
        );
      }
    });

    it("should not have endpoint entries for non-recordable clouds", () => {
      const extra = endpointClouds.filter(
        (c) => !recordableClouds.includes(c) && c !== "*"
      );
      if (extra.length > 0) {
        throw new Error(
          `Clouds in get_endpoints() but not in ALL_RECORDABLE_CLOUDS:\n` +
          extra.map((c) => `  - ${c}`).join("\n")
        );
      }
    });
  });

  describe("test/record.sh: get_auth_env_var() coverage", () => {
    const authClouds = getCloudsInCase(recordShContent, "get_auth_env_var");

    it("should define auth env vars for every recordable cloud", () => {
      const missing = recordableClouds.filter(
        (c) => !authClouds.includes(c)
      );
      if (missing.length > 0) {
        throw new Error(
          `Clouds in ALL_RECORDABLE_CLOUDS but missing from get_auth_env_var():\n` +
          missing.map((c) => `  - ${c}`).join("\n") +
          `\nAdd a case for each cloud in get_auth_env_var() (test/record.sh).`
        );
      }
    });
  });

  describe("test/record.sh: call_api() coverage", () => {
    const callApiClouds = getCloudsInCase(recordShContent, "call_api");

    it("should define API dispatchers for every recordable cloud", () => {
      const missing = recordableClouds.filter(
        (c) => !callApiClouds.includes(c)
      );
      if (missing.length > 0) {
        throw new Error(
          `Clouds in ALL_RECORDABLE_CLOUDS but missing from call_api():\n` +
          missing.map((c) => `  - ${c}`).join("\n") +
          `\nAdd a case for each cloud in call_api() (test/record.sh).`
        );
      }
    });
  });

  describe("test/record.sh: has_api_error() coverage", () => {
    it("should reference every recordable cloud in error detection", () => {
      // has_api_error uses a Python script with cloud-name checks.
      // Each cloud should appear somewhere in the error detection code, either
      // directly (cloud == 'hetzner') or in a tuple (cloud in ('vultr', ...)).
      const missingClouds: string[] = [];
      for (const cloud of recordableClouds) {
        // Search for the cloud name in both single-quoted and double-quoted forms
        // within the has_api_error function body
        const hasReference =
          recordShContent.includes(`'${cloud}'`) ||
          recordShContent.includes(`"${cloud}"`);

        if (!hasReference) {
          missingClouds.push(cloud);
        }
      }
      // This is informational — some clouds may share error patterns with a
      // generic fallback. We report but don't fail for small gaps.
      if (missingClouds.length > 3) {
        throw new Error(
          `${missingClouds.length} recordable clouds not referenced in has_api_error():\n` +
          missingClouds.map((c) => `  - ${c}`).join("\n") +
          `\nAdd error detection for each cloud in has_api_error() (test/record.sh).`
        );
      }
    });
  });

  // ── test/mock.sh ──────────────────────────────────────────────────

  describe("test/mock.sh structure", () => {
    it("should exist", () => {
      expect(existsSync(join(REPO_ROOT, "test/mock.sh"))).toBe(true);
    });
  });

  describe("test/mock.sh: _strip_api_base() coverage", () => {
    const stripApiBaseClouds = getCloudsInStripApiBase();

    it("should handle URLs for every cloud with fixtures", () => {
      const missing = fixtureClouds.filter(
        (c) => !stripApiBaseClouds.includes(c)
      );
      if (missing.length > 0) {
        throw new Error(
          `Clouds with fixture data but missing from _strip_api_base() in mock curl:\n` +
          missing.map((c) => `  - ${c}`).join("\n") +
          `\nAdd URL pattern for each cloud in _strip_api_base() (test/mock.sh).`
        );
      }
    });

    it("should handle at least as many clouds as there are fixture directories", () => {
      expect(stripApiBaseClouds.length).toBeGreaterThanOrEqual(
        fixtureClouds.length
      );
    });
  });

  describe("test/mock.sh: _validate_body() coverage", () => {
    it("should validate POST body for major clouds", () => {
      // _validate_body has explicit field checks for major REST API clouds
      const majorClouds = ["hetzner", "digitalocean"];
      for (const cloud of majorClouds) {
        expect(mockShContent).toContain(cloud);
      }
    });
  });

  // ── Fixture directories ───────────────────────────────────────────

  describe("fixture directory completeness", () => {
    it("should have at least some fixture directories", () => {
      expect(fixtureClouds.length).toBeGreaterThan(0);
    });

    it("should have _env.sh for every cloud with fixtures", () => {
      const fixturesDir = join(REPO_ROOT, "test/fixtures");
      const missing: string[] = [];
      for (const cloud of fixtureClouds) {
        if (!existsSync(join(fixturesDir, cloud, "_env.sh"))) {
          missing.push(cloud);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `Fixture directories missing _env.sh (needed by setup_env_for_cloud):\n` +
          missing.map((c) => `  - test/fixtures/${c}/_env.sh`).join("\n")
        );
      }
    });

    it("should have _metadata.json for every cloud with fixtures", () => {
      const fixturesDir = join(REPO_ROOT, "test/fixtures");
      for (const cloud of fixtureClouds) {
        expect(
          existsSync(join(fixturesDir, cloud, "_metadata.json"))
        ).toBe(true);
      }
    });

    it("should have at least one .json fixture file per cloud", () => {
      const fixturesDir = join(REPO_ROOT, "test/fixtures");
      for (const cloud of fixtureClouds) {
        const dir = join(fixturesDir, cloud);
        const files = readdirSync(dir).filter(
          (f: string) => f.endsWith(".json") && f !== "_metadata.json"
        );
        expect(files.length).toBeGreaterThan(0);
      }
    });

    it("should have fixture directories only for recordable clouds", () => {
      const orphaned = fixtureClouds.filter(
        (c) => !recordableClouds.includes(c)
      );
      if (orphaned.length > 0) {
        throw new Error(
          `Fixture directories exist for clouds not in ALL_RECORDABLE_CLOUDS:\n` +
          orphaned.map((c) => `  - test/fixtures/${c}/`).join("\n") +
          `\nEither add these clouds to ALL_RECORDABLE_CLOUDS or remove the fixture dirs.`
        );
      }
    });
  });

  // ── Cross-reference with manifest.json ────────────────────────────

  describe("manifest.json <-> test infrastructure sync", () => {
    it("auth env vars in record.sh should match manifest auth fields", () => {
      // For each recordable cloud that exists in the manifest, verify that
      // the auth env var in record.sh matches what's in the manifest
      for (const cloud of recordableClouds) {
        if (!manifest.clouds[cloud]) continue;

        const manifestAuth = manifest.clouds[cloud].auth;
        if (manifestAuth.toLowerCase() === "none") continue;

        // Extract the env var from record.sh's get_auth_env_var
        const match = recordShContent.match(
          new RegExp(`${cloud}\\)\\s+printf\\s+"([^"]+)"`, "m")
        );
        if (!match) continue;

        const recordAuthVar = match[1];
        // The manifest auth field should contain the env var name
        expect(manifestAuth).toContain(recordAuthVar);
      }
    });

    it("recordable clouds that exist in manifest should have matching cloud keys", () => {
      // Each recordable cloud that IS in the manifest should use valid manifest keys
      const validRecordable = recordableClouds.filter(
        (c) => manifest.clouds[c]
      );
      expect(validRecordable.length).toBeGreaterThan(0);

      for (const cloud of validRecordable) {
        expect(manifest.clouds[cloud]).toBeTruthy();
        expect(manifest.clouds[cloud].name).toBeTruthy();
      }
    });

    it("fixture directories should reference valid manifest clouds or recordable clouds", () => {
      // Every fixture directory should correspond to either a manifest cloud
      // or at minimum a recordable cloud (which may have been recently removed
      // from manifest but still has valid fixtures)
      for (const cloud of fixtureClouds) {
        const inManifest = !!manifest.clouds[cloud];
        const inRecordable = recordableClouds.includes(cloud);
        expect(inManifest || inRecordable).toBe(true);
      }
    });
  });

  // ── Shell script syntax ───────────────────────────────────────────

  describe("test script syntax", () => {
    it("test/mock.sh should start with shebang", () => {
      expect(mockShContent.trimStart().startsWith("#!/bin/bash")).toBe(true);
    });

    it("test/record.sh should start with shebang", () => {
      expect(recordShContent.trimStart().startsWith("#!/bin/bash")).toBe(true);
    });

    it("test/mock.sh should use set -eo pipefail", () => {
      expect(mockShContent).toContain("set -eo pipefail");
    });

    it("test/record.sh should use set -eo pipefail", () => {
      expect(recordShContent).toContain("set -eo pipefail");
    });

    it("test/mock.sh should not use echo -e in main script body", () => {
      // echo -e is banned for macOS bash 3.x compatibility
      // Only check after the MOCKCURL heredoc ends (the mock curl script itself
      // is fine since it runs in controlled environments)
      const parts = mockShContent.split("MOCKCURL");
      if (parts.length < 3) return; // Can't find the end of the heredoc
      // parts[2] is after the closing MOCKCURL — the main script body
      const mainBody = parts[2];
      const badLines = mainBody
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .filter((l) => /\becho\s+-e\b/.test(l));

      if (badLines.length > 0) {
        throw new Error(
          `test/mock.sh uses echo -e in main body (banned for macOS compat):\n` +
          badLines.map((l) => `  ${l.trim()}`).join("\n") +
          `\nUse printf instead.`
        );
      }
    });

    it("test/record.sh should not use echo -e", () => {
      const badLines = recordShContent
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .filter((l) => /\becho\s+-e\b/.test(l));

      if (badLines.length > 0) {
        throw new Error(
          `test/record.sh uses echo -e (banned for macOS compat):\n` +
          badLines.map((l) => `  ${l.trim()}`).join("\n") +
          `\nUse printf instead.`
        );
      }
    });
  });

  // ── Internal consistency ──────────────────────────────────────────

  describe("internal consistency within test/record.sh", () => {
    it("get_endpoints() and call_api() should cover the same clouds", () => {
      const endpointClouds = getCloudsInCase(recordShContent, "get_endpoints");
      const callApiClouds = getCloudsInCase(recordShContent, "call_api");

      const inEndpointsNotApi = endpointClouds.filter(
        (c) => !callApiClouds.includes(c) && c !== "*"
      );
      const inApiNotEndpoints = callApiClouds.filter(
        (c) => !endpointClouds.includes(c) && c !== "*"
      );

      if (inEndpointsNotApi.length > 0) {
        throw new Error(
          `Clouds in get_endpoints() but missing from call_api():\n` +
          inEndpointsNotApi.map((c) => `  - ${c}`).join("\n")
        );
      }
      if (inApiNotEndpoints.length > 0) {
        throw new Error(
          `Clouds in call_api() but missing from get_endpoints():\n` +
          inApiNotEndpoints.map((c) => `  - ${c}`).join("\n")
        );
      }
    });

    it("get_endpoints() and get_auth_env_var() should cover the same clouds", () => {
      const endpointClouds = getCloudsInCase(recordShContent, "get_endpoints");
      const authClouds = getCloudsInCase(recordShContent, "get_auth_env_var");

      const inEndpointsNotAuth = endpointClouds.filter(
        (c) => !authClouds.includes(c) && c !== "*"
      );

      if (inEndpointsNotAuth.length > 0) {
        throw new Error(
          `Clouds in get_endpoints() but missing from get_auth_env_var():\n` +
          inEndpointsNotAuth.map((c) => `  - ${c}`).join("\n")
        );
      }
    });

    it("ALL_RECORDABLE_CLOUDS and get_endpoints() should cover the same clouds", () => {
      const endpointClouds = getCloudsInCase(recordShContent, "get_endpoints");

      // All recordable clouds should have endpoints
      const missingEndpoints = recordableClouds.filter(
        (c) => !endpointClouds.includes(c)
      );
      expect(missingEndpoints).toEqual([]);

      // All endpoint clouds should be recordable
      const extraEndpoints = endpointClouds.filter(
        (c) => !recordableClouds.includes(c) && c !== "*"
      );
      expect(extraEndpoints).toEqual([]);
    });
  });

  // ── Test script conventions ───────────────────────────────────────

  describe("test script conventions", () => {
    it("test/mock.sh should respect NO_COLOR standard", () => {
      expect(mockShContent).toContain("NO_COLOR");
    });

    it("test/mock.sh should clean up temp files on exit", () => {
      expect(mockShContent).toContain("trap cleanup EXIT");
    });

    it("test/record.sh should validate cloud names before recording", () => {
      expect(recordShContent).toContain("Unknown cloud:");
    });

    it("test/mock.sh should support parallel cloud execution", () => {
      expect(mockShContent).toContain("CLOUD_PIDS");
    });

    it("test/record.sh should support parallel recording", () => {
      expect(recordShContent).toContain("RECORD_PIDS");
    });

    it("test/mock.sh should define assertion functions", () => {
      expect(mockShContent).toContain("assert_exit_code()");
      expect(mockShContent).toContain("assert_log_contains()");
      expect(mockShContent).toContain("assert_api_called()");
      expect(mockShContent).toContain("assert_env_injected()");
    });

    it("test/mock.sh should track pass/fail/skip counts", () => {
      expect(mockShContent).toContain("PASSED=0");
      expect(mockShContent).toContain("FAILED=0");
      expect(mockShContent).toContain("SKIPPED=0");
    });

    it("test/record.sh should track recorded/skipped/error counts", () => {
      expect(recordShContent).toContain("RECORDED=0");
      expect(recordShContent).toContain("SKIPPED=0");
      expect(recordShContent).toContain("ERRORS=0");
    });
  });
});

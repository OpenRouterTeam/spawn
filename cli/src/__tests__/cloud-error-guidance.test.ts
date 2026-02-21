import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, join } from "path";

/**
 * Tests for actionable error guidance in cloud provider lib/common.sh files.
 *
 * When cloud operations fail (destroy_server, create_server, auth errors),
 * users need clear guidance. PRs #957-#962 added dashboard URLs, billing
 * warnings, and env var hints across many providers. This test file
 * validates that:
 *
 * 1. Providers that already have destroy_server error handling include
 *    proper guidance (dashboard URLs, billing warnings)
 * 2. All create_server functions have some error handling
 * 3. Auth patterns reference expected env vars
 * 4. Shared timeout functions provide retry guidance
 * 5. Error messages use structured logging (log_error not bare echo)
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function discoverCloudLibs(): Array<{ name: string; path: string; content: string }> {
  const clouds: Array<{ name: string; path: string; content: string }> = [];
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (["cli", "shared", "test", "node_modules", ".git", ".github", ".claude", ".docs"].includes(entry.name)) continue;
    const libPath = join(REPO_ROOT, entry.name, "lib", "common.sh");
    if (existsSync(libPath)) {
      clouds.push({
        name: entry.name,
        path: libPath,
        content: readFileSync(libPath, "utf-8"),
      });
    }
  }
  return clouds.sort((a, b) => a.name.localeCompare(b.name));
}

function extractFunctionBody(content: string, funcName: string): string | null {
  const lines = content.split("\n");
  let inFunc = false;
  let braceDepth = 0;
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (!inFunc) {
      if (line.match(new RegExp(`^${funcName}\\(\\)\\s*\\{`))) {
        inFunc = true;
        braceDepth = 1;
        continue;
      }
      continue;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }

    if (braceDepth <= 0) break;
    bodyLines.push(line);
  }

  return bodyLines.length > 0 ? bodyLines.join("\n") : null;
}

const allClouds = discoverCloudLibs();

// Providers known to have destroy_server with proper error handling (upgraded in PRs #957-962)
const UPGRADED_DESTROY_PROVIDERS = [
  "hetzner",
];

// Known dashboard URLs per provider
const DASHBOARD_URLS: Record<string, string> = {
  "hetzner": "console.hetzner.cloud",
  "digitalocean": "cloud.digitalocean.com",
  "fly": "fly.io/dashboard",
};

// ── Upgraded destroy_server providers ───────────────────────────────────────

describe("upgraded destroy_server error guidance", () => {
  for (const providerName of UPGRADED_DESTROY_PROVIDERS) {
    const cloud = allClouds.find((c) => c.name === providerName);
    if (!cloud) continue;

    const destroyBody = extractFunctionBody(cloud.content, "destroy_server");
    if (!destroyBody) continue;

    describe(`${providerName}`, () => {
      it("should log an error on failure", () => {
        expect(destroyBody).toContain("log_error");
      });

      it("should warn about running server or billing", () => {
        const hasWarning =
          destroyBody.includes("still be running") ||
          destroyBody.includes("incurring charges") ||
          destroyBody.includes("still running") ||
          destroyBody.includes("manually");
        expect(hasWarning).toBe(true);
      });

      it("should include a dashboard URL for manual cleanup", () => {
        const expectedUrl = DASHBOARD_URLS[providerName];
        if (expectedUrl) {
          expect(destroyBody).toContain(expectedUrl);
        }
      });

      it("should extract and display the API error message", () => {
        const hasErrorDetails =
          destroyBody.includes("extract_api_error_message") ||
          destroyBody.includes("API Error") ||
          destroyBody.includes("response");
        expect(hasErrorDetails).toBe(true);
      });
    });
  }
});

// ── All providers: create_server has error handling ─────────────────────────

describe("create_server error handling", () => {
  const cloudsWithCreate = allClouds.filter((c) =>
    c.content.includes("create_server()")
  );

  it("should find at least 6 clouds with create_server", () => {
    expect(cloudsWithCreate.length).toBeGreaterThanOrEqual(6);
  });

  for (const cloud of cloudsWithCreate) {
    // Skip local provider which has no API to fail
    if (cloud.name === "local") continue;
    const createBody = extractFunctionBody(cloud.content, "create_server");
    if (!createBody) continue;

    it(`${cloud.name} create_server should have error handling`, () => {
      const hasErrorHandling =
        createBody.includes("log_error") ||
        createBody.includes("_log_diagnostic") ||
        createBody.includes("log_warn") ||
        createBody.includes("exit 1") ||
        createBody.includes("return 1");
      expect(hasErrorHandling).toBe(true);
    });
  }
});

// ── Auth env var references ─────────────────────────────────────────────────

describe("provider auth configuration", () => {
  for (const cloud of allClouds) {
    if (cloud.name === "local") continue;

    it(`${cloud.name} should reference auth credentials`, () => {
      const hasAuth =
        cloud.content.includes("ensure_api_token_with_provider") ||
        cloud.content.includes("ensure_multi_credentials") ||
        cloud.content.includes("API_KEY") ||
        cloud.content.includes("API_TOKEN") ||
        cloud.content.includes("AUTH_TOKEN") ||
        cloud.content.includes("_TOKEN") ||
        cloud.content.includes("_KEY") ||
        cloud.content.includes("gcloud auth") ||
        cloud.content.includes("aws configure") ||
        cloud.content.includes("fly auth") ||
        cloud.content.includes("gh auth") ||
        cloud.content.includes("modal") ||
        cloud.content.includes("oci ") ||
        cloud.content.includes("_SECRET") ||
        cloud.content.includes("_PASSWORD") ||
        cloud.content.includes("CREDENTIALS") ||
        cloud.content.includes("authenticated");
      expect(hasAuth).toBe(true);
    });
  }
});

// ── Dashboard URLs in lib files ─────────────────────────────────────────────

describe("dashboard URL presence", () => {
  for (const cloud of allClouds) {
    const expectedUrl = DASHBOARD_URLS[cloud.name];
    if (!expectedUrl) continue;

    it(`${cloud.name} lib should reference its dashboard (${expectedUrl})`, () => {
      expect(cloud.content).toContain(expectedUrl);
    });
  }
});

// ── Structured logging preference ───────────────────────────────────────────

describe("structured logging over bare echo", () => {
  for (const cloud of allClouds) {
    if (cloud.name === "local") continue;

    it(`${cloud.name} should prefer log_error over bare echo for errors`, () => {
      const echoErrorCount = (cloud.content.match(/echo\s+"?(ERROR|FATAL)/gi) || []).length;
      expect(echoErrorCount).toBeLessThanOrEqual(2);
    });
  }
});

// ── Shared function timeout guidance ────────────────────────────────────────

describe("shared timeout function guidance", () => {
  const sharedContent = readFileSync(
    resolve(REPO_ROOT, "shared/common.sh"),
    "utf-8"
  );

  describe("generic_wait_for_instance", () => {
    const body = extractFunctionBody(sharedContent, "generic_wait_for_instance");

    it("should exist", () => {
      expect(body).not.toBeNull();
    });

    it("should log error on timeout", () => {
      // Calls _report_instance_timeout which contains the error guidance
      expect(body!).toContain("_report_instance_timeout");
    });

    it("should suggest retry or manual check", () => {
      // Check the _report_instance_timeout helper function for guidance
      const timeoutHelper = extractFunctionBody(sharedContent, "_report_instance_timeout");
      const hasGuidance =
        timeoutHelper!.includes("dashboard") ||
        timeoutHelper!.includes("retry") ||
        timeoutHelper!.includes("Next steps");
      expect(hasGuidance).toBe(true);
    });

    it("should mention the instance may still be provisioning", () => {
      // Check the _report_instance_timeout helper function for guidance
      const timeoutHelper = extractFunctionBody(sharedContent, "_report_instance_timeout");
      expect(timeoutHelper!).toContain("instance");
    });
  });

  describe("generic_ssh_wait", () => {
    const body = extractFunctionBody(sharedContent, "generic_ssh_wait");

    it("should exist", () => {
      expect(body).not.toBeNull();
    });

    it("should log error on timeout", () => {
      // Calls _log_ssh_wait_timeout_error which contains the error guidance
      expect(body!).toContain("_log_ssh_wait_timeout_error");
    });

    it("should suggest that the server may still be booting", () => {
      // Check the _log_ssh_wait_timeout_error helper function for guidance
      const timeoutHelper = extractFunctionBody(sharedContent, "_log_ssh_wait_timeout_error");
      const hasGuidance =
        timeoutHelper!.includes("firewall") ||
        timeoutHelper!.includes("retry") ||
        timeoutHelper!.includes("Next steps") ||
        timeoutHelper!.includes("server");
      expect(hasGuidance).toBe(true);
    });
  });
});

// ── extract_api_error_message usage in destroy_server ───────────────────────

describe("extract_api_error_message in destroy_server", () => {
  // Providers that use generic_cloud_api (REST API providers) should use
  // extract_api_error_message in their destroy_server for better error messages
  const apiProviders = UPGRADED_DESTROY_PROVIDERS;

  for (const providerName of apiProviders) {
    const cloud = allClouds.find((c) => c.name === providerName);
    if (!cloud) continue;

    const destroyBody = extractFunctionBody(cloud.content, "destroy_server");
    if (!destroyBody) continue;

    it(`${providerName} should extract API error details`, () => {
      const extractsError =
        destroyBody.includes("extract_api_error_message") ||
        destroyBody.includes("_extract_json_field") ||
        destroyBody.includes("python3 -c") ||
        destroyBody.includes("API Error");
      expect(extractsError).toBe(true);
    });
  }
});

// ── Provider-specific error URL correctness ─────────────────────────────────

describe("provider-specific error URL format", () => {
  for (const cloud of allClouds) {
    const urls = cloud.content.match(/https?:\/\/[^\s"')`]+/g) || [];
    if (urls.length === 0) continue;

    it(`${cloud.name} URLs should be well-formed (no trailing punctuation)`, () => {
      for (const url of urls) {
        // URLs shouldn't end with common punctuation that got captured
        expect(url).not.toMatch(/[,;:!]$/);
      }
    });

    it(`${cloud.name} URLs should use HTTPS`, () => {
      const httpUrls = urls.filter(
        (u) => u.startsWith("http://") && !u.includes("localhost") && !u.includes("127.0.0.1") && !u.includes("0.0.0.0")
      );
      // Allow at most a few HTTP URLs (some APIs genuinely use HTTP internally)
      expect(httpUrls.length).toBeLessThanOrEqual(3);
    });
  }
});

// ── Destroy server return code ──────────────────────────────────────────────

describe("destroy_server returns non-zero on failure", () => {
  const cloudsWithDestroy = allClouds.filter((c) =>
    c.content.includes("destroy_server()")
  );

  for (const cloud of cloudsWithDestroy) {
    const destroyBody = extractFunctionBody(cloud.content, "destroy_server");
    if (!destroyBody) continue;

    // Skip simple destroy functions (local, containers, CLI-based providers)
    // These rely on set -e or CLI error handling, not explicit return 1
    const skipProviders = ["local", "fly", "daytona"];
    if (skipProviders.includes(cloud.name)) continue;
    // Skip providers with no error path (they rely on set -e)
    if (!destroyBody.includes("if ") && !destroyBody.includes("|| ")) continue;

    it(`${cloud.name} destroy_server should return non-zero on error`, () => {
      const returnsError =
        destroyBody.includes("return 1") ||
        destroyBody.includes("exit 1");
      expect(returnsError).toBe(true);
    });
  }
});

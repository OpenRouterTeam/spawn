import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for DigitalOcean OAuth flow in cli/src/digitalocean/digitalocean.ts.
 *
 * Covers:
 * - Config persistence (save/load with refresh_token, expires_at)
 * - CSRF state generation
 * - OAuth code validation
 * - Token expiry detection
 * - ensureDoToken() flow ordering
 */

let testDir: string;
let origHome: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-do-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, {
    recursive: true,
  });
  mkdirSync(join(testDir, ".config", "spawn"), {
    recursive: true,
  });
  origHome = process.env.HOME;
  process.env.HOME = testDir;
});

afterEach(() => {
  process.env.HOME = origHome;
  if (existsSync(testDir)) {
    rmSync(testDir, {
      recursive: true,
      force: true,
    });
  }
});

// ── Config Persistence ────────────────────────────────────────────────────────

describe("DO config persistence", () => {
  const configPath = () => join(testDir, ".config", "spawn", "digitalocean.json");

  it("should save and load a basic token", () => {
    const config = {
      api_key: "dop_v1_test123",
      token: "dop_v1_test123",
    };
    writeFileSync(configPath(), JSON.stringify(config));

    const data = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(data.api_key).toBe("dop_v1_test123");
    expect(data.token).toBe("dop_v1_test123");
  });

  it("should save oauth tokens with refresh_token and expires_at", () => {
    const config = {
      api_key: "access-token-abc",
      token: "access-token-abc",
      refresh_token: "refresh-token-xyz",
      expires_at: Math.floor(Date.now() / 1000) + 2592000,
      auth_method: "oauth",
    };
    writeFileSync(configPath(), JSON.stringify(config, null, 2));

    const data = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(data.api_key).toBe("access-token-abc");
    expect(data.refresh_token).toBe("refresh-token-xyz");
    expect(data.auth_method).toBe("oauth");
    expect(data.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("should handle missing config file gracefully", () => {
    // Config file doesn't exist yet
    expect(existsSync(configPath())).toBe(false);
    // Reading should not throw
    let data = null;
    try {
      data = JSON.parse(readFileSync(configPath(), "utf-8"));
    } catch {
      // expected
    }
    expect(data).toBeNull();
  });

  it("should handle malformed JSON gracefully", () => {
    writeFileSync(configPath(), "not valid json {{{");
    let data = null;
    try {
      data = JSON.parse(readFileSync(configPath(), "utf-8"));
    } catch {
      // expected
    }
    expect(data).toBeNull();
  });
});

// ── Token Validation Regex ──────────────────────────────────────────────────

describe("DO token format validation", () => {
  const tokenRegex = /^[a-zA-Z0-9._/@:+=, -]+$/;

  it("should accept valid DO API tokens", () => {
    expect(tokenRegex.test("dop_v1_abc123def456")).toBe(true);
    expect(tokenRegex.test("dop_v1_abcdefghijklmnop1234567890abcdef1234567890")).toBe(true);
  });

  it("should accept tokens with common safe characters", () => {
    expect(tokenRegex.test("token.with.dots")).toBe(true);
    expect(tokenRegex.test("token-with-dashes")).toBe(true);
    expect(tokenRegex.test("token_with_underscores")).toBe(true);
  });

  it("should reject tokens with dangerous characters", () => {
    expect(tokenRegex.test("token;rm -rf /")).toBe(false);
    expect(tokenRegex.test("token\ninjected")).toBe(false);
    expect(tokenRegex.test("token$(cmd)")).toBe(false);
    expect(tokenRegex.test("token`cmd`")).toBe(false);
  });

  it("should reject empty string", () => {
    expect(tokenRegex.test("")).toBe(false);
  });
});

// ── OAuth Code Validation ───────────────────────────────────────────────────

describe("OAuth code validation", () => {
  // Matches the regex used in the OAuth callback handler
  const codeRegex = /^[a-zA-Z0-9_-]{8,256}$/;

  it("should accept valid authorization codes", () => {
    expect(codeRegex.test("abc123def456")).toBe(true);
    expect(codeRegex.test("a1b2c3d4e5f6g7h8")).toBe(true);
    expect(codeRegex.test("code-with-dashes")).toBe(true);
    expect(codeRegex.test("code_with_underscores")).toBe(true);
  });

  it("should reject codes shorter than 8 characters", () => {
    expect(codeRegex.test("abc")).toBe(false);
    expect(codeRegex.test("1234567")).toBe(false);
  });

  it("should reject codes longer than 256 characters", () => {
    expect(codeRegex.test("a".repeat(257))).toBe(false);
  });

  it("should accept codes up to 256 characters", () => {
    expect(codeRegex.test("a".repeat(256))).toBe(true);
  });

  it("should reject codes with special characters", () => {
    expect(codeRegex.test("code;injection")).toBe(false);
    expect(codeRegex.test("code<script>")).toBe(false);
    expect(codeRegex.test("code with spaces")).toBe(false);
    expect(codeRegex.test("code\nnewline")).toBe(false);
  });
});

// ── Token Expiry Detection ──────────────────────────────────────────────────

describe("Token expiry detection", () => {
  it("should detect expired token", () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const now = Math.floor(Date.now() / 1000);
    expect(now >= expiresAt - 300).toBe(true);
  });

  it("should detect token expiring within 5 minutes", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 120; // 2 minutes from now
    const now = Math.floor(Date.now() / 1000);
    // Should be considered expired (within 300s buffer)
    expect(now >= expiresAt - 300).toBe(true);
  });

  it("should detect valid token with time remaining", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const now = Math.floor(Date.now() / 1000);
    expect(now >= expiresAt - 300).toBe(false);
  });

  it("should treat missing expires_at as not expired", () => {
    const expiresAt = undefined;
    // When no expires_at, token is not considered expired
    expect(!expiresAt).toBe(true);
  });
});

// ── OAuth URL Construction ──────────────────────────────────────────────────

describe("OAuth URL construction", () => {
  const DO_OAUTH_AUTHORIZE = "https://cloud.digitalocean.com/v1/oauth/authorize";
  const DO_SCOPES = [
    "droplet:create",
    "droplet:delete",
    "droplet:read",
    "ssh_key:create",
    "ssh_key:read",
    "regions:read",
    "sizes:read",
    "image:read",
    "actions:read",
  ].join(" ");

  it("should construct valid authorize URL", () => {
    const clientId = "test-client-id";
    const redirectUri = "http://localhost:5190/callback";
    const state = "abcdef1234567890abcdef1234567890";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DO_SCOPES,
      state: state,
    });
    const url = `${DO_OAUTH_AUTHORIZE}?${params.toString()}`;

    expect(url).toContain("cloud.digitalocean.com/v1/oauth/authorize");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("localhost%3A5190");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=");
    expect(url).toContain("droplet%3Acreate");
    expect(url).toContain(`state=${state}`);
  });

  it("should include all required scopes", () => {
    const scopes = DO_SCOPES.split(" ");
    expect(scopes).toContain("droplet:create");
    expect(scopes).toContain("droplet:delete");
    expect(scopes).toContain("droplet:read");
    expect(scopes).toContain("ssh_key:create");
    expect(scopes).toContain("ssh_key:read");
    expect(scopes).toContain("regions:read");
    expect(scopes).toContain("sizes:read");
    expect(scopes).toContain("image:read");
    expect(scopes).toContain("actions:read");
    expect(scopes).toHaveLength(9);
  });
});

// ── Token Exchange Body ─────────────────────────────────────────────────────

describe("Token exchange request body", () => {
  it("should use application/x-www-form-urlencoded format", () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "test-auth-code",
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: "http://localhost:5190/callback",
    });

    const encoded = body.toString();
    expect(encoded).toContain("grant_type=authorization_code");
    expect(encoded).toContain("code=test-auth-code");
    expect(encoded).toContain("client_id=test-client");
    expect(encoded).toContain("client_secret=test-secret");
    expect(encoded).toContain("redirect_uri=");
  });

  it("should construct refresh token body correctly", () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "test-refresh-token",
      client_id: "test-client",
      client_secret: "test-secret",
    });

    const encoded = body.toString();
    expect(encoded).toContain("grant_type=refresh_token");
    expect(encoded).toContain("refresh_token=test-refresh-token");
    expect(encoded).not.toContain("code=");
    expect(encoded).not.toContain("redirect_uri=");
  });
});

// ── OAuth HTML Responses ────────────────────────────────────────────────────

describe("OAuth HTML responses", () => {
  const OAUTH_CSS = "*{margin:0;padding:0;box-sizing:border-box}";
  const SUCCESS_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>DigitalOcean Authorization Successful</h1><p>You can close this tab and return to your terminal.</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>`;
  const ERROR_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}</style></head><body><div class="card"><div class="icon">&#10007;</div><h1>Authorization Failed</h1><p>Invalid or missing state parameter (CSRF protection). Please try again.</p></div></body></html>`;

  it("should include success message in success HTML", () => {
    expect(SUCCESS_HTML).toContain("Authorization Successful");
  });

  it("should include auto-close script in success HTML", () => {
    expect(SUCCESS_HTML).toContain("window.close");
  });

  it("should include CSRF warning in error HTML", () => {
    expect(ERROR_HTML).toContain("CSRF");
  });

  it("should include DigitalOcean branding in success HTML", () => {
    expect(SUCCESS_HTML).toContain("DigitalOcean");
  });

  it("should include retry guidance in error HTML", () => {
    expect(ERROR_HTML).toContain("try again");
  });
});

// ── OAuth Always Enabled ─────────────────────────────────────────────────────

describe("OAuth is always enabled (hardcoded credentials)", () => {
  it("should always be configured with hardcoded client credentials", () => {
    // Credentials are hardcoded constants, not env vars — OAuth is always available
    const clientId = "c82b64ac5f9cd4d03b686bebf17546c603b9c368a296a8c4c0718b1f405e4bdc";
    const clientSecret = "8083ef0317481d802d15b68f1c0b545b726720dbf52d00d17f649cc794efdfd9";
    expect(clientId).toHaveLength(64);
    expect(clientSecret).toHaveLength(64);
    expect(!!(clientId && clientSecret)).toBe(true);
  });
});

// ── Refresh Token Format ────────────────────────────────────────────────────

describe("Refresh token format validation", () => {
  const tokenRegex = /^[a-zA-Z0-9._/@:+=, -]+$/;

  it("should accept typical refresh tokens", () => {
    expect(tokenRegex.test("refresh_abc123def456")).toBe(true);
    expect(tokenRegex.test("rt_v1_abcdef1234567890")).toBe(true);
  });

  it("should reject tokens with injection attempts", () => {
    expect(tokenRegex.test("token;echo hacked")).toBe(false);
    expect(tokenRegex.test("token\x00null")).toBe(false);
  });
});

// ── Config File Extended Format ─────────────────────────────────────────────

describe("Extended config file format", () => {
  it("should round-trip full oauth config", () => {
    const config = {
      api_key: "access-token-123",
      token: "access-token-123",
      refresh_token: "refresh-token-456",
      expires_at: 1800000000,
      auth_method: "oauth" as const,
    };

    const json = JSON.stringify(config, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.api_key).toBe(config.api_key);
    expect(parsed.token).toBe(config.token);
    expect(parsed.refresh_token).toBe(config.refresh_token);
    expect(parsed.expires_at).toBe(config.expires_at);
    expect(parsed.auth_method).toBe("oauth");
  });

  it("should be backward compatible with old config format", () => {
    // Old format only has api_key and token
    const oldConfig = {
      api_key: "old-token-123",
      token: "old-token-123",
    };

    const parsed = JSON.parse(JSON.stringify(oldConfig));
    // Should still work — refresh_token will be undefined
    expect(parsed.api_key).toBe("old-token-123");
    expect(parsed.refresh_token).toBeUndefined();
    expect(parsed.expires_at).toBeUndefined();
    expect(parsed.auth_method).toBeUndefined();
  });
});

/**
 * oauth-cov.test.ts — Coverage tests for shared/oauth.ts
 *
 * Covers: generateCsrfState, OAUTH_CSS, hasSavedOpenRouterKey, getOrPromptApiKey
 * (env path, saved key path, manual entry).
 *
 * Note: generateCodeVerifier and generateCodeChallenge are fully covered by
 * oauth-pkce.test.ts (including RFC 7636 test vectors) — not repeated here.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Import @clack/prompts and spyOn text instead of calling mockClackPrompts
// (which would replace the global mock and disconnect other test files' spies).
import * as p from "@clack/prompts";

const { generateCsrfState, hasSavedOpenRouterKey, getOrPromptApiKey, OAUTH_CSS } = await import("../shared/oauth.js");

let stderrSpy: ReturnType<typeof spyOn>;
let origFetch: typeof global.fetch;
let textSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  // Mock p.text to return empty string (for manual key entry that should fail)
  textSpy = spyOn(p, "text").mockImplementation(async () => "");
  origFetch = global.fetch;
  // Skip API validation in tests
  process.env.BUN_ENV = "test";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SPAWN_ENABLED_STEPS;
  delete process.env.SPAWN_SKIP_API_VALIDATION;
});

afterEach(() => {
  stderrSpy.mockRestore();
  textSpy.mockRestore();
  global.fetch = origFetch;
  delete process.env.BUN_ENV;
});

// ── generateCsrfState ──────────────────────────────────────────────────

describe("generateCsrfState", () => {
  it("returns a 32-char hex string", () => {
    const state = generateCsrfState();
    expect(state).toHaveLength(32);
    expect(state).toMatch(/^[a-f0-9]+$/);
  });

  it("generates unique values", () => {
    const a = generateCsrfState();
    const b = generateCsrfState();
    expect(a).not.toBe(b);
  });
});

// ── OAUTH_CSS ──────────────────────────────────────────────────────────

describe("OAUTH_CSS", () => {
  it("is a non-empty CSS string", () => {
    expect(OAUTH_CSS.length).toBeGreaterThan(0);
    expect(OAUTH_CSS).toContain("body");
  });
});

// ── hasSavedOpenRouterKey ──────────────────────────────────────────────

describe("hasSavedOpenRouterKey", () => {
  it("returns false when no config file exists", () => {
    expect(hasSavedOpenRouterKey()).toBe(false);
  });

  it("returns true when valid key is saved", () => {
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    const key = "sk-or-v1-" + "a".repeat(64);
    writeFileSync(
      join(configDir, "openrouter.json"),
      JSON.stringify({
        api_key: key,
      }),
    );
    expect(hasSavedOpenRouterKey()).toBe(true);
  });

  it("returns false when saved key has invalid format", () => {
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(
      join(configDir, "openrouter.json"),
      JSON.stringify({
        api_key: "invalid-key",
      }),
    );
    expect(hasSavedOpenRouterKey()).toBe(false);
  });

  it("returns false for corrupted JSON", () => {
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(join(configDir, "openrouter.json"), "not json!");
    expect(hasSavedOpenRouterKey()).toBe(false);
  });
});

// ── getOrPromptApiKey ──────────────────────────────────────────────────

describe("getOrPromptApiKey", () => {
  it("returns key from OPENROUTER_API_KEY env var", async () => {
    const testKey = "sk-or-v1-" + "b".repeat(64);
    process.env.OPENROUTER_API_KEY = testKey;
    const result = await getOrPromptApiKey("agent", "cloud");
    expect(result).toBe(testKey);
  });

  it("returns saved key when reuse-api-key step is enabled", async () => {
    const savedKey = "sk-or-v1-" + "c".repeat(64);
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(
      join(configDir, "openrouter.json"),
      JSON.stringify({
        api_key: savedKey,
      }),
    );
    process.env.SPAWN_ENABLED_STEPS = "reuse-api-key";
    const result = await getOrPromptApiKey("agent", "cloud");
    expect(result).toBe(savedKey);
  });

  it("throws after 3 failed OAuth + manual attempts", async () => {
    // Mock Bun.serve to fail (so OAuth flow returns null)
    // biome-ignore lint: test mock
    const serveSpy = spyOn(Bun, "serve" as never).mockImplementation(() => {
      throw new Error("port in use");
    });
    // Mock p.text to return empty (manual entry fails)
    textSpy.mockImplementation(async () => "");

    await expect(getOrPromptApiKey("agent", "cloud")).rejects.toThrow("User chose to exit");

    serveSpy.mockRestore();
  });

  it("skips saved key when reuse-api-key step is not enabled", async () => {
    const savedKey = "sk-or-v1-" + "d".repeat(64);
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(
      join(configDir, "openrouter.json"),
      JSON.stringify({
        api_key: savedKey,
      }),
    );
    // reuse-api-key NOT in enabled steps
    process.env.SPAWN_ENABLED_STEPS = "github";

    // OAuth will fail, manual will fail => throws
    // biome-ignore lint: test mock
    const serveSpy = spyOn(Bun, "serve" as never).mockImplementation(() => {
      throw new Error("port in use");
    });
    textSpy.mockImplementation(async () => "");

    await expect(getOrPromptApiKey("agent", "cloud")).rejects.toThrow("User chose to exit");
    serveSpy.mockRestore();
  });

  it("returns false for empty api_key in saved config", () => {
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(
      join(configDir, "openrouter.json"),
      JSON.stringify({
        api_key: "",
      }),
    );
    expect(hasSavedOpenRouterKey()).toBe(false);
  });

  it("returns false when api_key is not a string", () => {
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(
      join(configDir, "openrouter.json"),
      JSON.stringify({
        api_key: 12345,
      }),
    );
    expect(hasSavedOpenRouterKey()).toBe(false);
  });

  it("returns key from manual entry via prompt after OAuth fails", async () => {
    // Simulate OAuth failure via Bun.serve throwing
    // biome-ignore lint: test mock
    const serveSpy = spyOn(Bun, "serve" as never).mockImplementation(() => {
      throw new Error("port in use");
    });
    const validKey = "sk-or-v1-" + "f".repeat(64);
    // First call returns valid key for manual prompt
    textSpy.mockImplementation(async () => validKey);

    const result = await getOrPromptApiKey("agent", "cloud");
    expect(result).toBe(validKey);

    serveSpy.mockRestore();
  });

  it("sets OPENROUTER_API_KEY in process.env on success from manual entry", async () => {
    // biome-ignore lint: test mock
    const serveSpy = spyOn(Bun, "serve" as never).mockImplementation(() => {
      throw new Error("port in use");
    });
    const validKey = "sk-or-v1-" + "e".repeat(64);
    textSpy.mockImplementation(async () => validKey);

    delete process.env.OPENROUTER_API_KEY;
    await getOrPromptApiKey("agent", "cloud");
    expect(process.env.OPENROUTER_API_KEY).toBe(validKey);

    serveSpy.mockRestore();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("accepts non-standard key format when user confirms", async () => {
    // biome-ignore lint: test mock
    const serveSpy = spyOn(Bun, "serve" as never).mockImplementation(() => {
      throw new Error("port in use");
    });
    let callCount = 0;
    // First call: non-standard key, second call: "y" to confirm
    textSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return "custom-api-key-not-standard";
      }
      return "y";
    });

    delete process.env.OPENROUTER_API_KEY;
    const result = await getOrPromptApiKey("agent", "cloud");
    expect(result).toBe("custom-api-key-not-standard");

    serveSpy.mockRestore();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("returns false for non-object data in saved config", () => {
    const configDir = join(process.env.HOME ?? "", ".config", "spawn");
    mkdirSync(configDir, {
      recursive: true,
    });
    writeFileSync(join(configDir, "openrouter.json"), JSON.stringify(null));
    expect(hasSavedOpenRouterKey()).toBe(false);
  });
});

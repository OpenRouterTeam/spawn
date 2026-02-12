import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { hasCloudCredentials, parseAuthEnvVars } from "../commands";

describe("hasCloudCredentials", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("returns true when single env var is set", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("returns false when single env var is missing", () => {
    delete process.env.HCLOUD_TOKEN;
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("returns true when all multi-credential vars are set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(true);
  });

  it("returns false when only some multi-credential vars are set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    delete process.env.UPCLOUD_PASSWORD;
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(false);
  });

  it("returns false for CLI-based auth (no env vars)", () => {
    expect(hasCloudCredentials("sprite login")).toBe(false);
  });

  it("returns false for 'none' auth", () => {
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasCloudCredentials("")).toBe(false);
  });

  it("handles env var set to empty string as present", () => {
    process.env.HCLOUD_TOKEN = "";
    // Empty string is falsy, so !! makes it false
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });
});

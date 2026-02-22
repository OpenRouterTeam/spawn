import { describe, it, expect, afterEach } from "bun:test";
import { hasCloudCredentials } from "../commands";

describe("hasCloudCredentials", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Clear saved state
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  it("should return true when single env var is set", () => {
    setEnv("HCLOUD_TOKEN", "test-token");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("should return false when single env var is not set", () => {
    delete process.env["HCLOUD_TOKEN"];
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should return true when all multiple env vars are set", () => {
    setEnv("UPCLOUD_USERNAME", "user");
    setEnv("UPCLOUD_PASSWORD", "pass");
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(true);
  });

  it("should return false when only some env vars are set", () => {
    setEnv("UPCLOUD_USERNAME", "user");
    delete process.env["UPCLOUD_PASSWORD"];
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(false);
  });

  it("should return false for non-env-var auth like 'none'", () => {
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("should return false for CLI-based auth like 'gcloud auth login'", () => {
    expect(hasCloudCredentials("gcloud auth login")).toBe(false);
  });

  it("should return false for auth like 'sprite login'", () => {
    expect(hasCloudCredentials("sprite login")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(hasCloudCredentials("")).toBe(false);
  });

  it("should return false when env var is set to empty string", () => {
    setEnv("HCLOUD_TOKEN", "");
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should handle complex multi-var auth like contabo", () => {
    setEnv("CONTABO_CLIENT_ID", "id");
    setEnv("CONTABO_CLIENT_SECRET", "secret");
    setEnv("CONTABO_API_USER", "user");
    setEnv("CONTABO_API_PASSWORD", "pass");
    expect(
      hasCloudCredentials("CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"),
    ).toBe(true);
  });

  it("should return false for complex auth with one var missing", () => {
    setEnv("CONTABO_CLIENT_ID", "id");
    setEnv("CONTABO_CLIENT_SECRET", "secret");
    setEnv("CONTABO_API_USER", "user");
    delete process.env["CONTABO_API_PASSWORD"];
    expect(
      hasCloudCredentials("CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"),
    ).toBe(false);
  });

  it("should handle auth with mixed text and env vars", () => {
    // e.g. "aws configure (AWS credentials)" - no valid env var names
    expect(hasCloudCredentials("aws configure (AWS credentials)")).toBe(false);
  });
});

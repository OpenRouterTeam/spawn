import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryCatch } from "../shared/result";
import { loadSpawnConfig } from "../shared/spawn-config";

describe("loadSpawnConfig", () => {
  const testDir = join(process.env.HOME ?? "/tmp", ".spawn-config-test");

  beforeEach(() => {
    mkdirSync(testDir, {
      recursive: true,
    });
  });

  afterEach(() => {
    tryCatch(() =>
      rmSync(testDir, {
        recursive: true,
        force: true,
      }),
    );
  });

  it("should load a valid config file", () => {
    const configPath = join(testDir, "valid.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "openai/gpt-5.3-codex",
        steps: [
          "github",
          "browser",
        ],
        name: "my-box",
        setup: {
          telegram_bot_token: "123:ABC",
          github_token: "ghp_test",
        },
      }),
    );

    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    expect(config?.model).toBe("openai/gpt-5.3-codex");
    expect(config?.steps).toEqual([
      "github",
      "browser",
    ]);
    expect(config?.name).toBe("my-box");
    expect(config?.setup?.telegram_bot_token).toBe("123:ABC");
    expect(config?.setup?.github_token).toBe("ghp_test");
  });

  it("should load a minimal config file", () => {
    const configPath = join(testDir, "minimal.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "openai/gpt-4o",
      }),
    );

    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    expect(config?.model).toBe("openai/gpt-4o");
    expect(config?.steps).toBeUndefined();
    expect(config?.name).toBeUndefined();
    expect(config?.setup).toBeUndefined();
  });

  it("should load an empty config file", () => {
    const configPath = join(testDir, "empty.json");
    writeFileSync(configPath, "{}");

    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
  });

  it("should return null for malformed JSON", () => {
    const configPath = join(testDir, "bad.json");
    writeFileSync(configPath, "not json {{{");

    const config = loadSpawnConfig(configPath);
    expect(config).toBeNull();
  });

  it("should throw for missing file", () => {
    expect(() => loadSpawnConfig(join(testDir, "nonexistent.json"))).toThrow();
  });

  it("should throw for file that is too large", () => {
    const configPath = join(testDir, "huge.json");
    // Write a file larger than 1 MB
    writeFileSync(configPath, "x".repeat(1024 * 1024 + 1));
    expect(() => loadSpawnConfig(configPath)).toThrow(/too large/);
  });

  it("should throw for null bytes in path", () => {
    expect(() => loadSpawnConfig("config\0.json")).toThrow(/null bytes/);
  });
});

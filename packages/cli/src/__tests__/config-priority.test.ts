import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryCatch } from "../shared/result";
import { loadSpawnConfig } from "../shared/spawn-config";

/**
 * Tests the priority order: CLI flags > --config > env vars > defaults.
 *
 * These tests simulate the logic in index.ts where:
 *   1. --model sets MODEL_ID env var
 *   2. --config loads a file and applies values only if env var is NOT already set
 *   3. --steps unconditionally overwrites SPAWN_ENABLED_STEPS
 */
describe("Config priority order", () => {
  const testDir = join(process.env.HOME ?? "/tmp", ".spawn-priority-test");
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mkdirSync(testDir, {
      recursive: true,
    });
    savedEnv = {
      MODEL_ID: process.env.MODEL_ID,
      SPAWN_ENABLED_STEPS: process.env.SPAWN_ENABLED_STEPS,
      SPAWN_NAME: process.env.SPAWN_NAME,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    // Clear all relevant env vars
    delete process.env.MODEL_ID;
    delete process.env.SPAWN_ENABLED_STEPS;
    delete process.env.SPAWN_NAME;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    // Restore original env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    tryCatch(() =>
      rmSync(testDir, {
        recursive: true,
        force: true,
      }),
    );
  });

  function writeConfig(filename: string, data: Record<string, unknown>): string {
    const p = join(testDir, filename);
    writeFileSync(p, JSON.stringify(data));
    return p;
  }

  /** Simulate the config-application logic from index.ts */
  function applyConfigAsDefaults(config: NonNullable<ReturnType<typeof loadSpawnConfig>>): void {
    if (config.model && !process.env.MODEL_ID) {
      process.env.MODEL_ID = config.model;
    }
    if (config.steps && !process.env.SPAWN_ENABLED_STEPS) {
      process.env.SPAWN_ENABLED_STEPS = config.steps.join(",");
    }
    if (config.name && !process.env.SPAWN_NAME) {
      process.env.SPAWN_NAME = config.name;
    }
    if (config.setup?.telegram_bot_token && !process.env.TELEGRAM_BOT_TOKEN) {
      process.env.TELEGRAM_BOT_TOKEN = config.setup.telegram_bot_token;
    }
    if (config.setup?.github_token && !process.env.GITHUB_TOKEN) {
      process.env.GITHUB_TOKEN = config.setup.github_token;
    }
  }

  it("--model flag should override config file model", () => {
    // Simulate: --model sets MODEL_ID before config is loaded
    process.env.MODEL_ID = "openai/gpt-5.3-codex";

    const configPath = writeConfig("model-override.json", {
      model: "anthropic/claude-4-sonnet",
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    // CLI flag wins
    expect(process.env.MODEL_ID).toBe("openai/gpt-5.3-codex");
  });

  it("config file model should apply when no --model flag", () => {
    const configPath = writeConfig("model-default.json", {
      model: "anthropic/claude-4-sonnet",
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    expect(process.env.MODEL_ID).toBe("anthropic/claude-4-sonnet");
  });

  it("--steps flag should override config file steps", () => {
    const configPath = writeConfig("steps-override.json", {
      steps: [
        "browser",
        "telegram",
      ],
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    // Config sets SPAWN_ENABLED_STEPS
    expect(process.env.SPAWN_ENABLED_STEPS).toBe("browser,telegram");

    // Then --steps flag overwrites it (simulates index.ts line 850-852)
    const stepsFlag = "github";
    process.env.SPAWN_ENABLED_STEPS = stepsFlag;

    expect(process.env.SPAWN_ENABLED_STEPS).toBe("github");
  });

  it("--steps '' should disable all steps even when config has steps", () => {
    const configPath = writeConfig("steps-empty.json", {
      steps: [
        "browser",
        "telegram",
      ],
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    // --steps "" overwrites
    process.env.SPAWN_ENABLED_STEPS = "";

    expect(process.env.SPAWN_ENABLED_STEPS).toBe("");
  });

  it("--name flag should override config file name", () => {
    process.env.SPAWN_NAME = "cli-name";

    const configPath = writeConfig("name-override.json", {
      name: "config-name",
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    expect(process.env.SPAWN_NAME).toBe("cli-name");
  });

  it("config setup tokens should apply as defaults", () => {
    const configPath = writeConfig("setup-tokens.json", {
      setup: {
        telegram_bot_token: "config-token",
        github_token: "ghp_config",
      },
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("config-token");
    expect(process.env.GITHUB_TOKEN).toBe("ghp_config");
  });

  it("explicit env vars should override config setup tokens", () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-token";
    process.env.GITHUB_TOKEN = "ghp_env";

    const configPath = writeConfig("setup-override.json", {
      setup: {
        telegram_bot_token: "config-token",
        github_token: "ghp_config",
      },
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("env-token");
    expect(process.env.GITHUB_TOKEN).toBe("ghp_env");
  });

  it("all config fields should apply when nothing is pre-set", () => {
    const configPath = writeConfig("full.json", {
      model: "openai/o3",
      steps: [
        "github",
        "browser",
      ],
      name: "full-box",
      setup: {
        telegram_bot_token: "tok123",
        github_token: "ghp_full",
      },
    });
    const config = loadSpawnConfig(configPath);
    expect(config).not.toBeNull();
    applyConfigAsDefaults(config!);

    expect(process.env.MODEL_ID).toBe("openai/o3");
    expect(process.env.SPAWN_ENABLED_STEPS).toBe("github,browser");
    expect(process.env.SPAWN_NAME).toBe("full-box");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("tok123");
    expect(process.env.GITHUB_TOKEN).toBe("ghp_full");
  });
});

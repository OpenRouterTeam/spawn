/**
 * openclaw-config.test.ts — Tests for OpenClaw config generation, gateway auth
 * token threading, Telegram/WhatsApp setup, and USER.md content.
 *
 * Verifies that:
 * - The gateway auth token in openclaw.json matches the browserUrl token
 * - Browser config is included atomically (no separate `openclaw config set`)
 * - Telegram bot tokens are written into the config JSON
 * - USER.md includes messaging channel guidance when selected
 * - Chrome install is gated by enabledSteps
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { tryCatch } from "@openrouter/spawn-shared";
import { toRecord } from "../shared/type-guards";
import { mockClackPrompts } from "./test-helpers";

// ── Mock @clack/prompts (must be before importing agent-setup) ──────────
const clack = mockClackPrompts();

// ── Import the module under test ────────────────────────────────────────
const { createCloudAgents } = await import("../shared/agent-setup");

import type { CloudRunner } from "../shared/agent-setup";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Tracks all commands and uploads sent to the mock runner. */
interface RunnerCapture {
  runner: CloudRunner;
  commands: string[];
  /** Contents of files uploaded via runner.uploadFile, read at upload time. */
  uploadedContents: string[];
}

function createCapturingRunner(): RunnerCapture {
  const commands: string[] = [];
  const uploadedContents: string[] = [];

  const runner: CloudRunner = {
    runServer: mock(async (cmd: string) => {
      commands.push(cmd);
    }),
    uploadFile: mock(async (localPath: string, _remotePath: string) => {
      // Read the file content immediately — uploadConfigFile deletes it right after
      const r = tryCatch(() => readFileSync(localPath, "utf-8"));
      if (r.ok) {
        uploadedContents.push(r.data);
      }
    }),
  };

  return {
    runner,
    commands,
    uploadedContents,
  };
}

/** Find the openclaw.json config from uploaded files. */
function findConfigJson(capture: RunnerCapture): Record<string, unknown> | null {
  for (const content of capture.uploadedContents) {
    const r = tryCatch(() => JSON.parse(content));
    if (r.ok && r.data && typeof r.data === "object" && "gateway" in r.data) {
      return toRecord(r.data);
    }
  }
  return null;
}

/** Find the USER.md content from uploaded files. */
function findUserMd(capture: RunnerCapture): string | null {
  for (const content of capture.uploadedContents) {
    if (content.includes("# User")) {
      return content;
    }
  }
  return null;
}

/** Safely drill into a nested config object. */
function drill(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    const rec = toRecord(current);
    if (rec && key in rec) {
      current = rec[key];
    } else {
      return undefined;
    }
  }
  return current;
}

// ── Test suite ──────────────────────────────────────────────────────────

describe("OpenClaw config (setupOpenclawConfig)", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let savedTelegramToken: string | undefined;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    savedTelegramToken = process.env.SPAWN_TELEGRAM_BOT_TOKEN;
    delete process.env.SPAWN_TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (savedTelegramToken !== undefined) {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = savedTelegramToken;
    } else {
      delete process.env.SPAWN_TELEGRAM_BOT_TOKEN;
    }
  });

  // ── Gateway auth token ──────────────────────────────────────────────

  describe("gateway auth token", () => {
    it("writes gateway.auth.token to openclaw.json", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-test-key", "test-model", new Set([]));

      const config = findConfigJson(capture);
      expect(config).not.toBeNull();

      const token = drill(config!, "gateway", "auth", "token");
      expect(typeof token).toBe("string");
      expect(String(token).length).toBe(32);
    });

    it("browserUrl token matches the gateway.auth.token in config", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-test-key", "test-model", new Set([]));

      const config = findConfigJson(capture);
      const configToken = String(drill(config!, "gateway", "auth", "token"));

      const browserUrl = agents.openclaw.tunnel!.browserUrl!(12345);
      expect(browserUrl).toContain(`?token=${configToken}`);
    });

    it("token is stable across browserUrl calls (same agent instance)", () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      const url1 = agents.openclaw.tunnel!.browserUrl!(8080);
      const url2 = agents.openclaw.tunnel!.browserUrl!(9090);

      const token1 = new URL(url1!).searchParams.get("token");
      const token2 = new URL(url2!).searchParams.get("token");
      expect(token1).toBe(token2);
    });

    it("different createCloudAgents calls generate different tokens", () => {
      const capture1 = createCapturingRunner();
      const capture2 = createCapturingRunner();
      const { agents: agents1 } = createCloudAgents(capture1.runner);
      const { agents: agents2 } = createCloudAgents(capture2.runner);

      const url1 = agents1.openclaw.tunnel!.browserUrl!(8000);
      const url2 = agents2.openclaw.tunnel!.browserUrl!(8000);

      const token1 = new URL(url1!).searchParams.get("token");
      const token2 = new URL(url2!).searchParams.get("token");

      expect(token1).not.toBe(token2);
      expect(token1!.length).toBe(32);
      expect(token2!.length).toBe(32);
    });
  });

  // ── Atomic config write ─────────────────────────────────────────────

  describe("atomic config write", () => {
    it("writes API key, gateway token, and model in a single JSON upload", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-my-api-key", "anthropic/claude-3", new Set([]));

      const config = findConfigJson(capture);
      expect(config).not.toBeNull();

      expect(drill(config!, "env", "OPENROUTER_API_KEY")).toBe("sk-my-api-key");
      expect(drill(config!, "gateway", "mode")).toBe("local");
      expect(drill(config!, "gateway", "auth", "token")).toBeDefined();
      expect(drill(config!, "agents", "defaults", "model", "primary")).toBe("anthropic/claude-3");
    });

    it("does not run openclaw config set commands", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "browser",
        ]),
      );

      const configSetCmds = capture.commands.filter((c) => c.includes("openclaw config set"));
      expect(configSetCmds).toHaveLength(0);
    });

    it("includes browser config in the JSON when browser step is enabled", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "browser",
        ]),
      );

      const config = findConfigJson(capture);
      expect(config!.browser).toBeDefined();
      expect(drill(config!, "browser", "executablePath")).toBe("/usr/bin/google-chrome-stable");
      expect(drill(config!, "browser", "noSandbox")).toBe(true);
      expect(drill(config!, "browser", "headless")).toBe(true);
      expect(drill(config!, "browser", "defaultProfile")).toBe("openclaw");
    });

    it("includes browser config when enabledSteps is undefined (default)", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-key", "model", undefined);

      const config = findConfigJson(capture);
      expect(config!.browser).toBeDefined();
    });

    it("excludes browser config when browser step is not in enabledSteps", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "github",
        ]),
      );

      const config = findConfigJson(capture);
      expect(config!.browser).toBeUndefined();
    });

    it("writes valid JSON with special characters in API key", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!('sk-key-with-"quotes"&special', "model/with/slashes", new Set([]));

      const config = findConfigJson(capture);
      expect(config).not.toBeNull();
      expect(drill(config!, "env", "OPENROUTER_API_KEY")).toBe('sk-key-with-"quotes"&special');
      expect(drill(config!, "agents", "defaults", "model", "primary")).toBe("model/with/slashes");
    });
  });

  // ── Chrome browser install gating ───────────────────────────────────

  describe("Chrome browser install", () => {
    it("installs Chrome when browser step is enabled", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "browser",
        ]),
      );

      const chromeCmd = capture.commands.find((c) => c.includes("google-chrome"));
      expect(chromeCmd).toBeDefined();
    });

    it("installs Chrome when enabledSteps is undefined (default behavior)", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-key", "model", undefined);

      const chromeCmd = capture.commands.find((c) => c.includes("google-chrome"));
      expect(chromeCmd).toBeDefined();
    });

    it("skips Chrome install when browser step is not selected", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "github",
        ]),
      );

      const chromeCmd = capture.commands.find((c) => c.includes("google-chrome"));
      expect(chromeCmd).toBeUndefined();
    });
  });

  // ── Telegram setup ──────────────────────────────────────────────────

  describe("Telegram bot token", () => {
    it("includes Telegram bot token in config JSON when provided", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "12345:ABCdefGhIjKlMnOpQrStUvWxYz";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
        ]),
      );

      const config = findConfigJson(capture);
      expect(drill(config!, "channels", "telegram", "botToken")).toBe("12345:ABCdefGhIjKlMnOpQrStUvWxYz");
    });

    it("trims whitespace from Telegram bot token", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "  bot-token-123  ";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
        ]),
      );

      const config = findConfigJson(capture);
      expect(drill(config!, "channels", "telegram", "botToken")).toBe("bot-token-123");
    });

    it("omits channels from config when Telegram token is empty", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "   ";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
        ]),
      );

      const config = findConfigJson(capture);
      expect(config!.channels).toBeUndefined();
    });

    it("omits channels when no token is provided", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
        ]),
      );

      const config = findConfigJson(capture);
      expect(config!.channels).toBeUndefined();
    });

    it("omits channels from config when Telegram is not in enabledSteps", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "should-not-be-used";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "browser",
        ]),
      );

      const config = findConfigJson(capture);
      expect(config!.channels).toBeUndefined();
    });

    it("gateway auth token is preserved when Telegram token is set", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "my-bot-token";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
          "browser",
        ]),
      );

      const config = findConfigJson(capture);

      const token = drill(config!, "gateway", "auth", "token");
      expect(typeof token).toBe("string");
      expect(String(token).length).toBe(32);
      expect(drill(config!, "channels", "telegram", "botToken")).toBe("my-bot-token");

      const browserUrl = agents.openclaw.tunnel!.browserUrl!(8080);
      expect(browserUrl).toContain(`?token=${token}`);
    });

    it("browser config coexists with Telegram config in same JSON", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "my-token";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
          "browser",
        ]),
      );

      const config = findConfigJson(capture);
      expect(config!.gateway).toBeDefined();
      expect(config!.browser).toBeDefined();
      expect(config!.channels).toBeDefined();
    });
  });

  // ── USER.md content ─────────────────────────────────────────────────

  describe("USER.md generation", () => {
    it("writes USER.md with web dashboard info", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-key", "model", new Set([]));

      const userMd = findUserMd(capture);
      expect(userMd).not.toBeNull();
      expect(userMd).toContain("web dashboard");
      expect(userMd).toContain("18791");
    });

    it("includes Telegram section when Telegram is enabled", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "test-token";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
        ]),
      );

      const userMd = findUserMd(capture);
      expect(userMd).toContain("Messaging Channels");
      expect(userMd).toContain("Telegram");
      expect(userMd).toContain("openclaw config get channels.telegram.botToken");
    });

    it("includes WhatsApp section when WhatsApp is enabled", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "whatsapp",
        ]),
      );

      const userMd = findUserMd(capture);
      expect(userMd).toContain("Messaging Channels");
      expect(userMd).toContain("WhatsApp");
      expect(userMd).toContain("QR code scanning");
      expect(userMd).toContain("http://localhost:18791");
    });

    it("includes both Telegram and WhatsApp when both are enabled", async () => {
      process.env.SPAWN_TELEGRAM_BOT_TOKEN = "bot-token";
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "telegram",
          "whatsapp",
        ]),
      );

      const userMd = findUserMd(capture);
      expect(userMd).toContain("Telegram");
      expect(userMd).toContain("WhatsApp");
    });

    it("omits messaging section when neither Telegram nor WhatsApp is enabled", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!(
        "sk-key",
        "model",
        new Set([
          "browser",
        ]),
      );

      const userMd = findUserMd(capture);
      expect(userMd).not.toBeNull();
      expect(userMd).not.toContain("Messaging Channels");
    });

    it("creates .openclaw/workspace directory before uploading USER.md", async () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      await agents.openclaw.configure!("sk-key", "model", new Set([]));

      const mkdirCmd = capture.commands.find((c) => c.includes("mkdir -p ~/.openclaw/workspace"));
      expect(mkdirCmd).toBeDefined();
    });
  });

  // ── Tunnel config ───────────────────────────────────────────────────

  describe("tunnel config", () => {
    it("openclaw agent has tunnel config targeting port 18791", () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      expect(agents.openclaw.tunnel).toBeDefined();
      expect(agents.openclaw.tunnel!.remotePort).toBe(18791);
    });

    it("browserUrl includes the token as a query parameter", () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      const url = agents.openclaw.tunnel!.browserUrl!(54321);
      expect(url).toMatch(/^http:\/\/localhost:54321\/\?token=[a-f0-9]{32}$/);
    });

    it("browserUrl uses the provided local port", () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      const url1 = agents.openclaw.tunnel!.browserUrl!(8080);
      const url2 = agents.openclaw.tunnel!.browserUrl!(9999);

      expect(url1).toContain("localhost:8080");
      expect(url2).toContain("localhost:9999");
    });

    it("no other agents define tunnel config", () => {
      const capture = createCapturingRunner();
      const { agents } = createCloudAgents(capture.runner);

      for (const [name, agent] of Object.entries(agents)) {
        if (name === "openclaw") {
          continue;
        }
        expect(agent.tunnel).toBeUndefined();
      }
    });
  });
});

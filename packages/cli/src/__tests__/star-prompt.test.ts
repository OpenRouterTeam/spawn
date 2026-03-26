import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { isString } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { parseJsonWith } from "../shared/parse.js";

/**
 * Tests for maybeShowStarPrompt():
 * - Skips on first-time users (< 2 successful spawns)
 * - Shows message to returning users (2+ successful spawns)
 * - Respects 30-day cooldown (skips if shown recently)
 * - Shows again after 30 days have elapsed
 * - Saves starPromptShownAt to preferences after showing
 * - Silently ignores errors
 */

const { maybeShowStarPrompt } = await import("../shared/star-prompt.js");

describe("maybeShowStarPrompt", () => {
  let historyDir: string;
  let prefsPath: string;
  let originalSpawnHome: string | undefined;
  let originalHome: string | undefined;
  let logMessageSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalSpawnHome = process.env.SPAWN_HOME;
    originalHome = process.env.HOME;

    // Use the sandbox HOME set by preload.ts
    const home = process.env.HOME ?? "/tmp/spawn-test-home-star";
    historyDir = join(home, ".spawn");
    prefsPath = join(home, ".config", "spawn", "preferences.json");

    // Clean up any existing history/prefs
    if (existsSync(historyDir)) {
      rmSync(historyDir, {
        recursive: true,
      });
    }
    if (existsSync(prefsPath)) {
      rmSync(prefsPath);
    }

    process.env.SPAWN_HOME = historyDir;
    logMessageSpy = spyOn(p.log, "message").mockImplementation(() => {});
  });

  afterEach(() => {
    logMessageSpy.mockRestore();
    process.env.SPAWN_HOME = originalSpawnHome;
    process.env.HOME = originalHome;
  });

  function writeHistory(
    records: Array<{
      id: string;
      agent: string;
      cloud: string;
      timestamp: string;
      connection?: {
        ip: string;
        user: string;
      };
    }>,
  ) {
    mkdirSync(historyDir, {
      recursive: true,
    });
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify({
        version: 1,
        records,
      }),
    );
  }

  it("skips if fewer than 2 successful spawns", () => {
    writeHistory([
      {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      },
    ]);

    maybeShowStarPrompt();

    expect(logMessageSpy).not.toHaveBeenCalled();
  });

  it("skips if no history at all", () => {
    maybeShowStarPrompt();
    expect(logMessageSpy).not.toHaveBeenCalled();
  });

  it("shows message after 2+ successful spawns", () => {
    writeHistory([
      {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
        },
      },
      {
        id: "2",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.5",
          user: "root",
        },
      },
    ]);

    maybeShowStarPrompt();

    expect(logMessageSpy).toHaveBeenCalledTimes(1);
    const msg = logMessageSpy.mock.calls[0]?.[0];
    expect(isString(msg) && msg.includes("github.com/OpenRouterTeam/spawn")).toBe(true);
  });

  it("saves starPromptShownAt to preferences after showing", () => {
    writeHistory([
      {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
        },
      },
      {
        id: "2",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.5",
          user: "root",
        },
      },
    ]);

    const before = Date.now();
    maybeShowStarPrompt();
    const after = Date.now();

    expect(existsSync(prefsPath)).toBe(true);
    const PrefsSchema = v.object({
      starPromptShownAt: v.optional(v.string()),
    });
    const prefs = parseJsonWith(readFileSync(prefsPath, "utf-8"), PrefsSchema);
    expect(prefs).not.toBeNull();
    expect(typeof prefs?.starPromptShownAt).toBe("string");
    const shownAt = new Date(prefs?.starPromptShownAt ?? "").getTime();
    expect(shownAt).toBeGreaterThanOrEqual(before);
    expect(shownAt).toBeLessThanOrEqual(after);
  });

  it("skips if shown within 30 days", () => {
    writeHistory([
      {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
        },
      },
      {
        id: "2",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.5",
          user: "root",
        },
      },
    ]);

    // Write a recent shownAt timestamp (1 day ago)
    const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mkdirSync(join(prefsPath, ".."), {
      recursive: true,
    });
    writeFileSync(
      prefsPath,
      JSON.stringify({
        starPromptShownAt: recentDate,
      }),
    );

    maybeShowStarPrompt();

    expect(logMessageSpy).not.toHaveBeenCalled();
  });

  it("shows again after 30 days have elapsed", () => {
    writeHistory([
      {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
        },
      },
      {
        id: "2",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.5",
          user: "root",
        },
      },
    ]);

    // Write an old shownAt timestamp (31 days ago)
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    mkdirSync(join(prefsPath, ".."), {
      recursive: true,
    });
    writeFileSync(
      prefsPath,
      JSON.stringify({
        starPromptShownAt: oldDate,
      }),
    );

    maybeShowStarPrompt();

    expect(logMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves existing preferences fields when saving", () => {
    writeHistory([
      {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
        },
      },
      {
        id: "2",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.5",
          user: "root",
        },
      },
    ]);

    mkdirSync(join(prefsPath, ".."), {
      recursive: true,
    });
    writeFileSync(
      prefsPath,
      JSON.stringify({
        models: {
          claude: "anthropic/claude-sonnet-4-6",
        },
      }),
    );

    maybeShowStarPrompt();

    const PrefsWithModelsSchema = v.object({
      models: v.optional(v.record(v.string(), v.string())),
      starPromptShownAt: v.optional(v.string()),
    });
    const prefs = parseJsonWith(readFileSync(prefsPath, "utf-8"), PrefsWithModelsSchema);
    expect(prefs).not.toBeNull();
    expect(prefs?.models?.["claude"]).toBe("anthropic/claude-sonnet-4-6");
    expect(typeof prefs?.starPromptShownAt).toBe("string");
  });
});

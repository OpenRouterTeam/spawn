import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import * as v from "valibot";
import { loadHistory } from "../history.js";
import { parseJsonObj } from "./parse.js";
import { getSpawnPreferencesPath } from "./paths.js";
import { tryCatch } from "./result.js";

const StarPreferencesSchema = v.object({
  starPromptShownAt: v.optional(v.string()),
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SUCCESSFUL_SPAWNS = 2;

/**
 * Show a non-intrusive "star us on GitHub" message after a successful spawn.
 * Only shown to returning users (2+ successful spawns) and at most once per 30 days.
 * Silently skips on any error — this is purely optional UX.
 */
export function maybeShowStarPrompt(): void {
  const result = tryCatch(() => {
    // 1. Count successful spawns (records with a connection field)
    const history = loadHistory();
    const successCount = history.filter((r) => r.connection).length;
    if (successCount < MIN_SUCCESSFUL_SPAWNS) {
      return;
    }

    // 2. Read preferences and check if shown within 30 days
    const prefsPath = getSpawnPreferencesPath();
    const rawPrefs: Record<string, unknown> = existsSync(prefsPath)
      ? (parseJsonObj(readFileSync(prefsPath, "utf-8")) ?? {})
      : {};
    const parsed = v.safeParse(StarPreferencesSchema, rawPrefs);
    if (parsed.success && parsed.output.starPromptShownAt) {
      const shownAt = new Date(parsed.output.starPromptShownAt).getTime();
      if (Date.now() - shownAt < THIRTY_DAYS_MS) {
        return;
      }
    }

    // 3. Print the star message
    p.log.message("⭐ Enjoying Spawn? Star us on GitHub!\n   https://github.com/OpenRouterTeam/spawn");

    // 4. Save the updated timestamp
    const merged = {
      ...rawPrefs,
      starPromptShownAt: new Date().toISOString(),
    };
    mkdirSync(dirname(prefsPath), {
      recursive: true,
    });
    writeFileSync(prefsPath, JSON.stringify(merged, null, 2));
  });
  // Silently ignore errors — star prompt is non-critical
  void result;
}

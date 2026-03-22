import type { Manifest } from "../manifest";

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as v from "valibot";

/**
 * Icon integrity tests.
 *
 * Validates that every agent and cloud icon:
 * - Exists as a .png file in the assets directory
 * - Is actually PNG data (not JPEG mislabeled as .png)
 * - Is referenced correctly in manifest.json (URL ends with .png)
 * - Has a matching .sources.json entry with ext: "png"
 *
 * No .jpg files should exist in the assets directories.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const AGENT_ASSETS = join(REPO_ROOT, "assets/agents");
const CLOUD_ASSETS = join(REPO_ROOT, "assets/clouds");
const AGENT_SOURCES = JSON.parse(readFileSync(join(AGENT_ASSETS, ".sources.json"), "utf-8"));
const CLOUD_SOURCES = JSON.parse(readFileSync(join(CLOUD_ASSETS, ".sources.json"), "utf-8"));

const IconEntry = v.object({
  icon: v.string(),
});

const SourceEntry = v.object({
  ext: v.string(),
});

// PNG magic bytes: 0x89 0x50 0x4E 0x47
const PNG_MAGIC = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
]);

function isPng(filePath: string): boolean {
  const buf = readFileSync(filePath);
  return buf.length >= 4 && buf.subarray(0, 4).equals(PNG_MAGIC);
}

describe("Icon Integrity", () => {
  describe("Agent icons", () => {
    it("all agent icons exist, are valid PNGs, and are correctly referenced", () => {
      for (const id of Object.keys(manifest.agents)) {
        const pngPath = join(AGENT_ASSETS, `${id}.png`);
        expect(existsSync(pngPath), `${id}.png must exist`).toBe(true);
        expect(isPng(pngPath), `${id}.png must contain PNG magic bytes`).toBe(true);
        const parsed = v.parse(IconEntry, manifest.agents[id]);
        expect(parsed.icon, `${id} manifest icon URL must end with .png`).toEndWith(`${id}.png`);
        expect(id in AGENT_SOURCES, `${id} must have a .sources.json entry`).toBe(true);
        const src = v.parse(SourceEntry, AGENT_SOURCES[id]);
        expect(src.ext, `${id} .sources.json ext must be "png"`).toBe("png");
      }
    });

    it("no .jpg files in assets/agents/", () => {
      const files = readdirSync(AGENT_ASSETS);
      const jpgFiles = files.filter((f) => f.endsWith(".jpg"));
      expect(jpgFiles).toEqual([]);
    });
  });

  describe("Cloud icons", () => {
    it("all cloud icons exist, are valid PNGs, and are correctly referenced", () => {
      for (const id of Object.keys(manifest.clouds)) {
        const parsed = v.safeParse(IconEntry, manifest.clouds[id]);
        if (!parsed.success) {
          continue;
        }
        const pngPath = join(CLOUD_ASSETS, `${id}.png`);
        expect(existsSync(pngPath), `${id}.png must exist`).toBe(true);
        expect(isPng(pngPath), `${id}.png must contain PNG magic bytes`).toBe(true);
        expect(parsed.output.icon, `${id} manifest icon URL must end with .png`).toEndWith(`${id}.png`);
        expect(id in CLOUD_SOURCES, `${id} must have a .sources.json entry`).toBe(true);
        const src = v.parse(SourceEntry, CLOUD_SOURCES[id]);
        expect(src.ext, `${id} .sources.json ext must be "png"`).toBe("png");
      }
    });

    it("no .jpg files in assets/clouds/", () => {
      const files = readdirSync(CLOUD_ASSETS);
      const jpgFiles = files.filter((f) => f.endsWith(".jpg"));
      expect(jpgFiles).toEqual([]);
    });
  });
});

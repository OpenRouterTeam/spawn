import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as v from "valibot";
import type { Manifest } from "../manifest";

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
    for (const id of Object.keys(manifest.agents)) {
      const pngPath = join(AGENT_ASSETS, `${id}.png`);

      it(`${id}.png exists`, () => {
        expect(existsSync(pngPath)).toBe(true);
      });

      it(`${id}.png is actual PNG data`, () => {
        if (!existsSync(pngPath)) {
          return;
        }
        expect(isPng(pngPath)).toBe(true);
      });

      it(`${id} manifest icon URL ends with .png`, () => {
        const parsed = v.safeParse(IconEntry, manifest.agents[id]);
        if (parsed.success) {
          expect(parsed.output.icon).toEndWith(`${id}.png`);
        }
      });

      it(`${id} .sources.json ext is "png"`, () => {
        if (id in AGENT_SOURCES) {
          const parsed = v.safeParse(SourceEntry, AGENT_SOURCES[id]);
          if (parsed.success) {
            expect(parsed.output.ext).toBe("png");
          }
        }
      });
    }

    it("no .jpg files in assets/agents/", () => {
      const files = readdirSync(AGENT_ASSETS);
      const jpgFiles = files.filter((f) => f.endsWith(".jpg"));
      expect(jpgFiles).toEqual([]);
    });
  });

  describe("Cloud icons", () => {
    for (const id of Object.keys(manifest.clouds)) {
      const parsed = v.safeParse(IconEntry, manifest.clouds[id]);
      if (!parsed.success) {
        continue;
      }

      const pngPath = join(CLOUD_ASSETS, `${id}.png`);

      it(`${id}.png exists`, () => {
        expect(existsSync(pngPath)).toBe(true);
      });

      it(`${id}.png is actual PNG data`, () => {
        if (!existsSync(pngPath)) {
          return;
        }
        expect(isPng(pngPath)).toBe(true);
      });

      it(`${id} manifest icon URL ends with .png`, () => {
        expect(parsed.output.icon).toEndWith(`${id}.png`);
      });

      it(`${id} .sources.json ext is "png"`, () => {
        if (id in CLOUD_SOURCES) {
          const src = v.safeParse(SourceEntry, CLOUD_SOURCES[id]);
          if (src.success) {
            expect(src.output.ext).toBe("png");
          }
        }
      });
    }

    it("no .jpg files in assets/clouds/", () => {
      const files = readdirSync(CLOUD_ASSETS);
      const jpgFiles = files.filter((f) => f.endsWith(".jpg"));
      expect(jpgFiles).toEqual([]);
    });
  });
});

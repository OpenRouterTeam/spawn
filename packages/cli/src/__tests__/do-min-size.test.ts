/**
 * do-min-size.test.ts — Verify DigitalOcean minimum droplet size enforcement.
 *
 * Ensures the min-size check compares RAM (not exact slug strings),
 * so any size below the agent's minimum gets upgraded.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI_SRC = resolve(import.meta.dir, "..");
const source = readFileSync(resolve(CLI_SRC, "digitalocean/main.ts"), "utf-8");

describe("DigitalOcean minimum droplet size enforcement", () => {
  it("uses slugRamGb comparison instead of hardcoded slug equality", () => {
    // The old bug: dropletSize === "s-2vcpu-2gb" only caught the exact default
    expect(source).not.toContain('dropletSize === "s-2vcpu-2gb"');
    // The fix: compare RAM parsed from slugs
    expect(source).toContain("slugRamGb(dropletSize) < slugRamGb(minSize)");
  });

  it("defines slugRamGb helper to parse RAM from DO slugs", () => {
    expect(source).toContain("function slugRamGb(slug: string): number");
    // Should use a regex to extract the GB number from the slug
    expect(source).toContain("(\\d+)gb");
  });

  it("AGENT_MIN_SIZE includes openclaw with 4gb minimum", () => {
    expect(source).toContain('openclaw: "s-2vcpu-4gb"');
  });
});

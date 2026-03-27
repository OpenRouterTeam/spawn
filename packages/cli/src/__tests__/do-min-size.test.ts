/**
 * do-min-size.test.ts — Verify DigitalOcean minimum droplet size enforcement.
 *
 * Ensures the min-size check compares RAM (not exact slug strings),
 * so any size below the agent's minimum gets upgraded.
 */

import { describe, expect, it } from "bun:test";
import { AGENT_MIN_SIZE, slugRamGb } from "../digitalocean/digitalocean.js";

describe("slugRamGb", () => {
  it("parses RAM from standard DO slugs", () => {
    expect(slugRamGb("s-2vcpu-2gb")).toBe(2);
    expect(slugRamGb("s-2vcpu-4gb")).toBe(4);
    expect(slugRamGb("s-4vcpu-8gb")).toBe(8);
  });

  it("parses RAM from intel-variant slugs", () => {
    expect(slugRamGb("s-2vcpu-4gb-intel")).toBe(4);
    expect(slugRamGb("s-2vcpu-2gb-intel")).toBe(2);
  });

  it("returns 0 for unparseable slugs", () => {
    expect(slugRamGb("")).toBe(0);
    expect(slugRamGb("unknown-slug")).toBe(0);
    expect(slugRamGb("s-2vcpu")).toBe(0);
  });

  it("allows RAM comparison between slugs for min-size enforcement", () => {
    // a 2gb slug is below the 4gb minimum
    expect(slugRamGb("s-2vcpu-2gb")).toBeLessThan(slugRamGb("s-2vcpu-4gb"));
    // a 4gb slug satisfies the 4gb minimum
    expect(slugRamGb("s-2vcpu-4gb")).not.toBeLessThan(slugRamGb("s-2vcpu-4gb"));
    // an 8gb slug also satisfies the 4gb minimum
    expect(slugRamGb("s-4vcpu-8gb")).toBeGreaterThan(slugRamGb("s-2vcpu-4gb"));
  });
});

describe("AGENT_MIN_SIZE", () => {
  it("requires at least 4GB for openclaw", () => {
    const minSlug = AGENT_MIN_SIZE["openclaw"];
    expect(minSlug).toBeDefined();
    expect(slugRamGb(minSlug!)).toBeGreaterThanOrEqual(4);
  });

  it("maps agent names to valid DO slugs", () => {
    for (const [agent, slug] of Object.entries(AGENT_MIN_SIZE)) {
      expect(typeof agent).toBe("string");
      expect(slugRamGb(slug)).toBeGreaterThan(0);
    }
  });
});

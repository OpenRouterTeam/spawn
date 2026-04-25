// Unit tests for the spawn.md parser

import { describe, expect, it } from "bun:test";
import { parseSpawnMd } from "../shared/spawn-md.js";

describe("parseSpawnMd", () => {
  it("parses a complete frontmatter block", () => {
    const content = `---
name: my-template
description: A test template
setup:
  - type: cli_auth
    name: Vercel CLI
    command: vercel login
    description: Authenticate with Vercel
  - type: api_key
    name: STRIPE_KEY
    description: Stripe live key
mcp_servers:
  - name: github
    command: gh-mcp
    args: ["serve"]
    env:
      GH_TOKEN: \${GH_TOKEN}
setup_commands:
  - npm install
  - npm run build
---

# my-template

Body content here.
`;
    const config = parseSpawnMd(content);
    expect(config).not.toBeNull();
    if (!config) {
      return;
    }
    expect(config.name).toBe("my-template");
    expect(config.description).toBe("A test template");
    expect(config.setup).toHaveLength(2);
    expect(config.setup?.[0]).toMatchObject({
      type: "cli_auth",
      name: "Vercel CLI",
      command: "vercel login",
    });
    expect(config.setup?.[1]).toMatchObject({
      type: "api_key",
      name: "STRIPE_KEY",
    });
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers?.[0].name).toBe("github");
    expect(config.mcp_servers?.[0].args).toEqual([
      "serve",
    ]);
    expect(config.mcp_servers?.[0].env).toEqual({
      GH_TOKEN: "${GH_TOKEN}",
    });
    expect(config.setup_commands).toEqual([
      "npm install",
      "npm run build",
    ]);
  });

  it("returns null for content with no frontmatter", () => {
    expect(parseSpawnMd("# Just a body, no frontmatter\n")).toBeNull();
    expect(parseSpawnMd("")).toBeNull();
  });

  it("returns null for invalid frontmatter shape", () => {
    const content = `---
setup:
  - type: not_a_real_type
    name: bad
---
`;
    expect(parseSpawnMd(content)).toBeNull();
  });

  it("accepts a frontmatter with only name", () => {
    const content = `---
name: minimal
---
body
`;
    const config = parseSpawnMd(content);
    expect(config?.name).toBe("minimal");
    expect(config?.setup).toBeUndefined();
    expect(config?.mcp_servers).toBeUndefined();
  });
});

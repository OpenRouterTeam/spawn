// Unit tests for the pure helpers in commands/export.ts
// (CLI catalog, MCP scanners, secret content scanner).

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing } from "../commands/export.js";

const {
  parseProbeOutput,
  entriesFromCodexToml,
  entriesFromJsonMcpServers,
  entriesFromJsonRoot,
  dedupeMcpServers,
  buildSetupFromCliScan,
  scanForSecrets,
} = __testing;

describe("entriesFromJsonMcpServers", () => {
  it("extracts mcpServers from a Claude/Cursor settings shape", () => {
    const json = JSON.stringify({
      mcpServers: {
        github: {
          command: "gh-mcp",
          args: [
            "serve",
          ],
          env: {
            GH_TOKEN: "secret",
          },
        },
      },
    });
    const out = entriesFromJsonMcpServers(json);
    expect(out.github.command).toBe("gh-mcp");
    expect(out.github.args).toEqual([
      "serve",
    ]);
    expect(out.github.env).toEqual({
      GH_TOKEN: "secret",
    });
  });

  it("returns {} for malformed JSON", () => {
    expect(entriesFromJsonMcpServers("not json")).toEqual({});
  });
});

describe("entriesFromJsonRoot", () => {
  it("accepts a root-level entries object", () => {
    const json = JSON.stringify({
      svr: {
        command: "x",
        args: [],
      },
    });
    expect(entriesFromJsonRoot(json).svr.command).toBe("x");
  });

  it("falls back to mcpServers shape", () => {
    const json = JSON.stringify({
      mcpServers: {
        svr: {
          command: "y",
          args: [],
        },
      },
    });
    expect(entriesFromJsonRoot(json).svr.command).toBe("y");
  });
});

describe("entriesFromCodexToml", () => {
  it("parses [mcp_servers.NAME] sections with env subsection", () => {
    const toml = `
[mcp_servers.fs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
[mcp_servers.fs.env]
NODE_ENV = "production"

[mcp_servers.weather]
command = "weather-mcp"
args = []
`;
    const out = entriesFromCodexToml(toml);
    expect(out.fs.command).toBe("npx");
    expect(out.fs.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/data",
    ]);
    expect(out.fs.env).toEqual({
      NODE_ENV: "production",
    });
    expect(out.weather.command).toBe("weather-mcp");
    expect(out.weather.args).toEqual([]);
  });

  it("ignores non-mcp_servers TOML sections", () => {
    const toml = `
model = "openai/gpt-5"
[model_providers.openrouter]
name = "OpenRouter"
[mcp_servers.foo]
command = "foo"
args = []
`;
    expect(Object.keys(entriesFromCodexToml(toml))).toEqual([
      "foo",
    ]);
  });
});

describe("parseProbeOutput", () => {
  const FRAME = "===SPAWN_EXPORT_FRAME===";
  it("splits CLI and MCP frames", () => {
    const raw = `${FRAME}
CLI_BIN=gh
Logged in to github.com as alice
${FRAME}
CLI_BIN=vercel
alice
${FRAME}
MCP_PATH=/home/u/.claude/settings.json
MCP_FORMAT=json-mcpservers
{"mcpServers":{"x":{"command":"c","args":[]}}}
${FRAME}END
`;
    const scan = parseProbeOutput(raw);
    expect(scan.clis.get("gh")).toContain("Logged in");
    expect(scan.clis.get("vercel")).toContain("alice");
    expect(scan.mcps).toHaveLength(1);
    expect(scan.mcps[0].format).toBe("json-mcpservers");
  });

  it("ignores empty MCP files", () => {
    const raw = `${FRAME}
MCP_PATH=/home/u/.claude/settings.json
MCP_FORMAT=json-mcpservers

${FRAME}END
`;
    expect(parseProbeOutput(raw).mcps).toEqual([]);
  });
});

describe("buildSetupFromCliScan", () => {
  it("maps gh to the built-in github step", () => {
    const clis = new Map([
      [
        "gh",
        "Logged in to github.com",
      ],
    ]);
    const { setup, steps } = buildSetupFromCliScan(clis);
    expect(steps).toContain("github");
    expect(setup.find((s) => s.name === "GitHub CLI")).toBeUndefined();
  });

  it("emits cli_auth steps for non-github authed CLIs", () => {
    const clis = new Map([
      [
        "vercel",
        "alice\n",
      ],
      [
        "stripe",
        "test_mode_api_key = sk_test_xxx\n",
      ],
    ]);
    const { setup } = buildSetupFromCliScan(clis);
    const names = setup.map((s) => s.name);
    expect(names).toContain("Vercel CLI");
    expect(names).toContain("Stripe CLI");
  });

  it("ignores CLIs whose status output doesn't match auth markers", () => {
    const clis = new Map([
      [
        "vercel",
        "Error: Not authenticated\n",
      ],
    ]);
    expect(buildSetupFromCliScan(clis).setup).toEqual([]);
  });
});

describe("dedupeMcpServers", () => {
  it("dedupes by name and replaces env values with placeholders", () => {
    const json = JSON.stringify({
      mcpServers: {
        gh: {
          command: "gh-mcp",
          args: [],
          env: {
            GH_TOKEN: "secret",
          },
        },
      },
    });
    const dup = JSON.stringify({
      mcpServers: {
        gh: {
          command: "different",
          args: [],
        },
      },
    });
    const out = dedupeMcpServers([
      {
        path: "/a",
        format: "json-mcpservers",
        content: json,
      },
      {
        path: "/b",
        format: "json-mcpservers",
        content: dup,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe("gh-mcp");
    expect(out[0].env).toEqual({
      GH_TOKEN: "${GH_TOKEN}",
    });
  });
});

describe("scanForSecrets", () => {
  it("detects PEM private keys, AWS keys, and PATs", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-secret-test-"));
    writeFileSync(join(dir, "harmless.md"), "hello world\n");
    writeFileSync(join(dir, "key.pem"), "-----BEGIN OPENSSH PRIVATE KEY-----\nfoo\n");
    writeFileSync(join(dir, "creds.txt"), "AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n");
    writeFileSync(join(dir, "tokens.txt"), "GH=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    const hits = scanForSecrets(dir);
    rmSync(dir, {
      recursive: true,
    });
    const labels = hits.map((h) => `${h.relativePath}:${h.label}`).sort();
    expect(labels).toContain("creds.txt:AWS access key");
    expect(labels).toContain("key.pem:PEM private key");
    expect(labels).toContain("tokens.txt:GitHub PAT");
    expect(hits.find((h) => h.relativePath === "harmless.md")).toBeUndefined();
  });

  it("skips known binary file extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-secret-test-bin-"));
    // PEM-looking content but in a .png file — should be skipped
    writeFileSync(join(dir, "logo.png"), "-----BEGIN PRIVATE KEY-----\n");
    const hits = scanForSecrets(dir);
    rmSync(dir, {
      recursive: true,
    });
    expect(hits).toEqual([]);
  });
});

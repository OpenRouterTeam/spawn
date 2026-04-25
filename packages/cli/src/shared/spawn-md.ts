// shared/spawn-md.ts — Parse and apply spawn.md template files
//
// spawn.md lives at the root of a user's repo and declares the "recipe" for
// setting up an agent: custom auth flows, MCP servers, and setup commands.
// It never contains actual secrets — env values are placeholders like
// ${MY_TOKEN} and the user fills them in at replay time.

import type { CloudRunner } from "./agent-setup.js";

import * as v from "valibot";
import { asyncTryCatch, tryCatch } from "./result.js";
import { logInfo, logStep, logWarn, openBrowser } from "./ui.js";

// ── YAML frontmatter parsing ───────────────────────────────────────────────
// spawn.md uses a subset of YAML in the frontmatter (between --- delimiters).
// We parse it with a minimal hand-rolled parser to avoid adding a YAML dep.

/** Split spawn.md content into { frontmatter, body } */
function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return {
      frontmatter: "",
      body: content,
    };
  }
  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return {
      frontmatter: "",
      body: content,
    };
  }
  const frontmatter = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();
  return {
    frontmatter,
    body,
  };
}

function parseYamlScalar(s: string): string | number | boolean {
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const num = Number(s);
  if (!Number.isNaN(num) && s !== "") {
    return num;
  }
  return s;
}

/** Helper to treat target as a record and set a key */
function setOnRecord(target: Record<string, unknown> | unknown[], key: string, val: unknown): void {
  if (Array.isArray(target)) {
    return;
  }
  target[key] = val;
}

/** Helper to get from a record by key */
function getFromRecord(target: Record<string, unknown> | unknown[], key: string): unknown {
  if (Array.isArray(target)) {
    return undefined;
  }
  return target[key];
}

/**
 * Minimal YAML-to-JSON parser for spawn.md frontmatter.
 * Handles: scalars, arrays of scalars, arrays of objects, nested objects.
 * Does NOT handle: anchors, tags, multi-line strings. Intentionally simple.
 */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const lines = yaml.split("\n");
  const result: Record<string, unknown> = {};

  type Frame = {
    indent: number;
    target: Record<string, unknown> | unknown[];
    key?: string;
  };
  const stack: Frame[] = [
    {
      indent: -1,
      target: result,
    },
  ];

  const currentFrame = (): Frame => stack[stack.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const indent = line.length - trimmed.length;

    // Pop stack to find the right nesting level
    while (stack.length > 1 && indent <= currentFrame().indent) {
      stack.pop();
    }

    // Array item: "- value" or "- key: value"
    if (trimmed.startsWith("- ")) {
      const itemContent = trimmed.slice(2).trim();
      const frame = currentFrame();
      let targetArray: unknown[] | null = null;

      if (Array.isArray(frame.target)) {
        targetArray = frame.target;
      } else if (frame.key) {
        const existing = getFromRecord(frame.target, frame.key);
        if (Array.isArray(existing)) {
          targetArray = existing;
        }
      }

      if (!targetArray) {
        continue;
      }

      // Check if item is a key-value pair (object in array)
      const colonIdx = itemContent.indexOf(":");
      if (colonIdx > 0 && !itemContent.startsWith("[") && !itemContent.startsWith('"')) {
        const key = itemContent.slice(0, colonIdx).trim();
        const val = itemContent.slice(colonIdx + 1).trim();
        const obj: Record<string, unknown> = {};
        obj[key] = parseYamlScalar(val);
        targetArray.push(obj);
        stack.push({
          indent: indent + 1,
          target: obj,
        });
        continue;
      }

      // Flow sequence: [a, b, c]
      if (itemContent.startsWith("[") && itemContent.endsWith("]")) {
        const inner = itemContent.slice(1, -1);
        targetArray.push(inner.split(",").map((s) => parseYamlScalar(s.trim())));
        continue;
      }

      targetArray.push(parseYamlScalar(itemContent));
      continue;
    }

    // Key-value pair: "key: value"
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const rawVal = trimmed.slice(colonIdx + 1).trim();
      const frame = currentFrame();
      const target = frame.target;

      if (Array.isArray(target)) {
        continue;
      }

      if (rawVal === "" || rawVal === "|" || rawVal === ">") {
        const nextLine = lines[i + 1];
        if (nextLine !== undefined) {
          const nextTrimmed = nextLine.trimStart();
          if (nextTrimmed.startsWith("- ")) {
            const arr: unknown[] = [];
            setOnRecord(target, key, arr);
            stack.push({
              indent,
              target: arr,
              key,
            });
            continue;
          }
          const obj: Record<string, unknown> = {};
          setOnRecord(target, key, obj);
          stack.push({
            indent,
            target: obj,
            key,
          });
          continue;
        }
        setOnRecord(target, key, "");
        continue;
      }

      // Flow sequence: key: [a, b, c]
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        const inner = rawVal.slice(1, -1);
        setOnRecord(
          target,
          key,
          inner.split(",").map((s) => parseYamlScalar(s.trim())),
        );
        continue;
      }

      setOnRecord(target, key, parseYamlScalar(rawVal));
    }
  }

  return result;
}

// ── Valibot schemas ────────────────────────────────────────────────────────

const OAuthSetupSchema = v.object({
  type: v.literal("oauth"),
  name: v.string(),
  url: v.string(),
  description: v.optional(v.string()),
});

const CliAuthSetupSchema = v.object({
  type: v.literal("cli_auth"),
  name: v.string(),
  command: v.string(),
  description: v.optional(v.string()),
});

const ApiKeySetupSchema = v.object({
  type: v.literal("api_key"),
  name: v.string(),
  description: v.optional(v.string()),
  guide_url: v.optional(v.string()),
});

const CommandSetupSchema = v.object({
  type: v.literal("command"),
  name: v.optional(v.string()),
  command: v.string(),
  description: v.optional(v.string()),
});

const SetupStepSchema = v.union([
  OAuthSetupSchema,
  CliAuthSetupSchema,
  ApiKeySetupSchema,
  CommandSetupSchema,
]);

const McpServerEntrySchema = v.object({
  name: v.string(),
  command: v.string(),
  args: v.array(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});

export const SpawnMdSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  // Built-in steps (github, auto-update, etc.) go in the CLI --steps flag,
  // not here.  spawn.md only handles custom setup that Spawn doesn't know about.
  setup: v.optional(v.array(SetupStepSchema)),
  mcp_servers: v.optional(v.array(McpServerEntrySchema)),
  setup_commands: v.optional(v.array(v.string())),
});

export type SpawnMdConfig = v.InferOutput<typeof SpawnMdSchema>;
type SetupStep = v.InferOutput<typeof SetupStepSchema>;
type McpServerEntry = v.InferOutput<typeof McpServerEntrySchema>;

// ── Parsing ────────────────────────────────────────────────────────────────

/** Parse spawn.md content into a typed config. Returns null on parse failure. */
export function parseSpawnMd(content: string): SpawnMdConfig | null {
  const { frontmatter } = splitFrontmatter(content);
  if (!frontmatter) {
    return null;
  }

  const raw = parseYamlFrontmatter(frontmatter);
  const result = v.safeParse(SpawnMdSchema, raw);
  if (!result.success) {
    logWarn("spawn.md has invalid frontmatter — ignoring");
    return null;
  }
  return result.output;
}

// ── Applying spawn.md on a VM ──────────────────────────────────────────────

/** Read and parse spawn.md from a remote VM */
export async function readRemoteSpawnMd(runner: CloudRunner): Promise<SpawnMdConfig | null> {
  const catResult = await captureCommand(runner, "cat ~/project/spawn.md 2>/dev/null");
  if (catResult) {
    return parseSpawnMd(catResult);
  }
  return null;
}

/** Run a command on the remote and capture its stdout */
async function captureCommand(runner: CloudRunner, cmd: string): Promise<string | null> {
  const tmpFile = `/tmp/spawn-capture-${Date.now()}`;
  const { readFileSync, unlinkSync } = await import("node:fs");
  const result = await asyncTryCatch(async () => {
    await runner.runServer(`${cmd} > ${tmpFile} 2>/dev/null; true`);
    await runner.downloadFile(tmpFile, tmpFile);
    const content = readFileSync(tmpFile, "utf-8");
    const cleanupResult = tryCatch(() => unlinkSync(tmpFile));
    // ignore local cleanup failure
    void cleanupResult;
    await asyncTryCatch(() => runner.runServer(`rm -f ${tmpFile}`));
    return content || null;
  });
  if (!result.ok) {
    return null;
  }
  return result.data;
}

/**
 * Apply custom setup steps from spawn.md onto a running VM.
 * Built-in `steps` (github, auto-update, etc.) are handled by the existing
 * postInstall infrastructure — this function only handles the `setup` array,
 * `mcp_servers`, and `setup_commands`.
 */
export async function applySpawnMdSetup(runner: CloudRunner, config: SpawnMdConfig, agentName: string): Promise<void> {
  if (config.setup && config.setup.length > 0) {
    logStep("Running template setup steps...");
    for (const step of config.setup) {
      await applySetupStep(runner, step);
    }
  }

  if (config.mcp_servers && config.mcp_servers.length > 0) {
    logStep("Installing MCP servers from template...");
    await installMcpServersFromTemplate(runner, config.mcp_servers, agentName);
  }

  if (config.setup_commands && config.setup_commands.length > 0) {
    logStep("Running template setup commands...");
    for (const cmd of config.setup_commands) {
      logInfo(`  Running: ${cmd}`);
      const cmdResult = await asyncTryCatch(() => runner.runServer(`cd ~/project 2>/dev/null; ${cmd}`));
      if (!cmdResult.ok) {
        logWarn(`  Setup command failed: ${cmd}`);
      }
    }
  }
}

async function applySetupStep(runner: CloudRunner, step: SetupStep): Promise<void> {
  switch (step.type) {
    case "oauth": {
      logInfo(`  ${step.name}: Opening ${step.url}`);
      if (step.description) {
        logInfo(`    ${step.description}`);
      }
      openBrowser(step.url);
      logInfo("    Complete the OAuth flow in your browser, then press Enter to continue.");
      await waitForEnter();
      break;
    }
    case "cli_auth": {
      logInfo(`  ${step.name}: Running ${step.command}`);
      if (step.description) {
        logInfo(`    ${step.description}`);
      }
      const authResult = await asyncTryCatch(() => runner.runServer(step.command));
      if (authResult.ok) {
        logInfo(`    ${step.name} authenticated`);
      } else {
        logWarn(`    ${step.name} auth failed — you can run it manually later: ${step.command}`);
      }
      break;
    }
    case "api_key": {
      logInfo(`  ${step.name}: API key required`);
      if (step.description) {
        logInfo(`    ${step.description}`);
      }
      if (step.guide_url) {
        logInfo(`    Get your key: ${step.guide_url}`);
        openBrowser(step.guide_url);
      }
      const value = await promptSecret(`  Enter ${step.name}: `);
      if (value) {
        const escapedName = step.name.replace(/[^A-Za-z0-9_]/g, "");
        const b64Val = Buffer.from(value).toString("base64");
        // Store as NAME=BASE64VALUE (not shell-executable) to prevent injection
        await runner.runServer(
          `mkdir -p /etc/spawn && printf '%s=%s\\n' '${escapedName}' '${b64Val}' >> /etc/spawn/secrets && chmod 600 /etc/spawn/secrets`,
        );
        // Install a loader that decodes base64 at source-time instead of shell-sourcing
        const loaderSnippet =
          'while IFS="=" read -r k v; do [ -n "$k" ] && export "$k=$(printf "%s" "$v" | base64 -d)"; done < /etc/spawn/secrets';
        await runner.runServer(
          `grep -q 'while IFS.*secrets' ~/.bashrc 2>/dev/null || { sed -i '/source.*\\/etc\\/spawn\\/secrets/d' ~/.bashrc 2>/dev/null; echo '${loaderSnippet}' >> ~/.bashrc; }`,
        );
        logInfo(`    ${step.name} saved`);
      } else {
        logWarn(`    No value provided for ${step.name} — set it later in /etc/spawn/secrets`);
      }
      break;
    }
    case "command": {
      const label = step.name ?? step.command;
      logInfo(`  Running: ${label}`);
      if (step.description) {
        logInfo(`    ${step.description}`);
      }
      const runResult = await asyncTryCatch(() => runner.runServer(step.command));
      if (!runResult.ok) {
        logWarn(`  Command failed: ${step.command}`);
      }
      break;
    }
  }
}

/** Install MCP servers from spawn.md template into agent config */
async function installMcpServersFromTemplate(
  runner: CloudRunner,
  servers: McpServerEntry[],
  agentName: string,
): Promise<void> {
  const record: Record<
    string,
    {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  > = {};
  for (const server of servers) {
    record[server.name] = server.env
      ? {
          command: server.command,
          args: server.args,
          env: server.env,
        }
      : {
          command: server.command,
          args: server.args,
        };
  }

  const { installClaudeMcpServers, installCursorMcpServers, installCodexMcpServers, installGenericMcpServers } =
    await import("./skills.js");
  const installResult = await asyncTryCatch(async () => {
    if (agentName === "claude") {
      await installClaudeMcpServers(runner, record);
    } else if (agentName === "cursor") {
      await installCursorMcpServers(runner, record);
    } else if (agentName === "codex") {
      await installCodexMcpServers(runner, record);
    } else {
      await installGenericMcpServers(runner, agentName, record);
    }
  });
  if (installResult.ok) {
    logInfo(`  Installed ${servers.length} MCP server${servers.length > 1 ? "s" : ""}`);
  } else {
    logWarn("  MCP server installation failed — configure manually");
  }
}

/** Wait for the user to press Enter */
async function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve();
      return;
    }
    const onData = (): void => {
      process.stdin.removeListener("data", onData);
      resolve();
    };
    process.stdin.once("data", onData);
  });
}

/** Prompt for a secret value (no echo) */
async function promptSecret(message: string): Promise<string> {
  process.stderr.write(message);
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    const wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (data: Buffer): void => {
      const ch = data.toString();
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(buf);
        return;
      }
      if (ch === "\x03") {
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve("");
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
        }
        return;
      }
      buf += ch;
    };
    process.stdin.on("data", onData);
  });
}

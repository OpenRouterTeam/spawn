// commands/export.ts — Export a running spawn's setup as a shareable template
//
// SSHes into a VM from spawn history, scans what's installed (MCP servers,
// CLI auths, tools), publishes ~/project to a public GitHub repo (filtering
// secrets), and prints a one-liner command for others to replicate the setup.

import type { SpawnMdConfig } from "../shared/spawn-md.js";

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as p from "@clack/prompts";
import { isString } from "@openrouter/spawn-shared";
import pc from "picocolors";
import * as v from "valibot";
import { loadHistory } from "../history.js";
import { loadManifest } from "../manifest.js";
import { validateConnectionIP, validateIdentifier, validateUsername } from "../security.js";
import { parseJsonWith } from "../shared/parse.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { generateSpawnMd } from "../shared/spawn-md.js";
import { SSH_BASE_OPTS } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { buildRecordLabel, buildRecordSubtitle } from "./list.js";
import { handleCancel, isInteractiveTTY } from "./shared.js";

// ── MCP scan sources ───────────────────────────────────────────────────────
// Each spawned agent stores MCP server configs at a known path. We scan all of
// them regardless of agent so a Claude template can include MCPs the user added
// directly to Cursor, etc.
type McpFormat = "json-mcpservers" | "json-root" | "codex-toml";

interface McpSource {
  path: string;
  format: McpFormat;
}

const MCP_SOURCES: McpSource[] = [
  {
    path: "$HOME/.claude/settings.json",
    format: "json-mcpservers",
  },
  {
    path: "$HOME/.claude.json",
    format: "json-mcpservers",
  },
  {
    path: "$HOME/.cursor/mcp.json",
    format: "json-mcpservers",
  },
  {
    path: "$HOME/.codex/config.toml",
    format: "codex-toml",
  },
  {
    path: "$HOME/.openclaw/openclaw.json",
    format: "json-root",
  },
];

// ── CLI auth catalog ───────────────────────────────────────────────────────
// `bin` is what we probe with `command -v`. `statusCmd` runs on the VM and
// must exit 0 (or print one of `markers`) when the CLI is authed. `authCmd`
// is what the template recipient runs to re-auth.
interface CliProbe {
  bin: string;
  name: string;
  statusCmd: string;
  authCmd: string;
  markers: RegExp[];
}

const CLI_PROBES: CliProbe[] = [
  // Source control / hosting
  {
    bin: "gh",
    name: "GitHub CLI",
    statusCmd: "gh auth status 2>&1",
    authCmd: "gh auth login",
    markers: [
      /Logged in/i,
    ],
  },
  {
    bin: "glab",
    name: "GitLab CLI",
    statusCmd: "glab auth status 2>&1",
    authCmd: "glab auth login",
    markers: [
      /Logged in/i,
    ],
  },
  // Cloud providers
  {
    bin: "aws",
    name: "AWS CLI",
    statusCmd: "aws sts get-caller-identity 2>&1",
    authCmd: "aws configure",
    markers: [
      /"Account":/,
      /"Arn":/,
    ],
  },
  {
    bin: "gcloud",
    name: "gcloud",
    statusCmd: "gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null",
    authCmd: "gcloud auth login",
    markers: [
      /@/,
    ],
  },
  {
    bin: "az",
    name: "Azure CLI",
    statusCmd: "az account show 2>/dev/null",
    authCmd: "az login",
    markers: [
      /"id":/,
      /"tenantId":/,
    ],
  },
  {
    bin: "doctl",
    name: "DigitalOcean CLI",
    statusCmd: "doctl account get 2>&1",
    authCmd: "doctl auth init",
    markers: [
      /active|Email/i,
    ],
  },
  {
    bin: "hcloud",
    name: "Hetzner Cloud CLI",
    statusCmd: "hcloud context active 2>/dev/null",
    authCmd: "hcloud context create default",
    markers: [
      /^\S+/,
    ],
  },
  // PaaS
  {
    bin: "vercel",
    name: "Vercel CLI",
    statusCmd: "vercel whoami 2>&1",
    authCmd: "vercel login",
    markers: [
      /^[a-zA-Z0-9_-]+$/m,
    ],
  },
  {
    bin: "netlify",
    name: "Netlify CLI",
    statusCmd: "netlify status 2>&1",
    authCmd: "netlify login",
    markers: [
      /Logged in|Email/i,
    ],
  },
  {
    bin: "fly",
    name: "Fly.io CLI",
    statusCmd: "fly auth whoami 2>&1",
    authCmd: "fly auth login",
    markers: [
      /@/,
    ],
  },
  {
    bin: "flyctl",
    name: "Flyctl",
    statusCmd: "flyctl auth whoami 2>&1",
    authCmd: "flyctl auth login",
    markers: [
      /@/,
    ],
  },
  {
    bin: "heroku",
    name: "Heroku CLI",
    statusCmd: "heroku whoami 2>&1",
    authCmd: "heroku login",
    markers: [
      /@/,
    ],
  },
  {
    bin: "railway",
    name: "Railway CLI",
    statusCmd: "railway whoami 2>&1",
    authCmd: "railway login",
    markers: [
      /@|Logged in/i,
    ],
  },
  {
    bin: "render",
    name: "Render CLI",
    statusCmd: "render workspace current 2>&1",
    authCmd: "render login",
    markers: [
      /Workspace|Name/i,
    ],
  },
  // E-commerce / payments
  {
    bin: "shopify",
    name: "Shopify CLI",
    statusCmd: "shopify app info 2>&1",
    authCmd: "shopify auth login",
    markers: [
      /Logged in|Org|Partner/i,
    ],
  },
  {
    bin: "stripe",
    name: "Stripe CLI",
    statusCmd: "stripe config --list 2>&1",
    authCmd: "stripe login",
    markers: [
      /test_mode_api_key|live_mode_api_key|account_id/,
    ],
  },
  // Backend-as-a-service
  {
    bin: "firebase",
    name: "Firebase CLI",
    statusCmd: "firebase login:list 2>&1",
    authCmd: "firebase login",
    markers: [
      /@/,
    ],
  },
  {
    bin: "supabase",
    name: "Supabase CLI",
    statusCmd: "supabase projects list 2>&1",
    authCmd: "supabase login",
    markers: [
      /REFERENCE ID|^[a-z0-9]{20}/m,
    ],
  },
  // Cloudflare / edge
  {
    bin: "wrangler",
    name: "Cloudflare Wrangler",
    statusCmd: "wrangler whoami 2>&1",
    authCmd: "wrangler login",
    markers: [
      /@|associated with/i,
    ],
  },
  // IaC
  {
    bin: "pulumi",
    name: "Pulumi CLI",
    statusCmd: "pulumi whoami 2>&1",
    authCmd: "pulumi login",
    markers: [
      /^\S+/,
    ],
  },
  // Containers
  {
    bin: "docker",
    name: "Docker Hub",
    statusCmd: "docker info 2>/dev/null | grep -i Username",
    authCmd: "docker login",
    markers: [
      /Username:/i,
    ],
  },
  // Package registries
  {
    bin: "npm",
    name: "npm registry",
    statusCmd: "npm whoami 2>&1",
    authCmd: "npm login",
    markers: [
      /^[a-zA-Z0-9._-]+$/m,
    ],
  },
  // Database / data
  {
    bin: "turso",
    name: "Turso CLI",
    statusCmd: "turso auth whoami 2>&1",
    authCmd: "turso auth login",
    markers: [
      /^\S+/,
    ],
  },
  {
    bin: "neonctl",
    name: "Neon CLI",
    statusCmd: "neonctl me 2>&1",
    authCmd: "neonctl auth",
    markers: [
      /email|name/i,
    ],
  },
  {
    bin: "planetscale",
    name: "PlanetScale CLI",
    statusCmd: "planetscale auth check 2>&1",
    authCmd: "planetscale auth login",
    markers: [
      /Authenticated|@/i,
    ],
  },
  // 1Password (secrets)
  {
    bin: "op",
    name: "1Password CLI",
    statusCmd: "op whoami 2>&1",
    authCmd: "op signin",
    markers: [
      /URL|user_uuid/i,
    ],
  },
  // Tunnels
  {
    bin: "ngrok",
    name: "ngrok",
    statusCmd: "ngrok config check 2>&1",
    authCmd: "ngrok config add-authtoken <TOKEN>",
    markers: [
      /Valid configuration/i,
    ],
  },
];

// ── Secret-pattern scanner (for content of files staged for publish) ───────
// We err on the side of false positives: if anything matches, we make the user
// look at it before pushing.
const SECRET_PATTERNS: Array<{
  label: string;
  re: RegExp;
}> = [
  {
    label: "PEM private key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    label: "OpenSSH private key",
    re: /-----BEGIN OPENSSH PRIVATE KEY-----/,
  },
  {
    label: "GitHub PAT",
    re: /\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  },
  {
    label: "GitHub OAuth token",
    re: /\bgho_[A-Za-z0-9]{30,}\b/,
  },
  {
    label: "OpenAI / Anthropic-style API key",
    re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "Slack token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    label: "AWS access key",
    re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    label: "Stripe secret key",
    re: /\b(sk|rk)_(test|live)_[A-Za-z0-9]{24,}\b/,
  },
  {
    label: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
];

// rsync exclude rules — written to an exclude-from file. Filename-based and
// extension-based; the post-rsync content scan catches inline secrets.
const RSYNC_EXCLUDES = [
  // Spawn / VCS / dependencies
  ".git",
  ".gitignore",
  "node_modules",
  ".spawnrc",
  // Env / dotenv
  ".env",
  ".env.*",
  "*.env",
  ".direnv",
  // SSH / GPG / netrc
  ".ssh",
  "ssh",
  ".gnupg",
  ".netrc",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  // Cloud-provider creds
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/doctl",
  ".config/hcloud",
  ".config/fly",
  ".config/flyctl",
  ".kube",
  ".docker/config.json",
  "credentials.json",
  "service-account*.json",
  "*credentials*.json",
  "gcp-key.json",
  // Package-registry creds
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  // Terraform / Pulumi state
  ".terraform",
  "terraform.tfstate*",
  ".terraformrc",
  ".pulumi",
  // Build artifacts (large + uninteresting)
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  "*.pyc",
  ".venv",
  "venv",
  // Editors / OS noise
  ".idea",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  "*.swp",
];

// Schema for parsing MCP server configs from Claude/Cursor settings
const McpEntrySchema = v.object({
  command: v.string(),
  args: v.array(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});

// JSON shapes we accept: either { mcpServers: {...} } or { ...directly... }
const McpSettingsSchema = v.object({
  mcpServers: v.optional(v.record(v.string(), McpEntrySchema)),
});
const McpRootSchema = v.record(v.string(), McpEntrySchema);

// ── Remote scan ────────────────────────────────────────────────────────────
// One SSH call probes everything. We emit framed sections separated by a
// distinctive marker so locally we can split on it without escaping JSON.
const FRAME = "===SPAWN_EXPORT_FRAME===";

function buildProbeScript(): string {
  const cliBins = CLI_PROBES.map((c) => c.bin).join(" ");
  // statusCmds keyed by bin via case statement (avoids quoting issues)
  const cliCases = CLI_PROBES.map((c) => `      ${c.bin}) STATUS_CMD=${shellSqEscape(c.statusCmd)};;`).join("\n");
  const mcpReads = MCP_SOURCES.map(
    (s) =>
      `  printf '%s\\nMCP_PATH=%s\\nMCP_FORMAT=%s\\n' "${FRAME}" "${s.path}" "${s.format}"\n  cat "${s.path}" 2>/dev/null || true`,
  ).join("\n");

  return [
    "set +e",
    "echo '" + FRAME + "'",
    `for bin in ${cliBins}; do`,
    `  if command -v "$bin" >/dev/null 2>&1; then`,
    `    case "$bin" in`,
    cliCases,
    `      *) STATUS_CMD="echo present";;`,
    "    esac",
    `    printf 'CLI_BIN=%s\\n' "$bin"`,
    `    out=$(eval "$STATUS_CMD" 2>&1 || true)`,
    `    printf '%s\\n' "$out" | head -c 4000`,
    `    printf '\\n${FRAME}\\n'`,
    "  fi",
    "done",
    mcpReads,
    `printf '\\n${FRAME}END\\n'`,
  ].join("\n");
}

/** Single-quote-escape for a value going into a bash single-quoted literal. */
function shellSqEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface RemoteScan {
  clis: Map<string, string>;
  mcps: Array<{
    path: string;
    format: McpFormat;
    content: string;
  }>;
}

function parseProbeOutput(raw: string): RemoteScan {
  const result: RemoteScan = {
    clis: new Map(),
    mcps: [],
  };
  const sections = raw.split(`${FRAME}\n`).map((s) => s.replace(/\n?===SPAWN_EXPORT_FRAME===END\n?$/, ""));
  for (const section of sections) {
    if (!section.trim()) {
      continue;
    }
    const cliMatch = section.match(/^CLI_BIN=([^\n]+)\n([\s\S]*)$/);
    if (cliMatch) {
      result.clis.set(cliMatch[1].trim(), cliMatch[2]);
      continue;
    }
    const mcpMatch = section.match(/^MCP_PATH=([^\n]+)\nMCP_FORMAT=([^\n]+)\n([\s\S]*)$/);
    if (mcpMatch) {
      const content = mcpMatch[3];
      if (content.trim()) {
        const fmt = mcpMatch[2].trim();
        if (fmt === "json-mcpservers" || fmt === "json-root" || fmt === "codex-toml") {
          result.mcps.push({
            path: mcpMatch[1].trim(),
            format: fmt,
            content,
          });
        }
      }
    }
  }
  return result;
}

/** Run one SSH command on the VM and return stdout. */
function sshCapture(ip: string, user: string, cmd: string, keyOpts: string[]): string {
  const result = spawnSync(
    "ssh",
    [
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `${user}@${ip}`,
      "--",
      cmd,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: [
        "pipe",
        "pipe",
        "pipe",
      ],
    },
  );
  return result.stdout ?? "";
}

// ── MCP parsing ────────────────────────────────────────────────────────────
type GenericMcp = NonNullable<SpawnMdConfig["mcp_servers"]>[number];

function entriesFromJsonMcpServers(content: string): Record<string, v.InferOutput<typeof McpEntrySchema>> {
  const parsed = parseJsonWith(content, McpSettingsSchema);
  return parsed?.mcpServers ?? {};
}

function entriesFromJsonRoot(content: string): Record<string, v.InferOutput<typeof McpEntrySchema>> {
  // Some configs put MCP entries at the root. Try both shapes.
  const asRoot = parseJsonWith(content, McpRootSchema);
  if (asRoot && Object.keys(asRoot).length > 0) {
    return asRoot;
  }
  return entriesFromJsonMcpServers(content);
}

/**
 * Parse Codex-style TOML where MCP servers live in `[mcp_servers.NAME]`
 * blocks. We only handle the subset Codex emits: command (string),
 * args (string array, single-line), and a nested [mcp_servers.NAME.env]
 * block with KEY = "VALUE" pairs.
 */
function entriesFromCodexToml(content: string): Record<string, v.InferOutput<typeof McpEntrySchema>> {
  const result: Record<string, v.InferOutput<typeof McpEntrySchema>> = {};
  let currentName: string | null = null;
  let currentEntry: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  } | null = null;
  let inEnv = false;

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[mcp_servers\.([^.\]]+)(?:\.(env))?\]$/);
    if (sectionMatch) {
      // Flush previous entry if complete
      if (currentName && currentEntry?.command && currentEntry.args) {
        result[currentName] = {
          command: currentEntry.command,
          args: currentEntry.args,
          ...(currentEntry.env
            ? {
                env: currentEntry.env,
              }
            : {}),
        };
      }
      const newName = sectionMatch[1];
      if (sectionMatch[2] === "env" && currentName === newName) {
        inEnv = true;
      } else {
        currentName = newName;
        currentEntry = result[newName]
          ? {
              command: result[newName].command,
              args: result[newName].args,
              env: result[newName].env,
            }
          : {};
        inEnv = false;
      }
      continue;
    }
    if (line.startsWith("[")) {
      currentName = null;
      currentEntry = null;
      inEnv = false;
      continue;
    }
    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv || !currentEntry) {
      continue;
    }
    const key = kv[1];
    const val = kv[2].trim();
    if (inEnv) {
      const sv = parseTomlString(val);
      if (sv !== null) {
        currentEntry.env = currentEntry.env ?? {};
        currentEntry.env[key] = sv;
      }
      continue;
    }
    if (key === "command") {
      const sv = parseTomlString(val);
      if (sv !== null) {
        currentEntry.command = sv;
      }
    } else if (key === "args") {
      const arr = parseTomlStringArray(val);
      if (arr) {
        currentEntry.args = arr;
      }
    }
  }
  if (currentName && currentEntry?.command && currentEntry.args) {
    result[currentName] = {
      command: currentEntry.command,
      args: currentEntry.args,
      ...(currentEntry.env
        ? {
            env: currentEntry.env,
          }
        : {}),
    };
  }
  return result;
}

function parseTomlString(raw: string): string | null {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return null;
}

function parseTomlStringArray(raw: string): string[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    return null;
  }
  const inner = raw.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  // Naive split on commas outside quotes — sufficient for Codex output.
  const items: string[] = [];
  let buf = "";
  let inDq = false;
  for (const ch of inner) {
    if (ch === '"') {
      inDq = !inDq;
      buf += ch;
      continue;
    }
    if (ch === "," && !inDq) {
      items.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) {
    items.push(buf.trim());
  }
  const parsed: string[] = [];
  for (const item of items) {
    const sv = parseTomlString(item);
    if (sv === null) {
      return null;
    }
    parsed.push(sv);
  }
  return parsed;
}

function dedupeMcpServers(scans: RemoteScan["mcps"]): GenericMcp[] {
  const byName = new Map<string, GenericMcp>();
  for (const src of scans) {
    let entries: Record<string, v.InferOutput<typeof McpEntrySchema>> = {};
    if (src.format === "json-mcpservers") {
      entries = entriesFromJsonMcpServers(src.content);
    } else if (src.format === "json-root") {
      entries = entriesFromJsonRoot(src.content);
    } else if (src.format === "codex-toml") {
      entries = entriesFromCodexToml(src.content);
    }
    for (const [name, cfg] of Object.entries(entries)) {
      if (byName.has(name)) {
        continue;
      }
      const entry: GenericMcp = {
        name,
        command: cfg.command,
        args: cfg.args,
      };
      if (cfg.env) {
        // Replace actual values with ${NAME} placeholders — never export secrets
        const placeholders: Record<string, string> = {};
        for (const k of Object.keys(cfg.env)) {
          placeholders[k] = `\${${k}}`;
        }
        entry.env = placeholders;
      }
      byName.set(name, entry);
    }
  }
  return Array.from(byName.values());
}

// ── CLI status interpretation ──────────────────────────────────────────────
function buildSetupFromCliScan(clis: Map<string, string>): {
  setup: NonNullable<SpawnMdConfig["setup"]>;
  steps: string[];
} {
  const setup: NonNullable<SpawnMdConfig["setup"]> = [];
  const steps: string[] = [];
  for (const probe of CLI_PROBES) {
    const out = clis.get(probe.bin);
    if (out === undefined) {
      continue;
    }
    const authed = probe.markers.some((re) => re.test(out));
    if (!authed) {
      continue;
    }
    if (probe.bin === "gh") {
      // Spawn already has a built-in github step; prefer it over a custom auth flow.
      steps.push("github");
      continue;
    }
    setup.push({
      type: "cli_auth",
      name: probe.name,
      command: probe.authCmd,
      description: `Authenticate with ${probe.name}`,
    });
  }
  return {
    setup,
    steps,
  };
}

// ── Secret content scan over the staged repo ───────────────────────────────
const TEXT_FILE_MAX = 1 * 1024 * 1024; // skip blobs > 1 MB

function isLikelyTextFile(path: string): boolean {
  const bin =
    /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|webm|exe|dll|so|dylib|bin|class|jar|wasm)$/i;
  return !bin.test(path);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [
    root,
  ];
  while (stack.length) {
    const dir = stack.pop();
    if (dir === undefined) {
      continue;
    }
    const entries = readdirSync(dir, {
      withFileTypes: true,
    });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git") {
          continue;
        }
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

interface SecretHit {
  relativePath: string;
  label: string;
}

function scanForSecrets(rootDir: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const files = walkFiles(rootDir);
  for (const file of files) {
    if (!isLikelyTextFile(file)) {
      continue;
    }
    const sizeResult = tryCatch(() => statSync(file).size);
    if (!sizeResult.ok || sizeResult.data > TEXT_FILE_MAX) {
      continue;
    }
    const readResult = tryCatch(() =>
      readFileSync(file, {
        encoding: "utf8",
      }),
    );
    if (!readResult.ok) {
      continue;
    }
    const content = readResult.data;
    for (const pat of SECRET_PATTERNS) {
      if (pat.re.test(content)) {
        hits.push({
          relativePath: relative(rootDir, file),
          label: pat.label,
        });
        break;
      }
    }
  }
  return hits;
}

// ── Main command ───────────────────────────────────────────────────────────
export async function cmdExport(): Promise<void> {
  if (!isInteractiveTTY()) {
    console.error(pc.red("Error: spawn export requires an interactive terminal"));
    process.exit(1);
  }

  // 1. Check for gh CLI
  const ghResult = tryCatch(() =>
    execSync("gh auth status 2>&1", {
      encoding: "utf8",
    }),
  );
  if (!ghResult.ok) {
    const ghWhich = tryCatch(() =>
      execSync("which gh 2>/dev/null", {
        encoding: "utf8",
      }),
    );
    if (!ghWhich.ok) {
      p.log.error("GitHub CLI (gh) is not installed.");
      p.log.info(`Install it: ${pc.cyan("https://cli.github.com/")}`);
      process.exit(1);
    }
    p.log.error("GitHub CLI is not authenticated.");
    p.log.info(`Run: ${pc.cyan("gh auth login")}`);
    process.exit(1);
  }

  // 2. Show spawn history picker
  const records = loadHistory().filter((r) => r.connection && !r.connection.deleted);
  if (records.length === 0) {
    p.log.error("No active spawns found. Start one first with 'spawn <agent> <cloud>'.");
    process.exit(1);
  }

  const manifestResult = await asyncTryCatch(() => loadManifest());
  const manifest = manifestResult.ok ? manifestResult.data : null;

  const options = records.map((r) => ({
    value: r,
    label: buildRecordLabel(r),
    hint: buildRecordSubtitle(r, manifest),
  }));

  const selected = await p.select({
    message: "Which spawn do you want to export?",
    options,
  });

  if (p.isCancel(selected)) {
    handleCancel();
    return;
  }

  const record = selected;
  const conn = record.connection;
  if (!conn) {
    p.log.error("Selected spawn has no connection info.");
    return;
  }

  // Validate connection fields
  const validResult = tryCatch(() => {
    validateIdentifier(record.agent, "Agent name");
    validateConnectionIP(conn.ip);
    validateUsername(conn.user);
  });
  if (!validResult.ok) {
    p.log.error("Invalid connection data in spawn history.");
    return;
  }

  // 3. SSH in and run the unified probe
  p.log.step(`Scanning ${pc.bold(record.agent)} on ${pc.bold(conn.ip)}...`);
  const keys = await ensureSshKeys();
  const keyOpts = getSshKeyOpts(keys);
  const probeOutput = sshCapture(conn.ip, conn.user, buildProbeScript(), keyOpts);
  const scan = parseProbeOutput(probeOutput);

  const mcpServers = dedupeMcpServers(scan.mcps);
  const { setup, steps } = buildSetupFromCliScan(scan.clis);
  steps.push("auto-update");

  if (mcpServers.length > 0) {
    p.log.info(`MCP servers found: ${mcpServers.map((m) => m.name).join(", ")}`);
  }
  if (setup.length > 0) {
    p.log.info(`Authenticated CLIs: ${setup.map((s) => s.name).join(", ")}`);
  }

  // 4. Prompt for template details
  const repoName = await p.text({
    message: "Repository name for this template:",
    placeholder: record.name ?? `${record.agent}-template`,
    validate: (val) => {
      if (!val || val.trim() === "") {
        return "Name is required";
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(val)) {
        return "Only alphanumeric, dots, hyphens, underscores";
      }
      return undefined;
    },
  });

  if (p.isCancel(repoName)) {
    handleCancel();
    return;
  }

  const description = await p.text({
    message: "Description (optional):",
    placeholder: `${record.agent} agent template`,
  });

  if (p.isCancel(description)) {
    handleCancel();
    return;
  }

  const visibility = await p.select({
    message: "Repository visibility:",
    options: [
      {
        value: "private",
        label: "Private (recommended)",
      },
      {
        value: "public",
        label: "Public",
      },
    ],
    initialValue: "private",
  });
  if (p.isCancel(visibility)) {
    handleCancel();
    return;
  }

  // 5. Generate spawn.md (steps go in the CLI command, not in spawn.md)
  const config: SpawnMdConfig = {
    name: repoName,
    description: isString(description) ? description : undefined,
    setup: setup.length > 0 ? setup : undefined,
    mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
  };

  const spawnMdContent = generateSpawnMd(config, `# ${repoName}\n\n${isString(description) ? description : ""}`);

  // 6. Stage the working folder + spawn.md
  const tmpDir = mkdtempSync(join(tmpdir(), "spawn-export-"));

  // Download project files from VM if they exist
  p.log.step("Downloading working folder from VM...");
  const hasProject = sshCapture(conn.ip, conn.user, "test -d ~/project && echo yes || echo no", keyOpts).trim();
  if (hasProject === "yes") {
    const excludeFile = join(tmpDir, ".spawn-rsync-exclude");
    writeFileSync(excludeFile, RSYNC_EXCLUDES.join("\n"));
    const sshArgs = [
      ...SSH_BASE_OPTS,
      ...keyOpts,
    ].join(" ");
    const rsyncResult = tryCatch(() =>
      execSync(
        `rsync -az --exclude-from='${excludeFile}' -e "ssh ${sshArgs}" '${conn.user}@${conn.ip}:~/project/' '${tmpDir}/'`,
        {
          encoding: "utf8",
          timeout: 120_000,
        },
      ),
    );
    tryCatch(() => unlinkSync(excludeFile));
    if (!rsyncResult.ok) {
      p.log.warn("Could not download project files — creating template with spawn.md only");
    }
  } else {
    p.log.info("No ~/project directory on VM — exporting setup only");
  }

  // Write spawn.md AFTER rsync so it always wins over any existing one in the project.
  writeFileSync(join(tmpDir, "spawn.md"), spawnMdContent);
  writeFileSync(
    join(tmpDir, ".gitignore"),
    [
      ".env",
      ".env.*",
      ".spawnrc",
      "node_modules/",
      "/etc/spawn/",
      "*.pem",
      "*.key",
      "id_rsa*",
      "credentials.json",
      "",
    ].join("\n"),
  );

  // 7. Scan staged files for inline secrets
  p.log.step("Scanning staged files for secrets...");
  const hits = scanForSecrets(tmpDir);
  if (hits.length > 0) {
    p.log.warn(`Found ${hits.length} file(s) that look like they contain secrets:`);
    for (const hit of hits.slice(0, 20)) {
      console.error(`  ${pc.yellow("•")} ${pc.bold(hit.relativePath)} ${pc.dim(`(${hit.label})`)}`);
    }
    if (hits.length > 20) {
      console.error(pc.dim(`  ... and ${hits.length - 20} more`));
    }
    const action = await p.select({
      message: "How do you want to handle these?",
      options: [
        {
          value: "remove",
          label: "Remove flagged files and continue",
        },
        {
          value: "keep",
          label: "Keep them (I checked, they're safe)",
        },
        {
          value: "abort",
          label: "Abort export",
        },
      ],
      initialValue: "remove",
    });
    if (p.isCancel(action) || action === "abort") {
      handleCancel();
      return;
    }
    if (action === "remove") {
      for (const hit of hits) {
        tryCatch(() => unlinkSync(join(tmpDir, hit.relativePath)));
      }
      p.log.info(`Removed ${hits.length} flagged file(s)`);
    }
  }

  // 8. Show preview of generated spawn.md
  p.log.info("Generated spawn.md:");
  console.error(pc.dim("─".repeat(40)));
  console.error(pc.dim(spawnMdContent));
  console.error(pc.dim("─".repeat(40)));

  const confirm = await p.confirm({
    message: `Create ${visibility} GitHub repo "${repoName}" and push?`,
    initialValue: true,
  });

  if (p.isCancel(confirm) || !confirm) {
    handleCancel();
    return;
  }

  // 9. Init git, commit, create repo, push
  p.log.step("Creating GitHub repository...");
  const visibilityFlag = visibility === "public" ? "--public" : "--private";
  const repoResult = tryCatch(() => {
    execSync(`cd ${tmpDir} && git init -q && git add -A && git commit -q -m "Initial template"`, {
      encoding: "utf8",
    });
    execSync(`cd ${tmpDir} && gh repo create ${repoName} ${visibilityFlag} --source=. --push`, {
      encoding: "utf8",
      stdio: [
        "pipe",
        "pipe",
        "inherit",
      ],
    });
  });
  if (!repoResult.ok) {
    p.log.error("Failed to create GitHub repo.");
    p.log.info(`You can manually push the template from: ${tmpDir}`);
    return;
  }

  // 10. Get the repo slug (user/repo)
  let repoSlug = repoName;
  const ghUserResult = tryCatch(() =>
    execSync("gh api user --jq .login", {
      encoding: "utf8",
    }).trim(),
  );
  if (ghUserResult.ok && ghUserResult.data) {
    repoSlug = `${ghUserResult.data}/${repoName}`;
  }

  // 11. Print the shareable command (steps baked into the command, not spawn.md)
  const stepsArg = steps.length > 0 ? ` --steps ${steps.join(",")}` : "";
  console.error();
  p.log.success("Template exported!");
  console.error();
  console.error("  Share this command to replicate your setup:");
  console.error();
  console.error(`    ${pc.cyan(`spawn ${record.agent} ${record.cloud} --repo ${repoSlug}${stepsArg}`)}`);
  console.error();
}

// Internal exports for unit tests
export const __testing = {
  parseProbeOutput,
  entriesFromCodexToml,
  entriesFromJsonMcpServers,
  entriesFromJsonRoot,
  dedupeMcpServers,
  buildSetupFromCliScan,
  scanForSecrets,
  SECRET_PATTERNS,
  RSYNC_EXCLUDES,
  CLI_PROBES,
  MCP_SOURCES,
  buildProbeScript,
};

// commands/export.ts — Export a running spawn's setup as a shareable template
//
// SSHes into a VM from spawn history, scans what's installed (MCP servers,
// CLI auths, tools), generates a spawn.md recipe (no secrets), pushes to
// GitHub, and prints a one-liner command for others to replicate the setup.

import type { SpawnMdConfig } from "../shared/spawn-md.js";

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { isString } from "@openrouter/spawn-shared";
import pc from "picocolors";
import * as v from "valibot";
import { loadHistory } from "../history.js";
import { validateConnectionIP, validateIdentifier, validateUsername } from "../security.js";
import { parseJsonWith } from "../shared/parse.js";
import { tryCatch } from "../shared/result.js";
import { generateSpawnMd } from "../shared/spawn-md.js";
import { SSH_BASE_OPTS } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { buildRecordLabel, buildRecordSubtitle } from "./list.js";
import { handleCancel, isInteractiveTTY } from "./shared.js";

// Schema for parsing MCP server configs from Claude/Cursor settings
const McpEntrySchema = v.object({
  command: v.string(),
  args: v.array(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});
const McpSettingsSchema = v.object({
  mcpServers: v.optional(v.record(v.string(), McpEntrySchema)),
});

/** Run a command on the remote VM and capture stdout */
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
      timeout: 15_000,
      stdio: [
        "pipe",
        "pipe",
        "pipe",
      ],
    },
  );
  return (result.stdout ?? "").trim();
}

/** Scan a remote VM for installed MCP servers, CLI auths, and tools */
function scanVmSetup(
  ip: string,
  user: string,
  agentKey: string,
  keyOpts: string[],
): {
  mcpServers: NonNullable<SpawnMdConfig["mcp_servers"]>;
  steps: string[];
  setup: NonNullable<SpawnMdConfig["setup"]>;
} {
  const mcpServers: NonNullable<SpawnMdConfig["mcp_servers"]> = [];
  const steps: string[] = [];
  const setup: NonNullable<SpawnMdConfig["setup"]> = [];

  // Detect MCP servers from Claude Code / Cursor config
  if (agentKey === "claude" || agentKey === "cursor") {
    const settingsPath = agentKey === "claude" ? "~/.claude/settings.json" : "~/.cursor/mcp.json";
    const raw = sshCapture(ip, user, `cat ${settingsPath} 2>/dev/null || echo '{}'`, keyOpts);
    const parsed = parseJsonWith(raw, McpSettingsSchema);
    if (parsed?.mcpServers) {
      for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
        const entry: NonNullable<SpawnMdConfig["mcp_servers"]>[number] = {
          name,
          command: cfg.command,
          args: cfg.args,
        };
        if (cfg.env) {
          // Replace actual values with ${NAME} placeholders — never export secrets
          const envPlaceholders: Record<string, string> = {};
          for (const k of Object.keys(cfg.env)) {
            envPlaceholders[k] = `\${${k}}`;
          }
          entry.env = envPlaceholders;
        }
        mcpServers.push(entry);
      }
    }
  }

  // Detect GitHub CLI auth
  const ghStatus = sshCapture(ip, user, "gh auth status 2>&1 || true", keyOpts);
  if (ghStatus.includes("Logged in")) {
    steps.push("github");
  }

  // Detect common CLI tools that might need auth
  const toolChecks = [
    {
      cmd: "shopify",
      name: "Shopify CLI",
      authCmd: "shopify auth login",
    },
    {
      cmd: "vercel",
      name: "Vercel CLI",
      authCmd: "vercel login",
    },
    {
      cmd: "netlify",
      name: "Netlify CLI",
      authCmd: "netlify login",
    },
    {
      cmd: "firebase",
      name: "Firebase CLI",
      authCmd: "firebase login",
    },
    {
      cmd: "supabase",
      name: "Supabase CLI",
      authCmd: "supabase login",
    },
    {
      cmd: "stripe",
      name: "Stripe CLI",
      authCmd: "stripe login",
    },
  ] as const;

  for (const tool of toolChecks) {
    const which = sshCapture(ip, user, `which ${tool.cmd} 2>/dev/null || true`, keyOpts);
    if (which) {
      setup.push({
        type: "cli_auth",
        name: tool.name,
        command: tool.authCmd,
        description: `Authenticate with ${tool.name}`,
      });
    }
  }

  // Always include auto-update
  steps.push("auto-update");

  return {
    mcpServers,
    steps,
    setup,
  };
}

/** Main export command */
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

  const options = records.map((r) => ({
    value: r,
    label: buildRecordLabel(r),
    hint: buildRecordSubtitle(r),
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

  p.log.step(`Scanning ${pc.bold(record.agent)} on ${pc.bold(conn.ip)}...`);

  // 3. SSH in and scan the VM
  const keys = await ensureSshKeys();
  const keyOpts = getSshKeyOpts(keys);
  const { mcpServers, steps, setup } = scanVmSetup(conn.ip, conn.user, record.agent, keyOpts);

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

  // 5. Generate spawn.md (steps go in the CLI command, not in spawn.md)
  const config: SpawnMdConfig = {
    name: repoName,
    description: isString(description) ? description : undefined,
    setup: setup.length > 0 ? setup : undefined,
    mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
  };

  const spawnMdContent = generateSpawnMd(config, `# ${repoName}\n\n${isString(description) ? description : ""}`);

  // Show preview
  p.log.info("Generated spawn.md:");
  console.error(pc.dim("─".repeat(40)));
  console.error(pc.dim(spawnMdContent));
  console.error(pc.dim("─".repeat(40)));

  const confirm = await p.confirm({
    message: "Create GitHub repo and push?",
    initialValue: true,
  });

  if (p.isCancel(confirm) || !confirm) {
    handleCancel();
    return;
  }

  // 6. Create temp dir, write spawn.md, init repo, push
  const tmpDir = mkdtempSync(join(tmpdir(), "spawn-export-"));

  writeFileSync(join(tmpDir, "spawn.md"), spawnMdContent);
  writeFileSync(
    join(tmpDir, ".gitignore"),
    [
      ".env",
      ".env.*",
      ".spawnrc",
      "node_modules/",
      "/etc/spawn/",
      "",
    ].join("\n"),
  );

  // Download project files from VM if they exist
  p.log.step("Downloading project files from VM...");
  const hasProject = sshCapture(conn.ip, conn.user, "test -d ~/project && echo yes || echo no", keyOpts);
  if (hasProject === "yes") {
    const excludeFlags = [
      "--exclude=node_modules",
      "--exclude=.git",
      "--exclude=.env",
      "--exclude=.env.*",
      "--exclude=.spawnrc",
    ];
    const rsyncResult = tryCatch(() =>
      execSync(
        `rsync -az ${excludeFlags.join(" ")} -e "ssh ${SSH_BASE_OPTS.join(" ")} ${keyOpts.join(" ")}" ${conn.user}@${conn.ip}:~/project/ ${tmpDir}/`,
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      ),
    );
    if (!rsyncResult.ok) {
      p.log.warn("Could not download project files — creating template with spawn.md only");
    }
  }

  // 7. Create GitHub repo
  p.log.step("Creating GitHub repository...");
  const repoResult = tryCatch(() => {
    execSync(`cd ${tmpDir} && git init -q && git add -A && git commit -q -m "Initial template"`, {
      encoding: "utf8",
    });
    execSync(`cd ${tmpDir} && gh repo create ${repoName} --public --source=. --push`, {
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

  // 8. Get the repo slug (user/repo)
  let repoSlug = repoName;
  const ghUserResult = tryCatch(() =>
    execSync("gh api user --jq .login", {
      encoding: "utf8",
    }).trim(),
  );
  if (ghUserResult.ok && ghUserResult.data) {
    repoSlug = `${ghUserResult.data}/${repoName}`;
  }

  // 9. Print the shareable command (steps baked into the command, not spawn.md)
  const stepsArg = steps.length > 0 ? ` --steps ${steps.join(",")}` : "";
  console.error();
  p.log.success("Template exported!");
  console.error();
  console.error("  Share this command to replicate your setup:");
  console.error();
  console.error(`    ${pc.cyan(`spawn ${record.agent} ${record.cloud} --repo ${repoSlug}${stepsArg}`)}`);
  console.error();
}

// commands/export.ts — `spawn export [name|id]`
//
// Captures a running claude spawn as a redistributable github repo. The
// output is the symmetric inverse of `--repo`: today `spawn claude hetzner
// --repo user/template` consumes a repo. After `spawn export`, the user
// gets a `spawn claude <cloud> --repo user/<slug>` line they can hand off
// or re-run.
//
// v1 scope: claude only.
// - When the user has multiple claude spawns, a picker lists them.
// - The repo name is decided by claude on the VM (`claude -p` with a
//   name-suggestion prompt) — the human is never asked. The gh username
//   comes from `gh api user`.
// - Before the commit, every staged file is scanned for known API-key
//   shapes (Anthropic, OpenRouter, OpenAI, GitHub, AWS, PEM, Hetzner,
//   DigitalOcean). When hits are found, the VM pauses before commit
//   and writes a `needs_confirmation` result. The host lists the files
//   and asks the user whether to redact and push. Only on approval
//   does a second pass run with ALLOW_REDACT=1, which replaces the
//   matches with a loud placeholder and finalizes the export.
//
// The gate exists because redaction depends on a regex with known
// gaps (#3381): auto-redacting and pushing means a regex miss gets
// published without the user ever seeing the file list. The prompt
// moves the decision back to the human before the `gh repo create
// --push` happens.

import type { SpawnRecord } from "../history.js";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { getErrorMessage } from "@openrouter/spawn-shared";
import pc from "picocolors";
import * as v from "valibot";
import { filterHistory } from "../history.js";
import { parseJsonWith } from "../shared/parse.js";
import { asyncTryCatch } from "../shared/result.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { makeSshRunner } from "../shared/ssh-runner.js";
import { buildRecordLabel, buildRecordSubtitle } from "./list.js";
import { handleCancel } from "./shared.js";

const CLAUDE_AGENT = "claude";
const REMOTE_RESULT_PATH = "/tmp/spawn-export-result.json";
/** Default --steps list when the original launch_cmd doesn't carry one.
 *  Picked to be the standard "0 prompts" claude provisioning set:
 *  github auth + auto-update + security-scan are all defaultOn-equivalent
 *  for normal spawns. */
const DEFAULT_STEPS = "github,auto-update,security-scan";

/** Parse `--steps <value>` (or `--steps=<value>`) out of a saved launch_cmd.
 *  Returns the comma-separated string verbatim, or null if the flag is
 *  absent. The respawn consumer re-validates the names. */
export function parseStepsFromLaunchCmd(cmd: string | undefined): string | null {
  if (!cmd) {
    return null;
  }
  // Anchor to start or whitespace so `--no-steps` etc. never match.
  const eq = cmd.match(/(?:^|\s)--steps=([^\s]+)/);
  if (eq) {
    return eq[1];
  }
  const space = cmd.match(/(?:^|\s)--steps\s+([^\s]+)/);
  if (space) {
    return space[1];
  }
  return null;
}

/** Resolve the --steps value to bake into the spawn link. */
export function resolveSteps(record: SpawnRecord): string {
  return parseStepsFromLaunchCmd(record.connection?.launch_cmd) ?? DEFAULT_STEPS;
}

/** Result the on-VM script writes to REMOTE_RESULT_PATH.
 *  Three shapes:
 *  - success: ok=true with the repo URL (and optionally the redacted list).
 *  - needs_confirmation: ok=false with hits=[...]. The host prompts, and
 *    on approval re-runs the script with ALLOW_REDACT=1.
 *  - error: ok=false with a human-readable error string. */
const ResultSchema = v.union([
  v.object({
    ok: v.literal(true),
    slug: v.string(),
    url: v.string(),
    redacted: v.optional(v.array(v.string())),
  }),
  v.object({
    ok: v.literal(false),
    needsConfirmation: v.literal(true),
    hits: v.array(v.string()),
  }),
  v.object({
    ok: v.literal(false),
    error: v.string(),
  }),
]);

/** Filter to records the export can actually drive: claude, with a live
 *  connection (SSH or sprite-console), not deleted. */
function exportableClaudeRecords(records: SpawnRecord[]): SpawnRecord[] {
  return records.filter((r) => {
    if (r.agent !== CLAUDE_AGENT) {
      return false;
    }
    const c = r.connection;
    if (!c) {
      return false;
    }
    if (c.deleted) {
      return false;
    }
    return true;
  });
}

/** Find a claude spawn by name or id. */
function matchTarget(records: SpawnRecord[], target: string): SpawnRecord | null {
  return records.find((r) => r.id === target || r.name === target || r.connection?.server_name === target) ?? null;
}

/** Build the spawn.md content from a record. Re-spawning consumes this. */
export function buildSpawnMd(record: SpawnRecord): string {
  const lines: string[] = [
    "---",
  ];
  if (record.name) {
    lines.push(`name: ${JSON.stringify(record.name)}`);
  }
  lines.push(`description: ${JSON.stringify(`Exported from spawn ${record.id}`)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${record.name ?? "spawn export"}`);
  lines.push("");
  lines.push("This template was generated by `spawn export`. Re-spawn it with the");
  lines.push("command in the README.");
  lines.push("");
  return lines.join("\n");
}

/** Aggressive default .gitignore. The pre-commit secret scan is the real
 *  backstop; this just keeps obviously-private paths out of the staged tree
 *  before the scan runs. */
export function buildGitignore(): string {
  return [
    "# spawn export defaults",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    "target/",
    ".cache/",
    "coverage/",
    "*.log",
    ".env",
    ".env.*",
    ".spawnrc",
    ".bash_history",
    ".zsh_history",
    ".aws/",
    ".config/spawn/",
    ".config/gcloud/",
    ".gnupg/",
    "*.key",
    "*.pem",
    "*.token",
    "*.credentials",
    "id_rsa*",
    "id_ed25519*",
    ".DS_Store",
    "",
  ].join("\n");
}

/** README template — the bash script substitutes __SLUG__, __CLOUD__,
 *  __NAME__, __STEPS__ at runtime once claude has picked a name. */
export function buildReadmeTemplate(): string {
  return [
    "# __NAME__",
    "",
    "Exported from a [spawn](https://github.com/OpenRouterTeam/spawn) session on `__CLOUD__`.",
    "",
    "## Quickstart",
    "",
    "```bash",
    "spawn claude __CLOUD__ --repo __SLUG__ --steps __STEPS__",
    "```",
    "",
    "Re-spawning is non-interactive — the `--steps` list bakes in the same",
    "setup decisions the original spawn made, so you won't be prompted.",
    "",
    "## First-run checklist",
    "",
    "- [ ] `gh auth login` — re-auth GitHub on the new VM",
    "- [ ] Re-OAuth any MCP servers used in the original session (Spotify, Linear, etc.)",
    "- [ ] Run any project-specific install commands (e.g. `npm install`) in `project/`",
    "",
    "## What's in this repo",
    "",
    "- `project/` — the working tree at `~/project` from the source VM",
    "- `claude/` — sanitized agent config: skills, commands, hooks, CLAUDE.md, settings",
    "- `spawn.md` — machine-readable re-spawn metadata",
    "",
  ].join("\n");
}

/** Generate the bash script that runs on the VM. */
export function buildExportScript(opts: {
  spawnMd: string;
  readmeTemplate: string;
  gitignore: string;
  cloud: string;
  steps: string;
  visibility: "private" | "public";
  resultPath: string;
  /** First pass = false → the script stops before commit when hits are
   *  found and writes a needs_confirmation result. Second pass = true →
   *  the script redacts in-place and pushes. */
  allowRedact: boolean;
}): string {
  const visibilityFlag = opts.visibility === "public" ? "--public" : "--private";
  const allowRedact = opts.allowRedact ? "1" : "0";
  return [
    "#!/bin/bash",
    "set -eo pipefail",
    "",
    `RESULT_PATH=${shSingleQuote(opts.resultPath)}`,
    `CLOUD=${shSingleQuote(opts.cloud)}`,
    `STEPS=${shSingleQuote(opts.steps)}`,
    `VISIBILITY_FLAG=${visibilityFlag}`,
    `ALLOW_REDACT=${allowRedact}`,
    "",
    'EXPORT_DIR="$(mktemp -d)"',
    'trap "rm -rf \\"$EXPORT_DIR\\"" EXIT',
    "",
    "# 1. Heredoc the static files (spawn.md, .gitignore, README template)",
    `cat > "$EXPORT_DIR/spawn.md" <<'SPAWN_MD_EOF'`,
    opts.spawnMd,
    "SPAWN_MD_EOF",
    "",
    `cat > "$EXPORT_DIR/.gitignore" <<'GITIGNORE_EOF'`,
    opts.gitignore,
    "GITIGNORE_EOF",
    "",
    `cat > "$EXPORT_DIR/README.md" <<'README_EOF'`,
    opts.readmeTemplate,
    "README_EOF",
    "",
    "# 2. Copy working tree (rsync excludes the obvious junk).",
    'if [ -d "$HOME/project" ]; then',
    '  mkdir -p "$EXPORT_DIR/project"',
    '  rsync -a --exclude=node_modules --exclude=.git --exclude=dist --exclude=.next --exclude=target --exclude=.env --exclude=".env.*" "$HOME/project/" "$EXPORT_DIR/project/"',
    "fi",
    "",
    "# 3. Copy sanitized claude system dir.",
    'mkdir -p "$EXPORT_DIR/claude"',
    "for d in skills commands hooks; do",
    '  if [ -d "$HOME/.claude/$d" ]; then',
    '    rsync -a --exclude=.git "$HOME/.claude/$d/" "$EXPORT_DIR/claude/$d/"',
    "  fi",
    "done",
    "for f in CLAUDE.md AGENTS.md settings.json; do",
    '  if [ -f "$HOME/.claude/$f" ]; then',
    '    cp "$HOME/.claude/$f" "$EXPORT_DIR/claude/$f"',
    "  fi",
    "done",
    "",
    "# 4. Strip token-shaped keys from settings.json.",
    'if [ -f "$EXPORT_DIR/claude/settings.json" ] && command -v bun >/dev/null; then',
    '  _SETTINGS_PATH="$EXPORT_DIR/claude/settings.json" bun -e "',
    "    const path = process.env._SETTINGS_PATH;",
    "    const raw = await Bun.file(path).text();",
    "    let parsed; try { parsed = JSON.parse(raw); } catch { process.exit(0); }",
    "    if (parsed && typeof parsed === 'object') {",
    "      const denyRe = /(token|secret|password|api[_-]?key|auth)/i;",
    "      const scrub = (obj) => {",
    "        if (!obj || typeof obj !== 'object') return;",
    "        for (const k of Object.keys(obj)) {",
    "          if (denyRe.test(k)) { delete obj[k]; continue; }",
    "          if (typeof obj[k] === 'object') scrub(obj[k]);",
    "        }",
    "      };",
    "      scrub(parsed);",
    "      await Bun.write(path, JSON.stringify(parsed, null, 2));",
    "    }",
    '  " || true',
    "fi",
    "",
    "# 5. Ask claude to suggest a kebab-case repo name.",
    'PROJECT_NAME=""',
    "if command -v claude >/dev/null; then",
    '  CLAUDE_PROMPT="You are choosing a github repo name for an export of this VM. Look at ~/project (the working tree) and any README/package.json to infer the project. Output ONLY a short kebab-case repo name, max 40 chars, lowercase, [a-z0-9-] only. No explanation, no quotes."',
    '  SUGGESTED="$(claude -p "$CLAUDE_PROMPT" 2>/dev/null | head -n 1 || true)"',
    '  PROJECT_NAME="$(printf "%s" "$SUGGESTED" | tr "A-Z" "a-z" | sed -E "s/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-//; s/-$//" | cut -c1-40)"',
    "fi",
    'if [ -z "$PROJECT_NAME" ]; then',
    '  if [ -d "$HOME/project" ]; then',
    '    PROJECT_NAME="$(basename "$HOME/project" | tr "A-Z" "a-z" | sed -E "s/[^a-z0-9-]+/-/g" | cut -c1-40)"',
    "  fi",
    "fi",
    'if [ -z "$PROJECT_NAME" ]; then',
    '  PROJECT_NAME="spawn-export-$(date +%s)"',
    "fi",
    "",
    "# 6. Look up the gh user. Required.",
    'GH_USER="$(gh api user --jq .login 2>/dev/null || true)"',
    'if [ -z "$GH_USER" ]; then',
    '  printf \'%s\\n\' \'{"ok":false,"error":"gh is not authenticated on the VM. Run `gh auth login` and retry."}\' > "$RESULT_PATH"',
    "  exit 1",
    "fi",
    'SLUG="$GH_USER/$PROJECT_NAME"',
    "",
    "# 7. Substitute placeholders into README.",
    'sed -i "s|__NAME__|$PROJECT_NAME|g; s|__CLOUD__|$CLOUD|g; s|__SLUG__|$SLUG|g; s|__STEPS__|$STEPS|g" "$EXPORT_DIR/README.md"',
    "",
    "# 8. Stage everything.",
    'cd "$EXPORT_DIR"',
    "git init -q -b main",
    "git add -A",
    "",
    "# 9. SECRETS SCAN — first pass just detects and stops if hits exist so the",
    "# host can confirm before pushing. Second pass (ALLOW_REDACT=1) redacts",
    "# in-place and continues to commit/push.",
    "SECRET_REGEX='(sk-or-v1-[a-f0-9]{20,})|(sk-ant-api[0-9-]+_[A-Za-z0-9_-]{20,})|(sk-proj-[A-Za-z0-9_-]{20,})|(gh[ops]_[A-Za-z0-9]{36})|(AKIA[0-9A-Z]{16})|(hcloud_[a-zA-Z0-9_-]{20,})|(dop_v1_[a-f0-9]{32,})|(-----BEGIN ([A-Z]+ )?PRIVATE KEY-----)'",
    "REDACT_PLACEHOLDER='***REDACTED-BY-SPAWN-EXPORT***'",
    'SECRET_HITS="$(git ls-files -z | xargs -0 grep -lEa "$SECRET_REGEX" 2>/dev/null || true)"',
    'REDACTED_JSON="[]"',
    'if [ -n "$SECRET_HITS" ]; then',
    '  HITS_JSON="$(_PATHS_RAW="$SECRET_HITS" bun -e "',
    "    const raw = process.env._PATHS_RAW || '';",
    "    const arr = raw.split('\\n').map(s => s.trim()).filter(Boolean);",
    "    process.stdout.write(JSON.stringify(arr));",
    '  ")"',
    '  if [ "$ALLOW_REDACT" != "1" ]; then',
    "    # First pass: stop before commit; host will prompt the user.",
    '    echo "⚠ Potential secrets detected in:" >&2',
    '    printf "%s\\n" "$SECRET_HITS" >&2',
    '    printf \'{"ok":false,"needsConfirmation":true,"hits":%s}\\n\' "$HITS_JSON" > "$RESULT_PATH"',
    "    exit 0",
    "  fi",
    "  # Second pass: redact in-place and continue.",
    '  echo "⚠ Redacting potential secrets in:" >&2',
    '  printf "%s\\n" "$SECRET_HITS" >&2',
    "  while IFS= read -r f; do",
    '    [ -z "$f" ] && continue',
    '    sed -i -E "s|${SECRET_REGEX}|${REDACT_PLACEHOLDER}|g" "$f"',
    '  done <<< "$SECRET_HITS"',
    "  # Re-stage so the redacted blobs replace the originals in the index.",
    "  git add -A",
    '  REDACTED_JSON="$HITS_JSON"',
    "fi",
    "",
    "# 10. Commit and push.",
    'git -c user.email=spawn-export@openrouter.ai -c user.name="spawn export" commit -q -m "spawn export"',
    "",
    'gh repo create "$SLUG" "$VISIBILITY_FLAG" --source=. --push --description="Exported with spawn"',
    "",
    "# 11. Emit the success result (with the list of redacted files, if any).",
    'printf \'{"ok":true,"slug":"%s","url":"https://github.com/%s","redacted":%s}\\n\' "$SLUG" "$SLUG" "$REDACTED_JSON" > "$RESULT_PATH"',
    "",
  ].join("\n");
}

/** Single-quote a string for safe inclusion in a bash script. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface ExportRunner {
  runServer: (cmd: string, timeoutSecs?: number) => Promise<void>;
  uploadFile: (localPath: string, remotePath: string) => Promise<void>;
  downloadFile: (remotePath: string, localPath: string) => Promise<void>;
}

/** Build the runner for a specific spawn record. Sprite has its own exec
 *  channel (`sprite exec`, etc.); everything else uses SSH. */
async function buildRunnerForRecord(record: SpawnRecord): Promise<ExportRunner> {
  const conn = record.connection;
  if (!conn) {
    throw new Error("Cannot build runner: spawn has no connection info.");
  }
  if (record.cloud === "sprite") {
    if (!conn.server_name) {
      throw new Error("Cannot export sprite: connection is missing server_name.");
    }
    const sprite = await import("../sprite/sprite.js");
    await sprite.ensureSpriteCli();
    await sprite.ensureSpriteAuthenticated();
    sprite.setSpriteName(conn.server_name);
    return {
      runServer: sprite.runSprite,
      uploadFile: sprite.uploadFileSprite,
      downloadFile: sprite.downloadFileSprite,
    };
  }
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  return makeSshRunner(conn.ip, conn.user, keyOpts);
}

/** Pick one record from a list of claude spawns. */
async function pickOne(records: SpawnRecord[]): Promise<SpawnRecord | null> {
  const options = records.map((r) => ({
    value: r.id ?? r.timestamp,
    label: buildRecordLabel(r),
    hint: buildRecordSubtitle(r, null),
  }));
  const choice = await p.select({
    message: "Which claude spawn do you want to export?",
    options,
  });
  if (p.isCancel(choice)) {
    return null;
  }
  return records.find((r) => (r.id ?? r.timestamp) === choice) ?? null;
}

/** Options for cmdExport — injectable for testing. */
export interface ExportOptions {
  /** Override the runner construction (test injection). */
  makeRunner?: (
    ip: string,
    user: string,
    keyOpts: string[],
  ) => {
    runServer: (cmd: string, timeoutSecs?: number) => Promise<void>;
    downloadFile: (remotePath: string, localPath: string) => Promise<void>;
    uploadFile: (localPath: string, remotePath: string) => Promise<void>;
  };
  /** Override visibility. If omitted, the user is prompted interactively
   *  with a "make public?" confirm that defaults to no (i.e. private). */
  visibility?: "private" | "public";
  /** Inject the candidate records directly (test seam to skip filterHistory). */
  records?: SpawnRecord[];
}

/** Top-level command: `spawn export [target]`. */
export async function cmdExport(target: string | undefined, options?: ExportOptions): Promise<void> {
  const all = options?.records ?? filterHistory();
  const exportable = exportableClaudeRecords(all);
  if (exportable.length === 0) {
    p.log.info("No claude spawns available to export.");
    p.log.info(`Run ${pc.cyan("spawn claude <cloud>")} first, then export the result.`);
    process.exit(1);
  }

  let picked: SpawnRecord | null = null;
  if (target) {
    picked = matchTarget(exportable, target);
    if (!picked) {
      p.log.error(`No claude spawn matches ${pc.bold(target)}.`);
      p.log.info(`Run ${pc.cyan("spawn list -a claude")} to see available targets.`);
      process.exit(1);
    }
  } else if (exportable.length === 1) {
    picked = exportable[0] ?? null;
  } else {
    picked = await pickOne(exportable);
    if (!picked) {
      handleCancel(); // never returns
    }
  }
  if (!picked) {
    // Defensive: the branches above either assign or exit, so this should
    // be unreachable. The explicit check keeps TypeScript narrowing happy
    // without an `!` non-null assertion.
    handleCancel();
  }
  const r: SpawnRecord = picked;
  const conn = r.connection;
  if (!conn) {
    // exportableClaudeRecords guarantees connection is present — a missing
    // connection here means state was mutated between filter and use.
    p.log.error("Internal error: selected spawn has no connection info.");
    process.exit(1);
  }

  p.log.step(`Exporting ${pc.bold(buildRecordLabel(r))} ${pc.dim(`(${buildRecordSubtitle(r, null)})`)}`);

  // Visibility: private by default. If the caller didn't force one (tests do),
  // ask the user whether to make the exported repo public. A private repo is
  // the safe default — the secret scan is a backstop, not a guarantee.
  let visibility: "private" | "public";
  if (options?.visibility) {
    visibility = options.visibility;
  } else {
    const makePublic = await p.confirm({
      message: "Make the exported repo public on GitHub?",
      initialValue: false,
    });
    if (p.isCancel(makePublic)) {
      handleCancel();
    }
    visibility = makePublic === true ? "public" : "private";
  }
  const steps = resolveSteps(r);

  // Pick a runner: tests inject one; sprite uses sprite's exec channel; everything
  // else goes over SSH using the connection's ip/user.
  const runner = options?.makeRunner ? options.makeRunner(conn.ip, conn.user, []) : await buildRunnerForRecord(r);

  const scriptOpts = {
    spawnMd: buildSpawnMd(r),
    readmeTemplate: buildReadmeTemplate(),
    gitignore: buildGitignore(),
    cloud: r.cloud,
    steps,
    visibility,
    resultPath: REMOTE_RESULT_PATH,
  };

  // First pass: never redact. If hits are found, the script writes a
  // needs_confirmation result and exits. If not, it pushes.
  p.log.step("Running export on the VM (claude is naming the repo)...");
  let parsed = await runPassAndParseResult(
    runner,
    buildExportScript({
      ...scriptOpts,
      allowRedact: false,
    }),
  );

  // Gate: if the VM reported needs_confirmation, show the file list and
  // prompt the user. On approval, re-run with ALLOW_REDACT=1.
  if (!parsed.ok && "needsConfirmation" in parsed && parsed.needsConfirmation === true) {
    console.log();
    p.log.warn(`Potential secrets detected in ${parsed.hits.length} file${parsed.hits.length === 1 ? "" : "s"}:`);
    for (const f of parsed.hits) {
      console.log(pc.dim(`  - ${f}`));
    }
    console.log();
    p.log.info(
      "Matches will be replaced with '***REDACTED-BY-SPAWN-EXPORT***' before the repo is pushed. The regex has known gaps — review the list above and cancel if anything looks like a real secret you'd rather scrub by hand.",
    );
    const approved = await p.confirm({
      message: `Redact ${parsed.hits.length === 1 ? "this file" : "these files"} and continue pushing to GitHub?`,
      initialValue: false,
    });
    if (p.isCancel(approved) || approved !== true) {
      p.log.info("Export cancelled. Nothing was pushed.");
      process.exit(0);
    }
    p.log.step("Re-running export with redaction enabled...");
    parsed = await runPassAndParseResult(
      runner,
      buildExportScript({
        ...scriptOpts,
        allowRedact: true,
      }),
    );
  }

  if (!parsed.ok) {
    // Any remaining non-ok shape is a hard error.
    p.log.error("error" in parsed ? parsed.error : "Export ran but produced no parseable result.");
    process.exit(1);
  }

  console.log();
  p.log.success(`Exported to ${pc.cyan(parsed.url)}`);
  if (parsed.redacted && parsed.redacted.length > 0) {
    p.log.warn(
      `Redacted potential secrets in ${parsed.redacted.length} file${parsed.redacted.length === 1 ? "" : "s"}:`,
    );
    for (const f of parsed.redacted) {
      console.log(pc.dim(`  - ${f}`));
    }
  }
  console.log();
  console.log(pc.dim("Re-spawn with:"));
  console.log(`  ${pc.cyan(`spawn ${CLAUDE_AGENT} ${r.cloud} --repo ${parsed.slug} --steps ${steps}`)}`);
  console.log();
}

/** Run the export script on the VM, download the result file, parse it, and
 *  return the validated shape. Exits the process on any infrastructure-level
 *  failure (ssh, download, unparseable JSON) — the caller only has to handle
 *  the three valid result shapes. */
async function runPassAndParseResult(
  runner: ExportRunner,
  script: string,
): Promise<v.InferOutput<typeof ResultSchema>> {
  // 10-min timeout — large repos take time to push.
  const runResult = await asyncTryCatch(() => runner.runServer(script, 600));
  if (!runResult.ok) {
    p.log.error(`Export failed: ${getErrorMessage(runResult.error)}`);
    p.log.info("Check that `gh` is authenticated on the VM (`gh auth status`).");
    process.exit(1);
  }

  const localTmp = mkdtempSync(join(tmpdir(), "spawn-export-"));
  const localResult = join(localTmp, "result.json");
  const dlResult = await asyncTryCatch(() => runner.downloadFile(REMOTE_RESULT_PATH, localResult));
  if (!dlResult.ok) {
    rmSync(localTmp, {
      recursive: true,
      force: true,
    });
    p.log.error(`Could not read export result: ${getErrorMessage(dlResult.error)}`);
    process.exit(1);
  }
  const text = readFileSync(localResult, "utf8");
  rmSync(localTmp, {
    recursive: true,
    force: true,
  });
  const parsed = parseJsonWith(text, ResultSchema);
  if (!parsed) {
    p.log.error("Export ran but produced no parseable result.");
    process.exit(1);
  }
  return parsed;
}

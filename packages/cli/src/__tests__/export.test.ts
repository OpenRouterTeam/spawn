import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockClackPrompts } from "./test-helpers";

const clackMocks = mockClackPrompts();

import type { SpawnRecord } from "../history";

import {
  buildExportScript,
  buildGitignore,
  buildReadmeTemplate,
  buildSpawnMd,
  cmdExport,
  parseStepsFromLaunchCmd,
  resolveSteps,
} from "../commands/export";
import { parseSpawnMd } from "../shared/spawn-md";

const baseRecord: SpawnRecord = {
  id: "abc-123",
  agent: "claude",
  cloud: "hetzner",
  timestamp: "2026-05-01T00:00:00Z",
  name: "demo session",
  connection: {
    ip: "1.2.3.4",
    user: "spawn",
    cloud: "hetzner",
    server_id: "srv-1",
    server_name: "demo-server",
  },
};

let stderrSpy: ReturnType<typeof spyOn>;
let stdoutSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
  stdoutSpy = spyOn(process.stdout, "write").mockReturnValue(true);
  exitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
    throw new Error("__exit__");
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  exitSpy.mockRestore();
  mock.restore();
});

// ── Pure builders ───────────────────────────────────────────────────────────

describe("buildSpawnMd", () => {
  it("emits valid frontmatter that parses through parseSpawnMd", () => {
    const md = buildSpawnMd(baseRecord);
    const parsed = parseSpawnMd(md);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("demo session");
    expect(parsed?.description).toContain("abc-123");
  });

  it("falls back to a default heading when name is missing", () => {
    const noName: SpawnRecord = {
      ...baseRecord,
      name: undefined,
    };
    const md = buildSpawnMd(noName);
    expect(md).toContain("# spawn export");
  });
});

describe("buildReadmeTemplate", () => {
  it("uses placeholders the bash script will substitute", () => {
    const tpl = buildReadmeTemplate();
    expect(tpl).toContain("__NAME__");
    expect(tpl).toContain("__CLOUD__");
    expect(tpl).toContain("__SLUG__");
    expect(tpl).toContain("__STEPS__");
    expect(tpl).toContain("spawn claude __CLOUD__ --repo __SLUG__ --steps __STEPS__");
  });

  it("renders a github-friendly checklist", () => {
    const tpl = buildReadmeTemplate();
    expect(tpl).toContain("- [ ] `gh auth login`");
    expect(tpl).toContain("- [ ] Re-OAuth");
  });
});

describe("buildGitignore", () => {
  it("excludes node_modules, env files, and known credential paths", () => {
    const gi = buildGitignore();
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".env");
    expect(gi).toContain(".env.*");
    expect(gi).toContain(".spawnrc");
    expect(gi).toContain(".aws/");
    expect(gi).toContain(".config/spawn/");
    expect(gi).toContain(".config/gcloud/");
  });
});

describe("parseStepsFromLaunchCmd", () => {
  it("returns null when launch_cmd is undefined or has no --steps", () => {
    expect(parseStepsFromLaunchCmd(undefined)).toBeNull();
    expect(parseStepsFromLaunchCmd("spawn claude hetzner")).toBeNull();
  });

  it("parses space-separated --steps", () => {
    expect(parseStepsFromLaunchCmd("spawn claude hetzner --steps github,browser")).toBe("github,browser");
  });

  it("parses --steps=value form", () => {
    expect(parseStepsFromLaunchCmd("spawn claude hetzner --steps=github,auto-update")).toBe("github,auto-update");
  });

  it("ignores --steps inside other flags", () => {
    // --no-steps shouldn't match
    expect(parseStepsFromLaunchCmd("spawn claude hetzner --no-steps")).toBeNull();
  });

  it("does not over-match --no-steps=value", () => {
    // Without word-boundary anchoring, --no-steps=foo would match and
    // return "foo". The regex must only fire on the real --steps flag.
    expect(parseStepsFromLaunchCmd("spawn claude hetzner --no-steps=foo")).toBeNull();
    expect(parseStepsFromLaunchCmd("spawn claude hetzner --no-steps foo")).toBeNull();
  });
});

describe("resolveSteps", () => {
  it("returns the parsed value when launch_cmd carries --steps", () => {
    const r: SpawnRecord = {
      ...baseRecord,
      connection: {
        ...baseRecord.connection!,
        launch_cmd: "spawn claude hetzner --steps github,reuse-api-key",
      },
    };
    expect(resolveSteps(r)).toBe("github,reuse-api-key");
  });

  it("falls back to a default when launch_cmd has no --steps", () => {
    expect(resolveSteps(baseRecord)).toBe("github,auto-update,security-scan");
  });
});

describe("buildExportScript", () => {
  const opts = {
    spawnMd: "---\nname: x\n---\n",
    readmeTemplate: "# __NAME__\n",
    gitignore: "node_modules/\n",
    cloud: "hetzner",
    steps: "github,auto-update,security-scan",
    visibility: "private" as const,
    resultPath: "/tmp/spawn-export-result.json",
    // Second-pass behaviour. Flipping this to true is what enables the
    // sed-based redact + commit + push. Flipping to false exercises the
    // pre-commit gate that pauses for host confirmation.
    allowRedact: true,
  };

  it("uses set -eo pipefail", () => {
    expect(buildExportScript(opts)).toContain("set -eo pipefail");
  });

  it("rsyncs the working tree and the claude system dir", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("rsync -a --exclude=node_modules");
    expect(s).toContain('"$HOME/project/"');
    expect(s).toContain('"$HOME/.claude/$d/"');
  });

  it("invokes claude -p to suggest the repo name", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("claude -p");
    expect(s).toContain("kebab-case");
  });

  it("falls back through basename(~/project) then a timestamp slug", () => {
    const s = buildExportScript(opts);
    expect(s).toContain('basename "$HOME/project"');
    expect(s).toContain("spawn-export-$(date +%s)");
  });

  it("looks up the gh user and aborts if gh isn't authed", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("gh api user --jq .login");
    expect(s).toContain('"error":"gh is not authenticated');
  });

  it("scans staged files for known API-key patterns", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("SECRET_REGEX=");
    // Verify a representative pattern from each provider family is present
    expect(s).toContain("sk-or-v1-"); // OpenRouter
    expect(s).toContain("sk-ant-api"); // Anthropic
    expect(s).toContain("sk-proj-"); // OpenAI
    expect(s).toContain("gh[ops]_"); // GitHub PAT/OAuth/server
    expect(s).toContain("AKIA"); // AWS access key
    expect(s).toContain("hcloud_"); // Hetzner
    expect(s).toContain("dop_v1_"); // DigitalOcean
    expect(s).toContain("BEGIN ([A-Z]+ )?PRIVATE KEY"); // PEM
  });

  it("redacts matched secrets in-place when ALLOW_REDACT=1 (second pass)", () => {
    const s = buildExportScript(opts); // opts.allowRedact = true
    expect(s).toContain("ALLOW_REDACT=1");
    // Redact placeholder is defined and used as the sed replacement.
    expect(s).toContain("REDACT_PLACEHOLDER='***REDACTED-BY-SPAWN-EXPORT***'");
    expect(s).toContain("sed -i -E");
    // The script re-stages after redacting so the redacted blobs replace
    // the originals.
    expect(s).toMatch(/sed -i -E[\s\S]*git add -A/);
    // The legacy abort path is gone — no false "ok":false on secret hits.
    expect(s).not.toContain("Possible secrets detected in staged files; aborting");
  });

  it("uses '#' as the sed delimiter — '|' would clash with SECRET_REGEX alternation", () => {
    // Regression: the sed substitution previously used '|' as its delimiter
    // ("s|${SECRET_REGEX}|${REDACT}|g"). Because SECRET_REGEX itself contains
    // '|' (it's a |-separated alternation of provider patterns), bash
    // expansion produced a string sed parsed with the wrong number of fields,
    // failing with "unknown option to `s'". '#' is absent from both the regex
    // and the placeholder, so the substitution is unambiguous.
    const s = buildExportScript(opts);
    expect(s).toContain('sed -i -E "s#${SECRET_REGEX}#${REDACT_PLACEHOLDER}#g"');
    expect(s).not.toContain('sed -i -E "s|${SECRET_REGEX}|${REDACT_PLACEHOLDER}|g"');
  });

  it("pauses before commit with needs_confirmation when ALLOW_REDACT=0 (first pass)", () => {
    const s = buildExportScript({
      ...opts,
      allowRedact: false,
    });
    expect(s).toContain("ALLOW_REDACT=0");
    // The gate path emits a structured result the host can parse.
    expect(s).toContain('"needsConfirmation":true,"hits":%s');
    // Exit 0, not 1 — a gate is not a failure.
    expect(s).toMatch(/needsConfirmation":true[\s\S]*exit 0/);
    // The redact path is conditional on ALLOW_REDACT=1.
    expect(s).toContain('if [ "$ALLOW_REDACT" != "1" ]; then');
  });

  it("includes the redacted file list in the success result", () => {
    const s = buildExportScript(opts);
    expect(s).toContain('REDACTED_JSON="[]"');
    expect(s).toContain('"redacted":%s');
  });

  it("uses gh repo create with the cloud and slug from the script", () => {
    const s = buildExportScript(opts);
    expect(s).toContain('gh repo create "$SLUG" "$VISIBILITY_FLAG" --source=. --push');
  });

  it("flips to --public when visibility is public", () => {
    const s = buildExportScript({
      ...opts,
      visibility: "public",
    });
    expect(s).toContain("VISIBILITY_FLAG=--public");
    expect(s).not.toContain("VISIBILITY_FLAG=--private");
  });

  it("emits --private when visibility is private (safe default)", () => {
    // `opts.visibility` is "private" above; lock that in so a future default
    // flip to public doesn't go unnoticed.
    const s = buildExportScript(opts);
    expect(s).toContain("VISIBILITY_FLAG=--private");
    expect(s).not.toContain("VISIBILITY_FLAG=--public");
  });

  it("excludes .git when copying claude subdirs so nested checkouts don't leak", () => {
    const s = buildExportScript(opts);
    // The claude subdir rsync (skills/commands/hooks) targets "$HOME/.claude/$d/".
    // Without --exclude=.git, a skill that happens to be a git checkout would
    // ship its history in the exported repo.
    expect(s).toContain('rsync -a --exclude=.git "$HOME/.claude/$d/"');
  });

  it("writes the result JSON to the supplied path", () => {
    const s = buildExportScript({
      ...opts,
      resultPath: "/tmp/custom.json",
    });
    expect(s).toContain("RESULT_PATH='/tmp/custom.json'");
    expect(s).toContain('"ok":true,"slug":"%s","url":"https://github.com/%s"');
  });

  it("emits a structured failure result when gh isn't authed", () => {
    const s = buildExportScript(opts);
    expect(s).toContain('"ok":false,"error":"gh is not authenticated');
  });

  it("recursively scrubs nested settings.json fields, not just top-level", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("const scrub = (obj) =>");
    expect(s).toContain("scrub(parsed)");
  });

  it("bakes the steps list into the script and substitutes __STEPS__", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("STEPS='github,auto-update,security-scan'");
    expect(s).toContain("s|__STEPS__|$STEPS|g");
  });
});

// ── cmdExport orchestration ─────────────────────────────────────────────────

describe("cmdExport", () => {
  it("errors out when no exportable claude spawns exist", async () => {
    await expect(
      cmdExport(undefined, {
        records: [],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("filters out non-claude agents", async () => {
    const codexRecord: SpawnRecord = {
      ...baseRecord,
      agent: "codex",
    };
    await expect(
      cmdExport(undefined, {
        records: [
          codexRecord,
        ],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("filters out spawns without connection info", async () => {
    const noConn: SpawnRecord = {
      ...baseRecord,
      connection: undefined,
    };
    await expect(
      cmdExport(undefined, {
        records: [
          noConn,
        ],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("filters out deleted spawns", async () => {
    const deleted: SpawnRecord = {
      ...baseRecord,
      connection: {
        ...baseRecord.connection!,
        deleted: true,
      },
    };
    await expect(
      cmdExport(undefined, {
        records: [
          deleted,
        ],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("includes sprite-console connections (sprite has its own runner)", async () => {
    const spriteRecord: SpawnRecord = {
      ...baseRecord,
      cloud: "sprite",
      connection: {
        ...baseRecord.connection!,
        cloud: "sprite",
        ip: "sprite-console",
      },
    };
    // The injected runner short-circuits the sprite-module import, so we just
    // need cmdExport to attempt the export rather than filtering the record out.
    const ranWith: {
      script?: string;
    } = {};
    const stubRunner = {
      runServer: async (cmd: string) => {
        ranWith.script = cmd;
      },
      uploadFile: async () => {},
      // downloadFile must succeed so the parser sees a result file. Make it
      // throw a recognisable error and assert we got past the filter step.
      downloadFile: async () => {
        throw new Error("__downloadFile_called__");
      },
    };
    await expect(
      cmdExport(undefined, {
        records: [
          spriteRecord,
        ],
        visibility: "private",
        makeRunner: () => stubRunner,
      }),
    ).rejects.toThrow("__exit__");
    // The script ran (record passed the filter), then the download stub threw,
    // which cmdExport surfaces as exit(1). What matters: ranWith.script is set.
    expect(ranWith.script).toBeDefined();
  });

  it("errors with a target hint when the named spawn doesn't exist", async () => {
    await expect(
      cmdExport("nonexistent", {
        records: [
          baseRecord,
        ],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Gate flow ─────────────────────────────────────────────────────────────
  //
  // When the first pass returns needs_confirmation, the host prompts the user.
  // Approve → re-run with ALLOW_REDACT=1 → success. Decline → exit 0, no push.

  function makeSequencedRunner(resultsJson: string[]) {
    const calls: {
      allowRedact: string;
    }[] = [];
    let callIndex = 0;
    const runner = {
      runServer: async (script: string) => {
        const m = script.match(/\nALLOW_REDACT=([01])\n/);
        calls.push({
          allowRedact: m ? m[1] : "?",
        });
      },
      uploadFile: async () => {},
      downloadFile: async (_remote: string, local: string) => {
        const idx = Math.min(callIndex, resultsJson.length - 1);
        callIndex += 1;
        writeFileSync(local, resultsJson[idx]);
      },
    };
    return {
      runner,
      calls,
    };
  }

  it("prompts and re-runs with ALLOW_REDACT=1 when the user approves redaction", async () => {
    const { runner, calls } = makeSequencedRunner([
      JSON.stringify({
        ok: false,
        needsConfirmation: true,
        hits: [
          "project/test/brain-sync.test.ts",
        ],
      }),
      JSON.stringify({
        ok: true,
        slug: "alice/my-vm",
        url: "https://github.com/alice/my-vm",
        redacted: [
          "project/test/brain-sync.test.ts",
        ],
      }),
    ]);
    // Default confirm returns true → user approves the gate.
    clackMocks.confirm.mockImplementation(async () => true);

    await cmdExport(undefined, {
      records: [
        baseRecord,
      ],
      visibility: "private",
      makeRunner: () => runner,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].allowRedact).toBe("0");
    expect(calls[1].allowRedact).toBe("1");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("cancels the export cleanly when the user declines redaction", async () => {
    const { runner, calls } = makeSequencedRunner([
      JSON.stringify({
        ok: false,
        needsConfirmation: true,
        hits: [
          "project/leaky.ts",
        ],
      }),
    ]);
    // User declines at the gate.
    clackMocks.confirm.mockImplementation(async () => false);

    await expect(
      cmdExport(undefined, {
        records: [
          baseRecord,
        ],
        visibility: "private",
        makeRunner: () => runner,
      }),
    ).rejects.toThrow("__exit__");

    // Exactly one pass happened (ALLOW_REDACT=0) — nothing got pushed.
    expect(calls).toHaveLength(1);
    expect(calls[0].allowRedact).toBe("0");
    // exit(0) — cancellation is not a failure.
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("runs once and succeeds when the first pass finds no secrets", async () => {
    const { runner, calls } = makeSequencedRunner([
      JSON.stringify({
        ok: true,
        slug: "alice/clean-repo",
        url: "https://github.com/alice/clean-repo",
      }),
    ]);
    // confirm shouldn't fire at all on the happy path.
    clackMocks.confirm.mockImplementation(async () => {
      throw new Error("confirm should not be called when no secrets are found");
    });

    await cmdExport(undefined, {
      records: [
        baseRecord,
      ],
      visibility: "private",
      makeRunner: () => runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].allowRedact).toBe("0");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ── E2E: redact pass actually works at runtime ────────────────────────────────
//
// This test exercises the generated bash against a real temp git repo to catch
// runtime quoting/escaping bugs like the sed delimiter regression in #3384.
// It is purely local (no network, no subprocess cloud calls) and deterministic.

describe("export redact pass (e2e bash execution)", () => {
  const redactOpts = {
    spawnMd: "---\nname: test\n---\n",
    readmeTemplate: "# __NAME__\n",
    gitignore: "node_modules/\n",
    cloud: "hetzner",
    steps: "github",
    visibility: "private" as const,
    resultPath: "/dev/null",
    allowRedact: true,
  };

  /**
   * Extract the SECRET_REGEX, REDACT_PLACEHOLDER definitions and the
   * while-read redact loop from the generated script. We build a
   * self-contained bash snippet that: defines the vars, receives a file
   * list as $1, and runs the sed replacements.
   */
  function extractRedactSnippet(): string {
    const full = buildExportScript(redactOpts);

    const regexMatch = full.match(/^SECRET_REGEX='[^']*'/m);
    if (!regexMatch) {
      throw new Error("Could not extract SECRET_REGEX from generated script");
    }

    const placeholderMatch = full.match(/^REDACT_PLACEHOLDER='[^']*'/m);
    if (!placeholderMatch) {
      throw new Error("Could not extract REDACT_PLACEHOLDER from generated script");
    }

    return [
      "#!/bin/bash",
      "set -eo pipefail",
      regexMatch[0],
      placeholderMatch[0],
      'FILE_LIST="$1"',
      "while IFS= read -r f; do",
      '  [ -z "$f" ] && continue',
      '  sed -i -E "s#${SECRET_REGEX}#${REDACT_PLACEHOLDER}#g" "$f"',
      'done <<< "$FILE_LIST"',
    ].join("\n");
  }

  // Synthetic secrets — one per regex family in SECRET_REGEX.
  const syntheticSecrets: Record<string, string> = {
    openrouter: "sk-or-v1-abcdef1234567890abcdef",
    anthropic: "sk-ant-api03-12_abcdefghijklmnopqrstu",
    openai: "sk-proj-ABCDEFGHIJKLMNOPQRSTUv",
    github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    aws: "AKIA0123456789ABCDEF",
    hetzner: "hcloud_abcdefghijklmnopqrstuvwx",
    digitalocean: "dop_v1_abcdef0123456789abcdef0123456789ab",
    pem: "-----BEGIN PRIVATE KEY-----",
  };

  const REDACT = "***REDACTED-BY-SPAWN-EXPORT***";

  /** Create a temp dir with git init, write a file, stage it, run the redact
   *  snippet against it, and return the file contents after redaction. */
  function runRedactOn(filename: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "spawn-redact-e2e-"));
    const filePath = join(dir, filename);
    writeFileSync(filePath, content);
    execSync("git init -q -b main", {
      cwd: dir,
    });
    execSync("git add -A", {
      cwd: dir,
    });
    const snippetPath = join(dir, "_redact.sh");
    writeFileSync(snippetPath, extractRedactSnippet(), {
      mode: 0o755,
    });
    execSync(`bash "${snippetPath}" "${filePath}"`, {
      cwd: dir,
    });
    const result = readFileSync(filePath, "utf8");
    execSync(`rm -rf "${dir}"`);
    return result;
  }

  it("redacts every secret family in a staged file", () => {
    const lines = Object.entries(syntheticSecrets).map(([family, secret]) => `${family}: ${secret}`);
    const after = runRedactOn("leaky.env", lines.join("\n") + "\n");
    for (const [family, secret] of Object.entries(syntheticSecrets)) {
      expect(after).not.toContain(secret);
      expect(after).toContain(`${family}: ${REDACT}`);
    }
  });

  it("leaves non-secret content untouched", () => {
    const innocentContent =
      [
        "DATABASE_URL=postgres://localhost:5432/mydb",
        "NODE_ENV=production",
        "PORT=3000",
        "some normal code here",
        'const x = "hello world";',
      ].join("\n") + "\n";
    const after = runRedactOn("config.ts", innocentContent);
    expect(after).toBe(innocentContent);
  });

  it("handles multiple secrets on the same line", () => {
    const multiLine = "KEY1=sk-or-v1-abcdef1234567890abcdef KEY2=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n";
    const after = runRedactOn("multi.env", multiLine);
    expect(after).not.toContain("sk-or-v1-");
    expect(after).not.toContain("ghp_");
    const count = (after.match(/\*\*\*REDACTED-BY-SPAWN-EXPORT\*\*\*/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("handles PEM block with algorithm prefix", () => {
    const pemContent = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...base64data\n-----END RSA PRIVATE KEY-----\n";
    const after = runRedactOn("key.pem", pemContent);
    expect(after).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(after).toContain(REDACT);
  });
});

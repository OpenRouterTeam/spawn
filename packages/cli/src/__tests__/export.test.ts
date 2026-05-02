import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts();

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

  it("scans staged files for known API-key patterns and aborts on hit", () => {
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
    expect(s).toContain("Possible secrets detected");
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
});

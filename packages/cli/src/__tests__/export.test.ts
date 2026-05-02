import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import type { SpawnRecord } from "../history";

import { buildExportScript, buildGitignore, buildReadmeTemplate, buildSpawnMd, cmdExport } from "../commands/export";
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
    expect(tpl).toContain("spawn claude __CLOUD__ --repo __SLUG__");
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

describe("buildExportScript", () => {
  const opts = {
    spawnMd: "---\nname: x\n---\n",
    readmeTemplate: "# __NAME__\n",
    gitignore: "node_modules/\n",
    cloud: "hetzner",
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

  it("filters out sprite-console connections", async () => {
    const spriteConsole: SpawnRecord = {
      ...baseRecord,
      connection: {
        ...baseRecord.connection!,
        ip: "sprite-console",
      },
    };
    await expect(
      cmdExport(undefined, {
        records: [
          spriteConsole,
        ],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
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

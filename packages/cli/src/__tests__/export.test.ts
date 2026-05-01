import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import type { SpawnRecord } from "../history";

import { buildExportScript, buildGitignore, buildReadme, buildSpawnMd, cmdExport } from "../commands/export";
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

describe("buildReadme", () => {
  it("contains the canonical re-spawn command for claude", () => {
    const readme = buildReadme(baseRecord, "alice/demo");
    expect(readme).toContain("spawn claude hetzner --repo alice/demo");
  });

  it("renders a github-friendly checklist", () => {
    const readme = buildReadme(baseRecord, "alice/demo");
    expect(readme).toContain("- [ ] `gh auth login`");
    expect(readme).toContain("- [ ] Re-OAuth");
  });
});

describe("buildGitignore", () => {
  it("excludes node_modules and env files", () => {
    const gi = buildGitignore();
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".env");
    expect(gi).toContain(".env.*");
  });
});

describe("buildExportScript", () => {
  const opts = {
    spawnMd: "---\nname: x\n---\n",
    readme: "# x\n",
    gitignore: "node_modules/\n",
    slug: "alice/demo",
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

  it("calls gh repo create with the right slug and visibility", () => {
    const s = buildExportScript(opts);
    expect(s).toContain("gh repo create 'alice/demo' --private");
    expect(s).toContain("--source=. --push");
  });

  it("flips to --public when visibility is public", () => {
    const s = buildExportScript({
      ...opts,
      visibility: "public",
    });
    expect(s).toContain("--public");
    expect(s).not.toContain("--private");
  });

  it("writes the result JSON to the supplied path", () => {
    const s = buildExportScript({
      ...opts,
      resultPath: "/tmp/custom.json",
    });
    expect(s).toContain("'/tmp/custom.json'");
    expect(s).toContain('"slug":"alice/demo"');
    expect(s).toContain('"url":"https://github.com/alice/demo"');
  });
});

// ── cmdExport orchestration ─────────────────────────────────────────────────

describe("cmdExport", () => {
  it("errors out when the target spawn isn't claude", async () => {
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

  it("errors out when no claude spawns exist", async () => {
    await expect(
      cmdExport(undefined, {
        records: [],
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects spawns without connection info", async () => {
    const noConn: SpawnRecord = {
      ...baseRecord,
      connection: undefined,
    };
    await expect(
      cmdExport(undefined, {
        records: [
          noConn,
        ],
        repo: {
          slug: "a/b",
          visibility: "private",
        },
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects deleted spawns", async () => {
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
        repo: {
          slug: "a/b",
          visibility: "private",
        },
      }),
    ).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

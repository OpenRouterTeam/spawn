/**
 * Generic HTTP trigger server for Sprite services.
 *
 * Reads config from env vars:
 *   TRIGGER_SECRET  — Bearer token for auth (required)
 *   TARGET_SCRIPT   — Path to script to run on trigger (required)
 *   MAX_CONCURRENT  — Max parallel runs (default: 1)
 *   RUN_TIMEOUT_MS  — Kill runs older than this (default: 30 min)
 *
 * Endpoints:
 *   GET  /health  → {"status":"ok", runs, ...}
 *   POST /trigger → validates auth, runs TARGET_SCRIPT in background
 *
 * Stale run detection:
 *   Before accepting a trigger, checks if tracked processes are still alive.
 *   Dead processes are reaped automatically. Runs exceeding RUN_TIMEOUT_MS
 *   are killed to prevent indefinite hangs.
 */

const PORT = 8080;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET ?? "";
const TARGET_SCRIPT = process.env.TARGET_SCRIPT ?? "";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT ?? "1", 10);
const RUN_TIMEOUT_MS = parseInt(
  process.env.RUN_TIMEOUT_MS ?? String(4 * 60 * 60 * 1000),
  10
);

if (!TRIGGER_SECRET) {
  console.error("ERROR: TRIGGER_SECRET env var is required");
  process.exit(1);
}

if (!TARGET_SCRIPT) {
  console.error("ERROR: TARGET_SCRIPT env var is required");
  process.exit(1);
}

interface RunEntry {
  proc: ReturnType<typeof Bun.spawn>;
  startedAt: number;
  reason: string;
  issue: string;
}

let shuttingDown = false;
const runs = new Map<number, RunEntry>();
let nextRunId = 1;

/** Check if a process is still alive via kill(0) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reap dead processes and kill runs that exceed the timeout */
function reapAndEnforce() {
  const now = Date.now();
  for (const [id, run] of runs) {
    const pid = run.proc.pid;
    const elapsed = now - run.startedAt;

    // Check if process is still alive
    if (!isAlive(pid)) {
      console.log(
        `[trigger] Reaping dead run #${id} (pid=${pid}, reason=${run.reason}, age=${Math.round(elapsed / 1000)}s)`
      );
      runs.delete(id);
      continue;
    }

    // Kill if exceeded timeout
    if (elapsed > RUN_TIMEOUT_MS) {
      console.log(
        `[trigger] Killing stale run #${id} (pid=${pid}, reason=${run.reason}, age=${Math.round(elapsed / 1000)}s, timeout=${Math.round(RUN_TIMEOUT_MS / 1000)}s)`
      );
      try {
        run.proc.kill(9);
      } catch {}
      runs.delete(id);
    }
  }
}

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[trigger] Received ${signal}, shutting down gracefully...`);
  console.log(
    `[trigger] Waiting for ${runs.size} running script(s) to finish...`
  );

  server.stop();

  if (runs.size === 0) {
    console.log(`[trigger] No running scripts, exiting immediately`);
    process.exit(0);
  }

  const HARD_TIMEOUT_MS = 15 * 60 * 1000;
  const forceKillTimer = setTimeout(() => {
    console.error(
      `[trigger] Hard timeout reached (${HARD_TIMEOUT_MS / 1000}s), force killing remaining processes`
    );
    for (const [, run] of runs) {
      try {
        run.proc.kill(9);
      } catch {}
    }
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  forceKillTimer.unref?.();

  Promise.all(Array.from(runs.values()).map((r) => r.proc.exited))
    .then(() => {
      console.log(`[trigger] All scripts finished, exiting`);
      clearTimeout(forceKillTimer);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[trigger] Error waiting for scripts:`, e);
      clearTimeout(forceKillTimer);
      process.exit(1);
    });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

async function runScript(reason: string, issue: string) {
  const id = nextRunId++;
  const startedAt = Date.now();
  console.log(
    `[trigger] Run #${id} starting (reason=${reason}${issue ? `, issue=#${issue}` : ""}, concurrent=${runs.size + 1}/${MAX_CONCURRENT})`
  );
  try {
    const proc = Bun.spawn(["bash", TARGET_SCRIPT], {
      cwd:
        process.env.REPO_ROOT ||
        TARGET_SCRIPT.substring(0, TARGET_SCRIPT.lastIndexOf("/")) ||
        ".",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        SPAWN_ISSUE: issue,
        SPAWN_REASON: reason,
      },
    });
    runs.set(id, { proc, startedAt, reason, issue });
    await proc.exited;
    runs.delete(id);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[trigger] Run #${id} finished (exit=${proc.exitCode}, duration=${elapsed}s, concurrent=${runs.size}/${MAX_CONCURRENT})`
    );
  } catch (e) {
    console.error(`[trigger] Run #${id} failed:`, e);
    runs.delete(id);
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      reapAndEnforce();
      const now = Date.now();
      const activeRuns = Array.from(runs.entries()).map(([id, r]) => ({
        id,
        pid: r.proc.pid,
        reason: r.reason,
        issue: r.issue || undefined,
        ageSec: Math.round((now - r.startedAt) / 1000),
      }));
      return Response.json({
        status: "ok",
        running: runs.size,
        max: MAX_CONCURRENT,
        timeoutSec: Math.round(RUN_TIMEOUT_MS / 1000),
        shuttingDown,
        runs: activeRuns,
      });
    }

    if (req.method === "POST" && url.pathname === "/trigger") {
      if (shuttingDown) {
        return Response.json(
          { error: "server is shutting down" },
          { status: 503 }
        );
      }

      const auth = req.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${TRIGGER_SECRET}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // Reap dead processes and kill timed-out runs before checking capacity
      reapAndEnforce();

      if (runs.size >= MAX_CONCURRENT) {
        const now = Date.now();
        const oldest = Array.from(runs.values()).reduce((a, b) =>
          a.startedAt < b.startedAt ? a : b
        );
        return Response.json(
          {
            error: "max concurrent runs reached",
            running: runs.size,
            max: MAX_CONCURRENT,
            oldestPid: oldest.proc.pid,
            oldestAgeSec: Math.round((now - oldest.startedAt) / 1000),
            timeoutSec: Math.round(RUN_TIMEOUT_MS / 1000),
          },
          { status: 429 }
        );
      }

      const reason = url.searchParams.get("reason") ?? "manual";
      const issue = url.searchParams.get("issue") ?? "";

      // Dedup: reject if a run for the same issue is already in progress
      if (issue) {
        for (const [, run] of runs) {
          if (run.issue === issue) {
            return Response.json(
              {
                error: "run for this issue already in progress",
                issue,
                running: runs.size,
              },
              { status: 409 }
            );
          }
        }
      }

      // Fire and forget
      runScript(reason, issue);

      return Response.json({
        triggered: true,
        reason,
        issue: issue || undefined,
        running: runs.size,
        max: MAX_CONCURRENT,
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

// Proactively reap stale runs every 60 seconds instead of only on requests
const reapInterval = setInterval(() => {
  if (runs.size > 0) reapAndEnforce();
}, 60_000);
reapInterval.unref?.();

console.log(`[trigger] Listening on port ${server.port}`);
console.log(`[trigger] TARGET_SCRIPT=${TARGET_SCRIPT}`);
console.log(`[trigger] MAX_CONCURRENT=${MAX_CONCURRENT}`);
console.log(
  `[trigger] RUN_TIMEOUT_MS=${RUN_TIMEOUT_MS} (${Math.round(RUN_TIMEOUT_MS / 1000 / 60)}min)`
);

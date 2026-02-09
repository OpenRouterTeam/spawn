/**
 * Generic HTTP trigger server for Sprite services.
 *
 * Reads config from env vars:
 *   TRIGGER_SECRET  — Bearer token for auth (required)
 *   TARGET_SCRIPT   — Path to script to run on trigger (required)
 *
 * Endpoints:
 *   GET  /health  → {"status":"ok"}
 *   POST /trigger → validates auth, runs TARGET_SCRIPT in background
 */

const PORT = 8080;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET ?? "";
const TARGET_SCRIPT = process.env.TARGET_SCRIPT ?? "";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT ?? "1", 10);

if (!TRIGGER_SECRET) {
  console.error("ERROR: TRIGGER_SECRET env var is required");
  process.exit(1);
}

if (!TARGET_SCRIPT) {
  console.error("ERROR: TARGET_SCRIPT env var is required");
  process.exit(1);
}

let runningCount = 0;
let shuttingDown = false;
const runningProcs = new Set<ReturnType<typeof Bun.spawn>>();

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[trigger] Received ${signal}, shutting down gracefully...`);
  console.log(
    `[trigger] Waiting for ${runningProcs.size} running script(s) to finish...`
  );

  // Stop accepting new connections
  server.stop();

  if (runningProcs.size === 0) {
    console.log(`[trigger] No running scripts, exiting immediately`);
    process.exit(0);
  }

  // Hard deadline: 15 minutes max wait, then force kill
  const HARD_TIMEOUT_MS = 15 * 60 * 1000;
  const forceKillTimer = setTimeout(() => {
    console.error(
      `[trigger] Hard timeout reached (${HARD_TIMEOUT_MS / 1000}s), force killing remaining processes`
    );
    for (const proc of runningProcs) {
      try {
        proc.kill(9);
      } catch {}
    }
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  forceKillTimer.unref?.();

  // Wait for all running scripts to finish
  Promise.all(Array.from(runningProcs).map((proc) => proc.exited))
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

async function runScript(reason: string) {
  runningCount++;
  console.log(
    `[trigger] Running ${TARGET_SCRIPT} (reason=${reason}, concurrent=${runningCount}/${MAX_CONCURRENT})`
  );
  try {
    const proc = Bun.spawn(["bash", TARGET_SCRIPT], {
      cwd:
        process.env.REPO_ROOT ||
        TARGET_SCRIPT.substring(0, TARGET_SCRIPT.lastIndexOf("/")) ||
        ".",
      stdout: "inherit",
      stderr: "inherit",
    });
    runningProcs.add(proc);
    await proc.exited;
    runningProcs.delete(proc);
    console.log(
      `[trigger] ${TARGET_SCRIPT} finished (exit=${proc.exitCode}, concurrent=${runningCount - 1}/${MAX_CONCURRENT})`
    );
  } catch (e) {
    console.error(`[trigger] ${TARGET_SCRIPT} failed:`, e);
  } finally {
    runningCount--;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", running: runningCount, shuttingDown });
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

      if (runningCount >= MAX_CONCURRENT) {
        return Response.json(
          {
            error: "max concurrent runs reached",
            running: runningCount,
            max: MAX_CONCURRENT,
          },
          { status: 429 }
        );
      }

      const reason = url.searchParams.get("reason") ?? "manual";

      // Fire and forget
      runScript(reason);

      return Response.json({
        triggered: true,
        reason,
        running: runningCount,
        max: MAX_CONCURRENT,
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[trigger] Listening on port ${server.port}`);
console.log(`[trigger] TARGET_SCRIPT=${TARGET_SCRIPT}`);
console.log(`[trigger] MAX_CONCURRENT=${MAX_CONCURRENT}`);

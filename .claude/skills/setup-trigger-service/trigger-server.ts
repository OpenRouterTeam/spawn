/**
 * Generic HTTP trigger server for Sprite services.
 *
 * Reads config from env vars:
 *   TRIGGER_SECRET  — Bearer token for auth (required)
 *   TARGET_SCRIPT   — Path to script to run on trigger (required)
 *   MAX_CONCURRENT  — Max parallel runs (default: 1)
 *   RUN_TIMEOUT_MS  — Kill runs older than this (default: 75 min)
 *
 * Endpoints:
 *   GET  /health  → {"status":"ok", runs, ...}
 *   POST /trigger → validates auth, runs TARGET_SCRIPT, streams output back
 *
 * The /trigger endpoint returns a streaming text/plain response with the
 * script's stdout/stderr. The long-lived HTTP connection keeps the Sprite
 * VM alive for the entire duration of the cycle (Sprite pauses VMs with
 * no active HTTP requests). A heartbeat line is emitted every 30s during
 * silent periods to prevent proxy idle timeouts.
 *
 * If the client disconnects mid-stream, the script keeps running — output
 * continues to drain to the server console.
 */

const PORT = 8080;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET ?? "";
const TARGET_SCRIPT = process.env.TARGET_SCRIPT ?? "";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT ?? "1", 10);
const RUN_TIMEOUT_MS = parseInt(
  process.env.RUN_TIMEOUT_MS ?? String(75 * 60 * 1000),
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

/**
 * Spawn the target script and return a streaming Response.
 *
 * stdout/stderr are piped back as chunked text/plain. A heartbeat line
 * is injected every 30 seconds of silence so the Sprite proxy (and any
 * intermediaries) keep the connection alive.
 *
 * If the HTTP client disconnects, the process keeps running — we just
 * stop writing to the response stream and continue draining to console.
 */
function startStreamingRun(reason: string, issue: string): Response {
  const id = nextRunId++;
  const startedAt = Date.now();

  console.log(
    `[trigger] Run #${id} starting (reason=${reason}${issue ? `, issue=#${issue}` : ""}, concurrent=${runs.size + 1}/${MAX_CONCURRENT})`
  );

  const proc = Bun.spawn(["bash", TARGET_SCRIPT], {
    cwd:
      process.env.REPO_ROOT ||
      TARGET_SCRIPT.substring(0, TARGET_SCRIPT.lastIndexOf("/")) ||
      ".",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SPAWN_ISSUE: issue,
      SPAWN_REASON: reason,
    },
  });

  runs.set(id, { proc, startedAt, reason, issue });

  // Safety net: ensure run is cleaned up even if streaming logic errors
  proc.exited
    .then(() => {
      if (runs.has(id)) runs.delete(id);
    })
    .catch(() => {
      if (runs.has(id)) runs.delete(id);
    });

  const encoder = new TextEncoder();
  let clientConnected = true;

  const stream = new ReadableStream({
    async start(controller) {
      // --- Header ---
      const header = `[trigger] Run #${id} started (reason=${reason}${issue ? `, issue=#${issue}` : ""}, concurrent=${runs.size}/${MAX_CONCURRENT})\n`;
      enqueue(controller, encoder.encode(header));

      // --- Heartbeat: emit every 30s of silence to keep proxy alive ---
      let lastActivity = Date.now();
      const heartbeat = setInterval(() => {
        if (!clientConnected) return;
        const silentMs = Date.now() - lastActivity;
        if (silentMs >= 29_000) {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const msg = `[heartbeat] Run #${id} active (${elapsed}s elapsed)\n`;
          enqueue(controller, encoder.encode(msg));
          lastActivity = Date.now();
        }
      }, 30_000);

      // --- Drain stdout + stderr concurrently ---
      async function drain(src: ReadableStream<Uint8Array> | null) {
        if (!src) return;
        const reader = src.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Always log locally
            process.stdout.write(value);
            // Stream to HTTP client if still connected
            lastActivity = Date.now();
            enqueue(controller, value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      await Promise.all([drain(proc.stdout), drain(proc.stderr)]);

      // --- Wait for exit ---
      const exitCode = await proc.exited;
      runs.delete(id);
      clearInterval(heartbeat);

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const footer = `\n[trigger] Run #${id} finished (exit=${exitCode}, duration=${elapsed}s, remaining=${runs.size}/${MAX_CONCURRENT})\n`;
      console.log(footer.trim());
      enqueue(controller, encoder.encode(footer));

      try {
        controller.close();
      } catch {}
    },

    cancel() {
      // Called when the HTTP client disconnects
      clientConnected = false;
      console.log(
        `[trigger] Client disconnected from run #${id} stream (process continues running)`
      );
    },
  });

  /** Safely enqueue data — swallow errors from client disconnect */
  function enqueue(
    controller: ReadableStreamDefaultController,
    chunk: Uint8Array
  ) {
    if (!clientConnected) return;
    try {
      controller.enqueue(chunk);
    } catch {
      clientConnected = false;
    }
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Run-Id": String(id),
      "X-Accel-Buffering": "no", // Nginx: don't buffer
      "Cache-Control": "no-cache",
    },
  });
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

      // Validate issue is a positive integer (prevents injection into shell commands)
      if (issue && !/^\d+$/.test(issue)) {
        return Response.json(
          { error: "issue must be a positive integer" },
          { status: 400 }
        );
      }

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

      // Stream the script output back as the response body.
      // The long-lived HTTP connection keeps the Sprite VM alive.
      return startStreamingRun(reason, issue);
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
console.log(`[trigger] Output streaming enabled — responses stream script output in chunks`);

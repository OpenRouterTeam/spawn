/**
 * Generic HTTP trigger server for Sprite services.
 *
 * Reusable on any sprite. Reads config from env vars:
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

if (!TRIGGER_SECRET) {
  console.error("ERROR: TRIGGER_SECRET env var is required");
  process.exit(1);
}

if (!TARGET_SCRIPT) {
  console.error("ERROR: TARGET_SCRIPT env var is required");
  process.exit(1);
}

let running = false;

async function runScript(reason: string) {
  try {
    console.log(`[trigger] Running ${TARGET_SCRIPT} (reason=${reason})`);
    const proc = Bun.spawn(["bash", TARGET_SCRIPT], {
      cwd: TARGET_SCRIPT.substring(0, TARGET_SCRIPT.lastIndexOf("/")) || ".",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    console.log(
      `[trigger] ${TARGET_SCRIPT} finished (exit=${proc.exitCode})`
    );
  } catch (e) {
    console.error(`[trigger] ${TARGET_SCRIPT} failed:`, e);
  } finally {
    running = false;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/trigger") {
      const auth = req.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${TRIGGER_SECRET}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      if (running) {
        return Response.json({ error: "already running" }, { status: 409 });
      }

      running = true;
      const reason = url.searchParams.get("reason") ?? "manual";

      // Fire and forget
      runScript(reason);

      return Response.json({ triggered: true, reason });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[trigger] Listening on port ${server.port}`);
console.log(`[trigger] TARGET_SCRIPT=${TARGET_SCRIPT}`);

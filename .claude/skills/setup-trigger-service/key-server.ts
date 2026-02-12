/**
 * Key Server — Automated API key provisioning via signed one-time links.
 *
 * Endpoints:
 *   POST   /request-batch        — Bot requests keys for missing providers (authed)
 *   GET    /key/:batchId         — Admin views batch form (signed URL)
 *   POST   /key/:batchId         — Admin submits keys (signed URL, rate-limited)
 *   DELETE /key/:provider        — Manual key invalidation (authed)
 *   GET    /status               — Bot checks provider status (authed)
 *   GET    /health               — Health check
 *
 * Env vars:
 *   KEY_SERVER_SECRET   — Bearer auth + HMAC signing (required)
 *   RESEND_API_KEY      — Resend outbound API key (required)
 *   KEY_REQUEST_EMAIL   — Admin email recipient (required)
 *   KEY_FROM_EMAIL      — Sender (default: noreply@openrouter.ai)
 *   KEY_SERVER_HOST     — Public URL for links in emails (required)
 *   KEY_SERVER_PORT     — Default: 8081
 *   REPO_ROOT           — Repository root for manifest.json (default: cwd)
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Config ---
const PORT = parseInt(process.env.KEY_SERVER_PORT ?? "8081", 10);
const SECRET = process.env.KEY_SERVER_SECRET ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const KEY_REQUEST_EMAIL = process.env.KEY_REQUEST_EMAIL ?? "";
const KEY_FROM_EMAIL = process.env.KEY_FROM_EMAIL ?? "noreply@openrouter.ai";
const KEY_SERVER_HOST = process.env.KEY_SERVER_HOST ?? "";
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();

if (!SECRET) {
  console.error("ERROR: KEY_SERVER_SECRET env var required");
  process.exit(1);
}
if (!RESEND_API_KEY) {
  console.error("ERROR: RESEND_API_KEY env var required");
  process.exit(1);
}
if (!KEY_REQUEST_EMAIL) {
  console.error("ERROR: KEY_REQUEST_EMAIL env var required");
  process.exit(1);
}
if (!KEY_SERVER_HOST) {
  console.error("ERROR: KEY_SERVER_HOST env var required");
  process.exit(1);
}

// --- Data paths ---
const CONFIG_DIR = join(homedir(), ".config", "spawn");
mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
const DATA_FILE = join(CONFIG_DIR, "key-requests.json");

// --- Types ---
interface EnvVarInfo {
  name: string;
}

interface ProviderRequest {
  provider: string;
  providerName: string;
  envVars: EnvVarInfo[];
  helpUrl: string;
  status: "pending" | "fulfilled";
}

interface KeyBatch {
  batchId: string;
  providers: ProviderRequest[];
  emailedAt: number;
  expiresAt: number;
}

interface DataStore {
  batches: KeyBatch[];
}

// --- Rate limiting (in-memory, auto-cleanup every 30 min) ---
const rateMaps = {
  ip: new Map<string, { count: number; resetAt: number }>(),
  batch: new Map<string, { count: number; resetAt: number }>(),
};

setInterval(() => {
  const now = Date.now();
  for (const m of Object.values(rateMaps))
    for (const [k, v] of m) if (v.resetAt < now) m.delete(k);
}, 30 * 60_000).unref?.();

function rateCheck(
  key: string,
  map: typeof rateMaps.ip,
  max: number,
  windowMs: number
): number | null {
  const now = Date.now();
  const e = map.get(key);
  if (!e || e.resetAt < now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (e.count >= max) return Math.ceil((e.resetAt - now) / 1000);
  e.count++;
  return null;
}

// --- Data persistence ---
function load(): DataStore {
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { batches: [] };
  }
}

function save(d: DataStore) {
  writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), { mode: 0o600 });
}

function cleanup(d: DataStore) {
  const now = Date.now();
  const week = 7 * 86400_000;
  d.batches = d.batches.filter((b) => {
    if (
      b.providers.every((p) => p.status === "fulfilled") &&
      now - b.emailedAt > week
    )
      return false;
    if (
      b.expiresAt < now &&
      b.providers.every((p) => p.status === "pending")
    )
      return false;
    return true;
  });
}

// --- HMAC signing ---
function signHmac(id: string, exp: number) {
  return createHmac("sha256", SECRET)
    .update(`${id}:${exp}`)
    .digest("hex");
}

function verifyHmac(id: string, sig: string, exp: string) {
  const e = parseInt(exp);
  if (isNaN(e) || e <= Date.now()) return false;
  const expected = signHmac(id, e);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// --- Auth ---
function isAuthed(req: Request) {
  const given = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${SECRET}`;
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// --- Provider name validation (prevents path traversal) ---
const SAFE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// --- Manifest parsing ---
function getClouds() {
  const m = JSON.parse(
    readFileSync(join(REPO_ROOT, "manifest.json"), "utf-8")
  );
  const result = new Map<
    string,
    { name: string; envVars: string[]; helpUrl: string }
  >();
  for (const [k, c] of Object.entries(
    m.clouds as Record<string, any>
  )) {
    const auth: string = c.auth ?? "";
    if (/\b(login|configure|setup)\b/i.test(auth)) continue;
    const vars = auth
      .split(/\s*\+\s*/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (vars.length)
      result.set(k, { name: c.name ?? k, envVars: vars, helpUrl: c.url ?? "" });
  }
  return result;
}

// --- Email via Resend ---
async function sendEmail(batch: KeyBatch, url: string): Promise<boolean> {
  const pending = batch.providers.filter((p) => p.status === "pending");
  const lines = pending
    .map(
      (p) =>
        `\u2022 ${p.providerName} \u2014 ${p.envVars.map((v) => v.name).join(", ")}\n  Get key from: ${p.helpUrl}`
    )
    .join("\n\n");
  const count = pending.length;
  const subject = `API Keys Needed: ${count} provider${count !== 1 ? "s" : ""}`;
  const text = `The Spawn QA bot needs API keys for the following cloud providers:\n\n${lines}\n\nSubmit your keys here (link expires in 24h):\n${url}\n\nFill in what you have, leave others blank. You can return to submit more keys later using the same link.`;
  const html = `<p>The Spawn QA bot needs API keys for:</p>${pending
    .map(
      (p) =>
        `<p><b>${esc(p.providerName)}</b> \u2014 ${p.envVars.map((v) => esc(v.name)).join(", ")}<br><a href="${esc(p.helpUrl)}">Get key</a></p>`
    )
    .join("")}<p><a href="${esc(url)}"><b>Submit API Keys</b></a> (expires 24h)</p><p>Fill in what you have, leave others blank.</p>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: KEY_FROM_EMAIL,
        to: [KEY_REQUEST_EMAIL],
        subject,
        text,
        html,
      }),
    });
    if (!r.ok) {
      console.error(
        `[key-server] Resend ${r.status}: ${await r.text()}`
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error("[key-server] Resend error:", e);
    return false;
  }
}

// --- HTML helpers ---
function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formPage(
  batch: KeyBatch,
  msg?: { text: string; error: boolean }
): string {
  const pending = batch.providers.filter((p) => p.status === "pending");
  const done = batch.providers.filter((p) => p.status === "fulfilled");
  const css = `*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;padding:2rem;margin:0}main{max-width:600px;width:100%}h1{text-align:center;margin-bottom:.5rem}.sub{text-align:center;color:#94a3b8;margin-top:0}.card{background:#1e293b;border-radius:8px;padding:1.25rem;margin:1rem 0}.card h3{margin:0 0 .25rem;color:#f8fafc}.card a{color:#38bdf8;font-size:.875rem}label{display:block;margin-top:.75rem;font-size:.875rem;color:#94a3b8}input{width:100%;padding:.5rem;margin-top:.25rem;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-family:monospace;font-size:.875rem}input:focus{outline:none;border-color:#38bdf8}button{display:block;width:100%;padding:.75rem;margin-top:1.5rem;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer}button:hover{background:#1d4ed8}.ok{text-align:center;color:#22c55e;font-size:.875rem}.msg{text-align:center;padding:1rem;border-radius:6px;margin:1rem 0}.msg.s{background:#14532d;color:#22c55e}.msg.e{background:#450a0a;color:#ef4444}`;

  if (pending.length === 0) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Keys Complete</title><style>${css}</style></head><body><main><h1 style="color:#22c55e">All Keys Submitted</h1><p class="sub">${done.length} provider key${done.length !== 1 ? "s" : ""} saved. The next QA cycle will pick them up.</p></main></body></html>`;
  }

  const cards = pending
    .map(
      (p) =>
        `<div class="card"><h3>${esc(p.providerName)}</h3><a href="${esc(p.helpUrl)}" target="_blank" rel="noopener">Get key</a>${p.envVars
          .map(
            (v) =>
              `<label>${esc(v.name)}<input type="text" name="${esc(p.provider)}__${esc(v.name)}" autocomplete="off" spellcheck="false"></label>`
          )
          .join("")}</div>`
    )
    .join("");

  const doneNote =
    done.length > 0
      ? `<p class="ok">${done.length} provider${done.length !== 1 ? "s" : ""} already submitted.</p>`
      : "";
  const msgHtml = msg
    ? `<div class="msg ${msg.error ? "e" : "s"}">${esc(msg.text)}</div>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spawn QA — API Keys</title><style>${css}</style></head><body><main><h1>Spawn QA — API Keys</h1><p class="sub">Fill in what you have. Leave others blank. You can return later.</p>${msgHtml}${doneNote}<form method="POST">${cards}<button type="submit">Submit Keys</button></form></main></body></html>`;
}

// --- Config file operations ---
function saveKeys(provider: string, vars: Record<string, string>) {
  // SECURITY: Defense-in-depth validation to prevent path traversal
  if (!SAFE_PROVIDER_RE.test(provider)) {
    console.error(`[key-server] Rejected invalid provider name in saveKeys: ${provider}`);
    return;
  }
  const cfgPath = join(CONFIG_DIR, `${provider}.json`);
  const data: Record<string, string> = { ...vars };
  // Backward compat: single-var clouds also get api_key/token fields
  if (Object.keys(vars).length === 1) {
    const v = Object.values(vars)[0];
    data.api_key = v;
    data.token = v;
  }
  writeFileSync(cfgPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`[key-server] Saved ${provider} config`);
}

function validKeyVal(v: string) {
  return !/[;&'"<>|$`\\(){}]/.test(v);
}

// --- Security headers for HTML responses ---
const HTML_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

// --- UUID regex ---
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- Server ---
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /health (read-only, no side effects)
    if (req.method === "GET" && path === "/health") {
      const d = load();
      cleanup(d);
      return Response.json({
        status: "ok",
        pending: d.batches.reduce(
          (n, b) => n + b.providers.filter((x) => x.status === "pending").length,
          0
        ),
        fulfilled: d.batches.reduce(
          (n, b) =>
            n + b.providers.filter((x) => x.status === "fulfilled").length,
          0
        ),
        batches: d.batches.length,
      });
    }

    // POST /request-batch (authed)
    if (req.method === "POST" && path === "/request-batch") {
      if (!isAuthed(req))
        return Response.json({ error: "unauthorized" }, { status: 401 });

      const body = await req.json().catch(() => null);
      if (!body?.providers?.length)
        return Response.json(
          { error: "providers array required" },
          { status: 400 }
        );

      const clouds = getClouds();
      const d = load();
      cleanup(d);

      const now = Date.now();
      const day = 86400_000;
      const requested: string[] = [];
      const skipped: string[] = [];

      for (const pk of body.providers as string[]) {
        // SECURITY: Validate provider names to prevent path traversal in saveKeys
        if (typeof pk !== "string" || !SAFE_PROVIDER_RE.test(pk)) {
          return Response.json(
            { error: `invalid provider name: ${pk}` },
            { status: 400 }
          );
        }
        if (
          d.batches.some(
            (b) =>
              now - b.emailedAt < day &&
              b.providers.some(
                (x) => x.provider === pk && x.status === "pending"
              )
          )
        ) {
          skipped.push(pk);
        } else {
          requested.push(pk);
        }
      }

      if (!requested.length)
        return Response.json({ batchId: null, requested: [], skipped });

      const batchId = randomUUID();
      const exp = now + day;
      const providers: ProviderRequest[] = requested.map((k) => {
        const info = clouds.get(k);
        return {
          provider: k,
          providerName: info?.name ?? k,
          envVars: (info?.envVars ?? []).map((n) => ({ name: n })),
          helpUrl: info?.helpUrl ?? "",
          status: "pending" as const,
        };
      });

      const batch: KeyBatch = {
        batchId,
        providers,
        emailedAt: now,
        expiresAt: exp,
      };
      const signedUrl = `${KEY_SERVER_HOST}/key/${batchId}?sig=${signHmac(batchId, exp)}&exp=${exp}`;

      // Send email FIRST — only persist batch if email succeeds
      if (!(await sendEmail(batch, signedUrl)))
        return Response.json({ error: "email send failed" }, { status: 502 });

      d.batches.push(batch);
      save(d);
      console.log(`[key-server] Batch ${batchId}: ${requested.join(", ")}`);
      return Response.json({ batchId, requested, skipped });
    }

    // Routes under /key/:id
    const keyMatch = path.match(/^\/key\/([^/]+)$/);
    if (keyMatch) {
      const id = keyMatch[1];

      // DELETE /key/:provider (authed, manual invalidation)
      if (req.method === "DELETE") {
        if (!isAuthed(req))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!SAFE_PROVIDER_RE.test(id))
          return Response.json({ error: "invalid provider name" }, { status: 400 });
        const cfg = join(CONFIG_DIR, `${id}.json`);
        if (existsSync(cfg)) {
          unlinkSync(cfg);
          console.log(`[key-server] Deleted ${id} config`);
          return Response.json({ status: "deleted", provider: id });
        }
        return Response.json(
          { status: "not_found", provider: id },
          { status: 404 }
        );
      }

      // GET/POST /key/:batchId (signed URL)
      if (!UUID_RE.test(id))
        return Response.json({ error: "not found" }, { status: 404 });

      const sig = url.searchParams.get("sig") ?? "";
      const exp = url.searchParams.get("exp") ?? "";
      if (!verifyHmac(id, sig, exp))
        return new Response("Invalid or expired link", { status: 403 });

      const d = load();
      const batch = d.batches.find((b) => b.batchId === id);
      if (!batch) return new Response("Batch not found", { status: 404 });

      // GET — render form (idempotent)
      if (req.method === "GET")
        return new Response(formPage(batch), {
          headers: HTML_HEADERS,
        });

      // POST — submit keys (rate-limited)
      if (req.method === "POST") {
        const ip =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        let retry = rateCheck(ip, rateMaps.ip, 10, 15 * 60_000);
        if (retry !== null)
          return new Response("Too many requests", {
            status: 429,
            headers: { "Retry-After": String(retry) },
          });
        retry = rateCheck(id, rateMaps.batch, 5, 3600_000);
        if (retry !== null)
          return new Response("Too many requests for this batch", {
            status: 429,
            headers: { "Retry-After": String(retry) },
          });

        const fd = await req.formData();
        let submitted = 0;
        for (const pr of batch.providers) {
          if (pr.status === "fulfilled") continue;
          const vals: Record<string, string> = {};
          let filled = 0;
          for (const v of pr.envVars) {
            const val = (
              (fd.get(`${pr.provider}__${v.name}`) as string) ?? ""
            ).trim();
            if (val) {
              if (!validKeyVal(val))
                return new Response(
                  formPage(batch, {
                    text: `Invalid characters in ${v.name}. Do not include shell metacharacters.`,
                    error: true,
                  }),
                  { headers: HTML_HEADERS }
                );
              vals[v.name] = val;
              filled++;
            }
          }
          // Only save and mark fulfilled when ALL vars for the provider are present
          if (filled === pr.envVars.length) {
            saveKeys(pr.provider, vals);
            pr.status = "fulfilled";
            submitted++;
          }
        }
        save(d);
        const text =
          submitted > 0
            ? `${submitted} provider key${submitted !== 1 ? "s" : ""} saved successfully.`
            : "No complete submissions. Please fill in all fields for at least one provider.";
        return new Response(
          formPage(batch, { text, error: submitted === 0 }),
          { headers: HTML_HEADERS }
        );
      }
    }

    // GET /status?provider=... (authed)
    if (req.method === "GET" && path === "/status") {
      if (!isAuthed(req))
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const provider = url.searchParams.get("provider");
      if (!provider)
        return Response.json(
          { error: "provider param required" },
          { status: 400 }
        );
      if (!SAFE_PROVIDER_RE.test(provider))
        return Response.json({ error: "invalid provider name" }, { status: 400 });
      return Response.json({
        provider,
        status: existsSync(join(CONFIG_DIR, `${provider}.json`))
          ? "fulfilled"
          : "pending",
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[key-server] Listening on port ${server.port}`);
console.log(`[key-server] Admin: ${KEY_REQUEST_EMAIL}, Host: ${KEY_SERVER_HOST}`);

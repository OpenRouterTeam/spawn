// cursor-proxy.ts — OpenRouter proxy for Cursor CLI
// Deploys a local translation proxy that intercepts Cursor's proprietary
// ConnectRPC/protobuf protocol and translates it to OpenRouter's OpenAI-compatible API.
//
// Architecture:
//   Cursor CLI → Caddy (HTTPS/H2, port 443) → split routing:
//     /agent.v1.AgentService/* → H2C Node.js (port 18645, BiDi streaming)
//     everything else          → HTTP/1.1 Node.js (port 18644, unary RPCs)
//
// /etc/hosts spoofs api2.cursor.sh → 127.0.0.1 so Cursor's hardcoded
// streaming endpoint routes to the local proxy.

import type { CloudRunner } from "./agent-setup.js";

import { wrapSshCall } from "./agent-setup.js";
import { asyncTryCatchIf, isOperationalError } from "./result.js";
import { logInfo, logStep, logWarn } from "./ui.js";

// ── Protobuf helpers (used in proxy scripts) ────────────────────────────────

// These are string-embedded in the proxy scripts that run on the VM.
// They implement minimal protobuf encoding for the specific message types
// Cursor CLI expects: AgentServerMessage, ModelDetails, etc.

const PROTO_HELPERS = `
function ev(v){const b=[];while(v>0x7f){b.push((v&0x7f)|0x80);v>>>=7;}b.push(v&0x7f);return Buffer.from(b);}
function es(f,s){const sb=Buffer.from(s);return Buffer.concat([ev((f<<3)|2),ev(sb.length),sb]);}
function em(f,p){return Buffer.concat([ev((f<<3)|2),ev(p.length),p]);}
function cf(p){const f=Buffer.alloc(5+p.length);f[0]=0;f.writeUInt32BE(p.length,1);p.copy(f,5);return f;}
function ct(){const j=Buffer.from("{}");const t=Buffer.alloc(5+j.length);t[0]=2;t.writeUInt32BE(j.length,1);j.copy(t,5);return t;}
function tdf(t){return cf(em(1,em(1,es(1,t))));}
function tef(){return cf(em(1,em(14,Buffer.from([8,10,16,5]))));}
function bmd(id,n){return Buffer.concat([es(1,id),es(3,id),es(4,n),es(5,n)]);}
function bmr(){return Buffer.concat([["anthropic/claude-sonnet-4-6","Claude Sonnet 4.6"],["anthropic/claude-haiku-4-5","Claude Haiku 4.5"],["openai/gpt-5.4","GPT-5.4"],["google/gemini-3.5-pro","Gemini 3.5 Pro"],["google/gemini-3.5-flash","Gemini 3.5 Flash"]].map(([i,n])=>em(1,bmd(i,n))));}
function bdr(){return em(1,bmd("anthropic/claude-sonnet-4-6","Claude Sonnet 4.6"));}
function xstr(buf,out){let o=0;while(o<buf.length){let t=0,s=0;while(o<buf.length){const b=buf[o++];t|=(b&0x7f)<<s;s+=7;if(!(b&0x80))break;}const wt=t&7;if(wt===0){while(o<buf.length&&buf[o++]&0x80);}else if(wt===2){let l=0,s=0;while(o<buf.length){const b=buf[o++];l|=(b&0x7f)<<s;s+=7;if(!(b&0x80))break;}const d=buf.slice(o,o+l);o+=l;const st=d.toString("utf8");if(/^[\\x20-\\x7e]+$/.test(st))out.push(st);else try{xstr(d,out);}catch(e){}}else break;}}
`.trim();

// ── Unary backend (HTTP/1.1, port 18644) ─────────────────────────────────────

function getUnaryScript(): string {
  return `import http from "node:http";
import { appendFileSync } from "node:fs";
const LOG="/var/log/cursor-proxy-unary.log";
function log(msg){try{appendFileSync(LOG,new Date().toISOString()+" "+msg+"\\n");}catch(e){}}

${PROTO_HELPERS}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", (e) => log("REQ ERR: " + e.message));
  req.on("end", () => {
    try {
      const buf = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      const url = req.url || "";
      log(req.method + " " + url + " [" + buf.length + "B]");

      // Auth — return fake JWT
      if (url === "/auth/exchange_user_api_key") {
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({
          accessToken: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzcGF3bl9wcm94eSJ9.ok",
          refreshToken: "spawn-proxy-refresh",
          authId: "user_spawn_proxy",
        }));
        return;
      }

      // Analytics — accept silently
      if (url.includes("Analytics") || url.includes("TrackEvents") || url.includes("SubmitLogs")) {
        res.writeHead(200, {"content-type":"application/json"});
        res.end('{"success":true}');
        return;
      }

      // Model list
      if (url.includes("GetUsableModels")) {
        res.writeHead(200, {"content-type":"application/proto"});
        res.end(bmr());
        return;
      }

      // Default model
      if (url.includes("GetDefaultModelForCli")) {
        res.writeHead(200, {"content-type":"application/proto"});
        res.end(bdr());
        return;
      }

      // OTEL traces
      if (url.includes("/v1/traces")) {
        res.writeHead(200, {"content-type":"application/json"});
        res.end("{}");
        return;
      }

      // Other proto endpoints — empty response
      if (ct.includes("proto")) {
        res.writeHead(200, {"content-type": ct.includes("connect") ? "application/connect+proto" : "application/proto"});
        res.end();
        return;
      }

      res.writeHead(200);
      res.end("ok");
    } catch(e) {
      log("ERR: " + e.message);
      try { res.writeHead(500); res.end(); } catch(e2) {}
    }
  });
});
server.on("error", (e) => log("SVR: " + e.message));
server.listen(18644, "127.0.0.1", () => log("Cursor proxy (unary) on 18644"));
`;
}

// ── BiDi backend (H2C, port 18645) ──────────────────────────────────────────

function getBidiScript(): string {
  return `import http2 from "node:http2";
import { appendFileSync } from "node:fs";
const LOG="/var/log/cursor-proxy-bidi.log";
function log(msg){try{appendFileSync(LOG,new Date().toISOString()+" "+msg+"\\n");}catch(e){}}

${PROTO_HELPERS}

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  const path = headers[":path"] || "";
  log("STREAM " + path);

  // BiDi: respond on first data frame, don't wait for stream end
  let gotData = false;
  stream.on("data", (chunk) => {
    if (gotData) return;
    gotData = true;
    log("  Data [" + chunk.length + "B]");

    // Extract user message from protobuf
    let msg = "hello";
    const strs = [];
    try { xstr(chunk.length > 5 ? chunk.slice(5) : chunk, strs); } catch(e) {}
    for (const s of strs) {
      if (s.length > 0 && s.length < 500 && !s.match(/^[a-f0-9]{8}-/)) { msg = s; break; }
    }
    log("  User: " + msg);

    stream.respond({":status": 200, "content-type": "application/connect+proto"});

    if (OPENROUTER_KEY) {
      callOpenRouter(msg, stream);
    } else {
      stream.write(tdf("Cursor proxy is working but OPENROUTER_API_KEY is not set. "));
      stream.write(tdf("Please configure the API key to connect to real models."));
      stream.write(tef());
      stream.end(ct());
    }
  });
  stream.on("error", (e) => {
    if (!e.message.includes("cancel")) log("  STREAM ERR: " + e.message);
  });
});

async function callOpenRouter(msg, stream) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENROUTER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [{ role: "user", content: msg }],
        stream: true,
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      stream.write(tdf("OpenRouter error " + r.status + ": " + errText.slice(0, 200)));
      stream.write(tef());
      stream.end(ct());
      return;
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content;
          if (content) stream.write(tdf(content));
        } catch(e) {}
      }
    }

    stream.write(tef());
    stream.end(ct());
    log("  OpenRouter stream complete");
  } catch(e) {
    log("  OpenRouter error: " + e.message);
    try {
      stream.write(tdf("Proxy error: " + e.message));
      stream.write(tef());
      stream.end(ct());
    } catch(e2) {}
  }
}

server.on("error", (e) => log("SVR: " + e.message));
server.listen(18645, "127.0.0.1", () => log("Cursor proxy (bidi) on 18645"));
`;
}

// ── Caddyfile ───────────────────────────────────────────────────────────────

function getCaddyfile(): string {
  return `{
\tlocal_certs
\tauto_https disable_redirects
}

https://api2.cursor.sh,
https://api2geo.cursor.sh,
https://api2direct.cursor.sh,
https://agentn.api5.cursor.sh,
https://agent.api5.cursor.sh {
\ttls internal

\thandle /agent.v1.AgentService/* {
\t\treverse_proxy h2c://127.0.0.1:18645 {
\t\t\tflush_interval -1
\t\t}
\t}

\thandle {
\t\treverse_proxy http://127.0.0.1:18644 {
\t\t\tflush_interval -1
\t\t}
\t}
}
`;
}

// ── Hosts entries ───────────────────────────────────────────────────────────

const CURSOR_DOMAINS = [
  "api2.cursor.sh",
  "api2geo.cursor.sh",
  "api2direct.cursor.sh",
  "agentn.api5.cursor.sh",
  "agent.api5.cursor.sh",
];

// ── Deployment ──────────────────────────────────────────────────────────────

/**
 * Deploy the Cursor proxy infrastructure onto the remote VM.
 * Installs Caddy, uploads proxy scripts, writes Caddyfile, configures /etc/hosts.
 */
export async function setupCursorProxy(runner: CloudRunner): Promise<void> {
  logStep("Deploying Cursor→OpenRouter proxy...");

  // 1. Install Caddy if not present
  const installCaddy = [
    'if command -v caddy >/dev/null 2>&1; then echo "caddy already installed"; exit 0; fi',
    'echo "Installing Caddy..."',
    'curl -sf "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy',
    "chmod +x /usr/local/bin/caddy",
    "caddy version",
  ].join("\n");

  const caddyResult = await asyncTryCatchIf(isOperationalError, () => wrapSshCall(runner.runServer(installCaddy, 60)));
  if (!caddyResult.ok) {
    logWarn("Caddy install failed — Cursor proxy will not work");
    return;
  }
  logInfo("Caddy available");

  // 2. Upload proxy scripts via base64
  const unaryB64 = Buffer.from(getUnaryScript()).toString("base64");
  const bidiB64 = Buffer.from(getBidiScript()).toString("base64");
  const caddyfileB64 = Buffer.from(getCaddyfile()).toString("base64");

  for (const b64 of [
    unaryB64,
    bidiB64,
    caddyfileB64,
  ]) {
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
      throw new Error("Unexpected characters in base64 output");
    }
  }

  const deployScript = [
    "mkdir -p ~/.cursor/proxy",
    `printf '%s' '${unaryB64}' | base64 -d > ~/.cursor/proxy/unary.mjs`,
    `printf '%s' '${bidiB64}' | base64 -d > ~/.cursor/proxy/bidi.mjs`,
    `printf '%s' '${caddyfileB64}' | base64 -d > ~/.cursor/proxy/Caddyfile`,
    "chmod 600 ~/.cursor/proxy/*.mjs",
    "chmod 644 ~/.cursor/proxy/Caddyfile",
  ].join(" && ");

  await wrapSshCall(runner.runServer(deployScript));
  logInfo("Proxy scripts deployed");

  // 3. Configure /etc/hosts for domain spoofing
  const hostsScript = [
    // Remove any existing cursor entries
    'sed -i "/cursor\\.sh/d" /etc/hosts 2>/dev/null || true',
    // Add our entries
    `echo "127.0.0.1 ${CURSOR_DOMAINS.join(" ")}" >> /etc/hosts`,
  ].join(" && ");

  await wrapSshCall(runner.runServer(hostsScript));
  logInfo("Hosts spoofing configured");

  // 4. Install Caddy's internal CA cert
  const trustScript = "caddy trust 2>/dev/null || true";
  await wrapSshCall(runner.runServer(trustScript, 30));
  logInfo("Caddy CA trusted");

  // 5. Write Cursor CLI config (permissions + PATH)
  const configScript = [
    "mkdir -p ~/.cursor/rules",
    `cat > ~/.cursor/cli-config.json << 'CONF'
{"version":1,"permissions":{"allow":["Shell(*)","Read(*)","Write(*)","WebFetch(*)","Mcp(*)"],"deny":[]}}
CONF`,
    "chmod 600 ~/.cursor/cli-config.json",
    'grep -q ".local/bin" ~/.bashrc 2>/dev/null || printf \'\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> ~/.bashrc',
    'grep -q ".local/bin" ~/.zshrc 2>/dev/null || printf \'\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> ~/.zshrc',
  ].join(" && ");
  await wrapSshCall(runner.runServer(configScript));
  logInfo("Cursor CLI configured");
}

/**
 * Start the Cursor proxy services (Caddy + two Node.js backends).
 * Uses systemd if available, falls back to setsid/nohup.
 */
export async function startCursorProxy(runner: CloudRunner): Promise<void> {
  logStep("Starting Cursor proxy services...");

  // Find Node.js binary (cursor bundles its own)
  const nodeFind =
    "NODE=$(find ~/.local/share/cursor-agent -name node -type f 2>/dev/null | head -1); " +
    '[ -z "$NODE" ] && NODE=$(command -v node); ' +
    'echo "Using node: $NODE"';

  // Port check (same pattern as startGateway)
  const portCheck = (port: number) =>
    `ss -tln 2>/dev/null | grep -q ":${port} " || nc -z 127.0.0.1 ${port} 2>/dev/null`;

  const script = [
    "source ~/.spawnrc 2>/dev/null",
    nodeFind,

    // Start unary backend
    `if ${portCheck(18644)}; then echo "Unary backend already running"; else`,
    "  if command -v systemctl >/dev/null 2>&1; then",
    '    _sudo=""; [ "$(id -u)" != "0" ] && _sudo="sudo"',
    "    cat > /tmp/cursor-proxy-unary.service << UNIT",
    "[Unit]",
    "Description=Cursor Proxy (unary)",
    "After=network.target",
    "[Service]",
    "Type=simple",
    "ExecStart=$NODE $HOME/.cursor/proxy/unary.mjs",
    "Restart=always",
    "RestartSec=3",
    "User=$(whoami)",
    "Environment=HOME=$HOME",
    "Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "    $_sudo mv /tmp/cursor-proxy-unary.service /etc/systemd/system/",
    "    $_sudo systemctl daemon-reload",
    "    $_sudo systemctl restart cursor-proxy-unary",
    "  else",
    "    setsid $NODE ~/.cursor/proxy/unary.mjs < /dev/null &",
    "  fi",
    "fi",

    // Start bidi backend
    `if ${portCheck(18645)}; then echo "BiDi backend already running"; else`,
    "  if command -v systemctl >/dev/null 2>&1; then",
    '    _sudo=""; [ "$(id -u)" != "0" ] && _sudo="sudo"',
    "    cat > /tmp/cursor-proxy-bidi.service << UNIT",
    "[Unit]",
    "Description=Cursor Proxy (bidi)",
    "After=network.target",
    "[Service]",
    "Type=simple",
    "ExecStart=$NODE $HOME/.cursor/proxy/bidi.mjs",
    "Restart=always",
    "RestartSec=3",
    "User=$(whoami)",
    "Environment=HOME=$HOME",
    'Environment=OPENROUTER_API_KEY=$(grep OPENROUTER_API_KEY ~/.spawnrc 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\'")',
    "Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "    $_sudo mv /tmp/cursor-proxy-bidi.service /etc/systemd/system/",
    "    $_sudo systemctl daemon-reload",
    "    $_sudo systemctl restart cursor-proxy-bidi",
    "  else",
    "    setsid $NODE ~/.cursor/proxy/bidi.mjs < /dev/null &",
    "  fi",
    "fi",

    // Start Caddy
    `if ${portCheck(443)}; then echo "Caddy already running"; else`,
    "  caddy start --config ~/.cursor/proxy/Caddyfile --adapter caddyfile 2>/dev/null || true",
    "fi",

    // Wait for all services
    "elapsed=0; while [ $elapsed -lt 30 ]; do",
    `  if ${portCheck(443)} && ${portCheck(18644)} && ${portCheck(18645)}; then`,
    '    echo "Cursor proxy ready after ${elapsed}s"',
    "    exit 0",
    "  fi",
    "  sleep 1; elapsed=$((elapsed + 1))",
    "done",
    'echo "Cursor proxy failed to start"; exit 1',
  ].join("\n");

  const result = await asyncTryCatchIf(isOperationalError, () => wrapSshCall(runner.runServer(script, 60)));
  if (result.ok) {
    logInfo("Cursor proxy started");
  } else {
    logWarn("Cursor proxy start failed — agent may not work");
  }
}

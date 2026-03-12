// shared/agent-setup.ts — Shared agent helpers + definitions for SSH-based clouds
// Cloud-agnostic: receives runServer/uploadFile via CloudRunner interface.

import type { AgentConfig } from "./agents";
import type { Result } from "./ui";

import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTmpDir } from "./paths";
import { asyncTryCatch, asyncTryCatchIf, isOperationalError, tryCatchIf } from "./result.js";
import { getErrorMessage } from "./type-guards";
import { Err, jsonEscape, logError, logInfo, logStep, logWarn, Ok, withRetry } from "./ui";

/**
 * Wrap an SSH-based async operation into a Result for use with withRetry.
 * - Transient SSH/connection errors → Err (retryable)
 * - Timeouts → throw (non-retryable: command may have already run)
 * - Everything else → throw (non-retryable: unknown failure)
 */
export async function wrapSshCall(op: Promise<void>): Promise<Result<void>> {
  const r = await asyncTryCatch(() => op);
  if (r.ok) {
    return Ok(undefined);
  }
  const msg = getErrorMessage(r.error);
  // Timeouts are NOT retryable — the command may have completed on the
  // remote but we lost the connection before seeing the exit code.
  if (msg.includes("timed out") || msg.includes("timeout")) {
    throw r.error;
  }
  // All other SSH errors (connection refused, reset, etc.) are retryable.
  return Err(new Error(msg));
}

// ─── CloudRunner interface ──────────────────────────────────────────────────

export interface CloudRunner {
  runServer(cmd: string, timeoutSecs?: number): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
}

// ─── Install helpers ────────────────────────────────────────────────────────

async function installAgent(
  runner: CloudRunner,
  agentName: string,
  installCmd: string,
  timeoutSecs?: number,
): Promise<void> {
  logStep(`Installing ${agentName}...`);
  const r = await asyncTryCatch(() =>
    withRetry(`${agentName} install`, () => wrapSshCall(runner.runServer(installCmd, timeoutSecs)), 2, 10),
  );
  if (!r.ok) {
    logError(`${agentName} installation failed`);
    throw new Error(`${agentName} install failed`);
  }
  logInfo(`${agentName} installation completed`);
}

/**
 * Upload a config file to the remote machine via a temp file and mv.
 */
async function uploadConfigFile(runner: CloudRunner, content: string, remotePath: string): Promise<void> {
  const tmpFile = join(getTmpDir(), `spawn_config_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpFile, content, {
    mode: 0o600,
  });

  const uploadResult = await asyncTryCatch(() =>
    withRetry(
      "config upload",
      () =>
        wrapSshCall(
          (async () => {
            const tempRemote = `/tmp/spawn_config_${Date.now()}`;
            await runner.uploadFile(tmpFile, tempRemote);
            await runner.runServer(
              `mkdir -p $(dirname "${remotePath}") && chmod 600 '${tempRemote}' && mv '${tempRemote}' "${remotePath}"`,
            );
          })(),
        ),
      2,
      5,
    ),
  );
  tryCatchIf(isOperationalError, () => unlinkSync(tmpFile));
  if (!uploadResult.ok) {
    throw uploadResult.error;
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

async function installClaudeCode(runner: CloudRunner): Promise<void> {
  logStep("Installing Claude Code...");

  const claudePath = "$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.n/bin";
  const pathSetup = `for rc in ~/.bashrc ~/.profile ~/.bash_profile ~/.zshrc; do grep -q '.claude/local/bin' "$rc" 2>/dev/null || printf '\\n# Claude Code PATH\\nexport PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"\\n' >> "$rc"; done`;
  const finalize = `claude install --force 2>/dev/null || true; ${pathSetup}`;

  const script = [
    `export PATH="${claudePath}:$PATH"`,
    `if [ -f ~/.bash_profile ] && grep -q 'spawn:env\\|Claude Code PATH\\|spawn:path' ~/.bash_profile 2>/dev/null; then rm -f ~/.bash_profile; fi`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `echo "==> Installing Claude Code (method 1/2: curl installer)..."`,
    "curl --proto '=https' -fsSL https://claude.ai/install.sh | bash || true",
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    "if ! command -v node >/dev/null 2>&1; then export N_PREFIX=$HOME/.n; curl --proto '=https' -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s install 22 || true; export PATH=$N_PREFIX/bin:$PATH; fi",
    `echo "==> Installing Claude Code (method 2/2: npm)..."`,
    "npm install -g @anthropic-ai/claude-code || true",
    `export PATH="${claudePath}:$PATH"`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    "exit 1",
  ].join("\n");

  const r = await asyncTryCatch(() => runner.runServer(script, 300));
  if (!r.ok) {
    logError("Claude Code installation failed");
    throw new Error("Claude Code install failed");
  }
  logInfo("Claude Code installed");
}

async function setupClaudeCodeConfig(runner: CloudRunner, apiKey: string): Promise<void> {
  logStep("Configuring Claude Code...");

  const escapedKey = jsonEscape(apiKey);
  const settingsJson = `{
  "theme": "dark",
  "editor": "vim",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": ${escapedKey}
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  }
}`;

  const settingsB64 = Buffer.from(settingsJson).toString("base64");

  // Build ~/.claude.json on the remote using $HOME so the workspace trust
  // entry uses the actual home directory path (e.g. /root, /home/user).
  // This pre-accepts the "Quick safety check" trust dialog for the home dir.
  const stateScript = [
    "mkdir -p ~/.claude",
    `printf '%s' '${settingsB64}' | base64 -d > ~/.claude/settings.json`,
    "chmod 600 ~/.claude/settings.json",
    'printf \'{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true,"projects":{"%s":{"hasTrustDialogAccepted":true}}}\\n\' "$HOME" > ~/.claude.json',
    "chmod 600 ~/.claude.json",
    "touch ~/.claude/CLAUDE.md",
  ].join(" && ");

  await runner.runServer(stateScript);
  logInfo("Claude Code configured");
}

// ─── GitHub Auth ─────────────────────────────────────────────────────────────

let githubAuthRequested = false;
let githubToken = "";
let hostGitName = "";
let hostGitEmail = "";

/** Read a git config value from the host machine, returning "" on failure. */
function readHostGitConfig(key: string): string {
  const result = tryCatchIf(isOperationalError, () => {
    const r = Bun.spawnSync(
      [
        "git",
        "config",
        "--global",
        key,
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
      },
    );
    if (r.exitCode === 0) {
      return new TextDecoder().decode(r.stdout).trim();
    }
    return "";
  });
  return result.ok ? result.data : "";
}

async function detectGithubAuth(): Promise<void> {
  if (process.env.GITHUB_TOKEN) {
    githubToken = process.env.GITHUB_TOKEN;
  } else {
    const ghResult = tryCatchIf(isOperationalError, () => {
      const r = Bun.spawnSync(
        [
          "gh",
          "auth",
          "token",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "ignore",
          ],
        },
      );
      if (r.exitCode === 0) {
        return new TextDecoder().decode(r.stdout).trim();
      }
      return "";
    });
    if (ghResult.ok && ghResult.data) {
      githubToken = ghResult.data;
    }
  }

  if (githubToken) {
    githubAuthRequested = true;
  }

  // Capture host git identity to propagate to the remote VM
  hostGitName = readHostGitConfig("user.name");
  hostGitEmail = readHostGitConfig("user.email");
}

export async function offerGithubAuth(runner: CloudRunner): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) {
    return;
  }
  if (!githubAuthRequested) {
    return;
  }

  let ghCmd = "curl --proto '=https' -fsSL https://openrouter.ai/labs/spawn/shared/github-auth.sh | bash";
  if (githubToken) {
    const escaped = githubToken.replace(/'/g, "'\\''");
    ghCmd = `export GITHUB_TOKEN='${escaped}' && ${ghCmd}`;
  }

  logStep("Installing and authenticating GitHub CLI on the remote server...");
  const ghSetup = await asyncTryCatchIf(isOperationalError, () => runner.runServer(ghCmd));
  if (!ghSetup.ok) {
    logWarn("GitHub CLI setup failed (non-fatal, continuing)");
  }

  // Propagate host git identity to the remote VM
  if (hostGitName || hostGitEmail) {
    logStep("Configuring git identity on the remote server...");
    const cmds: string[] = [];
    if (hostGitName) {
      const escaped = hostGitName.replace(/'/g, "'\\''");
      cmds.push(`git config --global user.name '${escaped}'`);
    }
    if (hostGitEmail) {
      const escaped = hostGitEmail.replace(/'/g, "'\\''");
      cmds.push(`git config --global user.email '${escaped}'`);
    }
    const gitSetup = await asyncTryCatchIf(isOperationalError, () => runner.runServer(cmds.join(" && ")));
    if (gitSetup.ok) {
      logInfo("Git identity configured on remote server");
    } else {
      logWarn("Git identity setup failed (non-fatal, continuing)");
    }
  }
}

// ─── Codex CLI Config ────────────────────────────────────────────────────────

async function setupCodexConfig(runner: CloudRunner, _apiKey: string): Promise<void> {
  logStep("Configuring Codex CLI for OpenRouter...");
  const config = `model = "openai/gpt-5-codex"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
`;
  await uploadConfigFile(runner, config, "$HOME/.codex/config.toml");
}

// ─── OpenClaw Config ─────────────────────────────────────────────────────────

async function installChromeBrowser(runner: CloudRunner): Promise<void> {
  // Install Google Chrome for OpenClaw's browser tool (recommended by OpenClaw docs).
  // Snap Chromium on Ubuntu 24.04 fails — AppArmor confinement blocks CDP control.
  // Google Chrome .deb bypasses snap entirely and lands at /usr/bin/google-chrome.
  logStep("Installing Google Chrome for browser tool...");
  const result = await asyncTryCatchIf(isOperationalError, () =>
    runner.runServer(
      "{ command -v google-chrome-stable >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1; } && { echo 'Chrome already installed'; exit 0; }; " +
        "curl --proto '=https' -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb && " +
        "sudo dpkg -i /tmp/google-chrome.deb; sudo apt-get install -f -y -qq; " +
        "rm -f /tmp/google-chrome.deb",
      120,
    ),
  );
  if (result.ok) {
    logInfo("Google Chrome installed");
  } else {
    logWarn("Google Chrome install failed (browser tool will be unavailable)");
  }
}

async function setupOpenclawConfig(
  runner: CloudRunner,
  apiKey: string,
  modelId: string,
  token?: string,
  enabledSteps?: Set<string>,
): Promise<void> {
  logStep("Configuring openclaw...");
  await runner.runServer("mkdir -p ~/.openclaw");

  // Chrome must be installed before config is written (config references its path).
  // This runs in configure() — not install() — so it works even with tarball installs.
  // Gate with enabledSteps — user can skip ~400 MB download via setup checkboxes.
  if (!enabledSteps || enabledSteps.has("browser")) {
    await installChromeBrowser(runner);
  }

  const gatewayToken = token ?? crypto.randomUUID().replace(/-/g, "");
  const escapedKey = jsonEscape(apiKey);
  const escapedToken = jsonEscape(gatewayToken);
  const escapedModel = jsonEscape(modelId);

  const config = `{
  "env": {
    "OPENROUTER_API_KEY": ${escapedKey}
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": ${escapedToken}
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": ${escapedModel}
      }
    }
  }
}`;
  await uploadConfigFile(runner, config, "$HOME/.openclaw/openclaw.json");

  // Configure browser via CLI (openclaw config set) — the supported way to set
  // browser options. Writing JSON directly may not be picked up by all versions.
  const browserResult = await asyncTryCatchIf(isOperationalError, () =>
    runner.runServer(
      "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
        "openclaw config set browser.executablePath /usr/bin/google-chrome-stable; " +
        "openclaw config set browser.noSandbox true; " +
        "openclaw config set browser.headless true; " +
        "openclaw config set browser.defaultProfile openclaw",
    ),
  );
  if (!browserResult.ok) {
    logWarn("Browser config setup failed (non-fatal)");
  }

  // Write USER.md bootstrap file — guides users to the web dashboard for
  // visual tasks like WhatsApp QR code scanning that don't work in the TUI.
  const userMd = [
    "# User",
    "",
    "## Web Dashboard",
    "",
    "This machine has a web dashboard running on port 18791.",
    "When helping the user set up channels that require QR code scanning",
    "(WhatsApp, Telegram, etc.), always guide them to use the web dashboard",
    "instead of the TUI — QR codes cannot be scanned from a terminal.",
    "",
    "The dashboard URL is: http://localhost:18791",
    "(It may also be SSH-tunneled to the user's local machine automatically.)",
    "",
  ].join("\n");
  await runner.runServer("mkdir -p ~/.openclaw/workspace");
  await uploadConfigFile(runner, userMd, "$HOME/.openclaw/workspace/USER.md");
}

export async function startGateway(runner: CloudRunner): Promise<void> {
  logStep("Starting OpenClaw gateway daemon...");

  // On Linux with systemd: install a supervised service (Restart=always) +
  // hourly cron heartbeat as a belt-and-suspenders backup.
  // On macOS/other: fall back to setsid/nohup (unsupervised).
  // Base64-encode files to avoid heredoc/quoting issues across cloud SSH.

  // Port check: ss is available on all modern Linux; /dev/tcp works on macOS/some bash.
  // Debian/Ubuntu bash is compiled WITHOUT /dev/tcp support, so we must not rely on it alone.
  const portCheck =
    'ss -tln 2>/dev/null | grep -q ":18789 " || ' +
    "(echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || " +
    "nc -z 127.0.0.1 18789 2>/dev/null";

  const wrapperScript = [
    "#!/bin/bash",
    'source "$HOME/.spawnrc" 2>/dev/null',
    'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
    "exec openclaw gateway",
  ].join("\n");

  // __USER__ and __HOME__ are sed-substituted at deploy time
  const unitFile = [
    "[Unit]",
    "Description=OpenClaw Gateway",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=/usr/local/bin/openclaw-gateway-wrapper",
    "Restart=always",
    "RestartSec=5",
    "User=__USER__",
    "Environment=HOME=__HOME__",
    "StandardOutput=append:/tmp/openclaw-gateway.log",
    "StandardError=append:/tmp/openclaw-gateway.log",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");

  const wrapperB64 = Buffer.from(wrapperScript).toString("base64");
  const unitB64 = Buffer.from(unitFile).toString("base64");

  const script = [
    "source ~/.spawnrc 2>/dev/null",
    "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH",
    "if command -v systemctl >/dev/null 2>&1; then",
    '  _sudo=""',
    '  [ "$(id -u)" != "0" ] && _sudo="sudo"',
    "  printf '%s' '" + wrapperB64 + "' | base64 -d | $_sudo tee /usr/local/bin/openclaw-gateway-wrapper > /dev/null",
    "  $_sudo chmod +x /usr/local/bin/openclaw-gateway-wrapper",
    "  printf '%s' '" + unitB64 + "' | base64 -d > /tmp/openclaw-gateway.unit.tmp",
    '  sed -i "s|__USER__|$(whoami)|;s|__HOME__|$HOME|" /tmp/openclaw-gateway.unit.tmp',
    "  $_sudo mv /tmp/openclaw-gateway.unit.tmp /etc/systemd/system/openclaw-gateway.service",
    "  $_sudo systemctl daemon-reload",
    "  $_sudo systemctl enable openclaw-gateway 2>/dev/null",
    "  $_sudo systemctl restart openclaw-gateway",
    '  _cron_restart="systemctl restart openclaw-gateway"',
    '  [ "$(id -u)" != "0" ] && _cron_restart="sudo systemctl restart openclaw-gateway"',
    '  (crontab -l 2>/dev/null | grep -v openclaw-gateway; echo "0 * * * * nc -z 127.0.0.1 18789 2>/dev/null || $_cron_restart >> /tmp/openclaw-gateway.log 2>&1") | crontab - 2>/dev/null || true',
    "else",
    '  _oc_bin=$(command -v openclaw) || { echo "openclaw not found in PATH"; exit 1; }',
    `  if ${portCheck}; then echo "Gateway already running"; exit 0; fi`,
    '  if command -v setsid >/dev/null 2>&1; then setsid "$_oc_bin" gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null &',
    '  else nohup "$_oc_bin" gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & fi',
    "fi",
    "elapsed=0; while [ $elapsed -lt 300 ]; do",
    `  if ${portCheck}; then echo "Gateway ready after \${elapsed}s"; exit 0; fi`,
    "  printf '.'; sleep 1; elapsed=$((elapsed + 1))",
    "done",
    'echo "Gateway failed to start after 300s"; tail -20 /tmp/openclaw-gateway.log 2>/dev/null; exit 1',
  ].join("\n");
  await runner.runServer(script);
  logInfo("OpenClaw gateway started");
}

// ─── ZeroClaw Config ─────────────────────────────────────────────────────────

async function setupZeroclawConfig(runner: CloudRunner, _apiKey: string): Promise<void> {
  logStep("Configuring ZeroClaw for autonomous operation...");

  // Remove any pre-existing config (e.g. from Docker image extraction) before
  // running onboard, which generates a fresh config with the correct API key.
  await runner.runServer("rm -f ~/.zeroclaw/config.toml");

  // Run onboard first to set up provider/key
  await runner.runServer(
    `source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.cargo/bin:$PATH"; zeroclaw onboard --api-key "\${OPENROUTER_API_KEY}" --provider openrouter`,
  );

  // Patch autonomy settings in-place. `zeroclaw onboard` already generates
  // [security] and [shell] sections — so we sed the values instead of
  // appending duplicate sections.
  const patchScript = [
    "cd ~/.zeroclaw",
    // Update existing security values (or append section if missing)
    'if grep -q "^\\[security\\]" config.toml 2>/dev/null; then',
    "  sed -i 's/^autonomy = .*/autonomy = \"full\"/' config.toml",
    "  sed -i 's/^supervised = .*/supervised = false/' config.toml",
    "  sed -i 's/^allow_destructive = .*/allow_destructive = true/' config.toml",
    "else",
    "  printf '\\n[security]\\nautonomy = \"full\"\\nsupervised = false\\nallow_destructive = true\\n' >> config.toml",
    "fi",
    // Update existing shell policy (or append section if missing)
    'if grep -q "^\\[shell\\]" config.toml 2>/dev/null; then',
    "  sed -i 's/^policy = .*/policy = \"allow_all\"/' config.toml",
    "else",
    "  printf '\\n[shell]\\npolicy = \"allow_all\"\\n' >> config.toml",
    "fi",
  ].join("\n");
  await runner.runServer(patchScript);
  logInfo("ZeroClaw configured for autonomous operation");
}

// ─── Swap Space Setup ─────────────────────────────────────────────────────────

/**
 * Ensure swap space exists on the remote machine.
 * Used before memory-intensive builds (e.g., Rust compilation) on
 * resource-constrained instances (512 MB RAM). Idempotent — skips if
 * swap is already configured. Non-fatal if sudo is unavailable.
 */
async function ensureSwapSpace(runner: CloudRunner, sizeMb = 1024): Promise<void> {
  if (typeof sizeMb !== "number" || sizeMb <= 0 || !Number.isInteger(sizeMb)) {
    throw new Error(`Invalid swap size: ${sizeMb}`);
  }
  logStep(`Ensuring ${sizeMb} MB swap space for compilation...`);
  const script = [
    "if swapon --show 2>/dev/null | grep -q /swapfile; then",
    "  echo '==> Swap already configured, skipping'",
    "else",
    `  echo '==> Creating ${sizeMb} MB swap file...'`,
    `  sudo fallocate -l ${sizeMb}M /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=${sizeMb} status=none`,
    "  sudo chmod 600 /swapfile",
    "  sudo mkswap /swapfile >/dev/null",
    "  sudo swapon /swapfile",
    "  echo '==> Swap enabled'",
    "fi",
  ].join("\n");
  const result = await asyncTryCatchIf(isOperationalError, () => runner.runServer(script));
  if (result.ok) {
    logInfo("Swap space ready");
  } else {
    logWarn("Swap setup failed (non-fatal) — build may still succeed on larger instances");
  }
}

// ─── OpenCode Install Command ────────────────────────────────────────────────

function openCodeInstallCmd(): string {
  return 'OC_ARCH=$(uname -m); case "$OC_ARCH" in aarch64) OC_ARCH=arm64;; x86_64) OC_ARCH=x64;; esac; OC_OS=$(uname -s | tr A-Z a-z); mkdir -p /tmp/opencode-install "$HOME/.opencode/bin" && curl --proto \'=https\' -fsSL -o /tmp/opencode-install/oc.tar.gz "https://github.com/sst/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz" && if tar -tzf /tmp/opencode-install/oc.tar.gz | grep -qE \'(^/|\\.\\.)\'; then echo "Tarball contains unsafe paths" >&2; exit 1; fi && tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install && mv /tmp/opencode-install/opencode "$HOME/.opencode/bin/" && rm -rf /tmp/opencode-install && for _rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile"; do grep -q ".opencode/bin" "$_rc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$_rc"; done; { [ ! -f "$HOME/.zshrc" ] || grep -q ".opencode/bin" "$HOME/.zshrc" 2>/dev/null || echo \'export PATH="$HOME/.opencode/bin:$PATH"\' >> "$HOME/.zshrc"; }; export PATH="$HOME/.opencode/bin:$PATH"';
}

// ─── npm prefix helper ────────────────────────────────────────────────────────

/**
 * Shell snippet that detects whether npm's global bin is in PATH.
 * Sets _NPM_G_FLAGS to "--prefix ~/.npm-global" when npm's global bin dir
 * is NOT reachable from PATH (e.g. Sprite VMs where node is under
 * /.sprite/languages/node/nvm/... but that bin dir isn't in PATH).
 *
 * IMPORTANT: We use --prefix per-command instead of `npm config set prefix`
 * because writing .npmrc with a prefix conflicts with nvm (even when nvm
 * isn't loaded, npm from an nvm install detects .npmrc prefix and errors).
 */
const NPM_PREFIX_SETUP =
  '_NPM_G_FLAGS=""; ' +
  '_npm_gbin="$(npm prefix -g 2>/dev/null || echo /usr/local)/bin"; ' +
  'if ! [ -w "$(npm prefix -g 2>/dev/null || echo /usr/local)" ] || ' +
  '! printf "%s" ":${PATH}:" | grep -qF ":${_npm_gbin}:"; then ' +
  'mkdir -p ~/.npm-global/bin; _NPM_G_FLAGS="--prefix $HOME/.npm-global"; fi; ' +
  'export PATH="$HOME/.npm-global/bin:$PATH"';

/**
 * Shell snippet that persists ~/.npm-global/bin in PATH across all shell config
 * files: ~/.bashrc, ~/.profile, ~/.bash_profile, and ~/.zshrc.
 * Login shells (SSH reconnect) source ~/.profile or ~/.bash_profile, not ~/.bashrc,
 * so writing to ~/.bashrc alone is insufficient.
 */
const NPM_GLOBAL_PATH_PERSIST =
  "for _rc in ~/.bashrc ~/.profile ~/.bash_profile; do " +
  "grep -qF '.npm-global/bin' \"$_rc\" 2>/dev/null || " +
  'echo \'export PATH="$HOME/.npm-global/bin:$PATH"\' >> "$_rc"; done; ' +
  "{ [ ! -f ~/.zshrc ] || grep -qF '.npm-global/bin' ~/.zshrc 2>/dev/null || " +
  "echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.zshrc; }";

// ─── Default Agent Definitions ───────────────────────────────────────────────

const ZEROCLAW_INSTALL_URL =
  "https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/bootstrap.sh";

function createAgents(runner: CloudRunner): Record<string, AgentConfig> {
  return {
    claude: {
      name: "Claude Code",
      cloudInitTier: "minimal",
      preProvision: detectGithubAuth,
      install: () => installClaudeCode(runner),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
        `ANTHROPIC_AUTH_TOKEN=${apiKey}`,
        "ANTHROPIC_API_KEY=",
        "CLAUDE_CODE_SKIP_ONBOARDING=1",
        "CLAUDE_CODE_ENABLE_TELEMETRY=0",
      ],
      configure: (apiKey) => setupClaudeCodeConfig(runner, apiKey),
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude",
    },

    codex: {
      name: "Codex CLI",
      cloudInitTier: "node",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Codex CLI",
          `${NPM_PREFIX_SETUP} && npm install -g \${_NPM_G_FLAGS} @openai/codex && ${NPM_GLOBAL_PATH_PERSIST}`,
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
      ],
      configure: (apiKey) => setupCodexConfig(runner, apiKey),
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex",
    },

    openclaw: (() => {
      const dashboardToken = crypto.randomUUID().replace(/-/g, "");
      return {
        name: "OpenClaw",
        cloudInitTier: "full" satisfies AgentConfig["cloudInitTier"],
        preProvision: detectGithubAuth,
        modelDefault: "openrouter/openrouter/auto",
        install: async () => {
          await installAgent(
            runner,
            "openclaw",
            `source ~/.bashrc 2>/dev/null; ${NPM_PREFIX_SETUP} && npm install -g \${_NPM_G_FLAGS} openclaw && ${NPM_GLOBAL_PATH_PERSIST}`,
          );
        },
        envVars: (apiKey: string) => [
          `OPENROUTER_API_KEY=${apiKey}`,
          `ANTHROPIC_API_KEY=${apiKey}`,
          "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
        ],
        configure: (apiKey: string, modelId?: string, enabledSteps?: Set<string>) =>
          setupOpenclawConfig(runner, apiKey, modelId || "openrouter/openrouter/auto", dashboardToken, enabledSteps),
        preLaunch: () => startGateway(runner),
        preLaunchMsg: "Your web dashboard will open automatically. If it doesn't, check the terminal for the URL.",
        launchCmd: () =>
          "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; openclaw tui",
        tunnel: {
          remotePort: 18791,
          browserUrl: (localPort: number) => `http://localhost:${localPort}/?token=${dashboardToken}`,
        },
      };
    })(),

    opencode: {
      name: "OpenCode",
      cloudInitTier: "minimal",
      preProvision: detectGithubAuth,
      install: () => installAgent(runner, "OpenCode", openCodeInstallCmd()),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; opencode",
    },

    kilocode: {
      name: "Kilo Code",
      cloudInitTier: "node",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Kilo Code",
          `${NPM_PREFIX_SETUP} && npm install -g \${_NPM_G_FLAGS} @kilocode/cli && ${NPM_GLOBAL_PATH_PERSIST}`,
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "KILO_PROVIDER_TYPE=openrouter",
        `KILO_OPEN_ROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode",
    },

    zeroclaw: {
      name: "ZeroClaw",
      cloudInitTier: "minimal",
      preProvision: detectGithubAuth,
      install: async () => {
        // Add swap before building — low-memory instances (e.g., AWS nano 512 MB)
        // OOM during Rust compilation if --prefer-prebuilt falls back to source.
        await ensureSwapSpace(runner);
        await installAgent(
          runner,
          "ZeroClaw",
          `curl --proto '=https' -LsSf ${ZEROCLAW_INSTALL_URL} | bash -s -- --install-rust --install-system-deps --prefer-prebuilt`,
          600, // 10 min: swap-backed compilation is slower than the 5-min default
        );
      },
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "ZEROCLAW_PROVIDER=openrouter",
      ],
      configure: (apiKey) => setupZeroclawConfig(runner, apiKey),
      launchCmd: () =>
        "export PATH=$HOME/.cargo/bin:$PATH; source ~/.cargo/env 2>/dev/null; source ~/.spawnrc 2>/dev/null; zeroclaw agent",
    },

    hermes: {
      name: "Hermes Agent",
      cloudInitTier: "minimal",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Hermes Agent",
          "curl --proto '=https' -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
          300,
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "OPENAI_BASE_URL=https://openrouter.ai/api/v1",
        `OPENAI_API_KEY=${apiKey}`,
      ],
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.local/bin:$HOME/.hermes/hermes-agent/venv/bin:$PATH; hermes",
    },

    junie: {
      name: "Junie",
      cloudInitTier: "node",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Junie",
          `${NPM_PREFIX_SETUP} && npm install -g \${_NPM_G_FLAGS} @jetbrains/junie-cli && ${NPM_GLOBAL_PATH_PERSIST}`,
        ),
      envVars: (apiKey) => [
        `JUNIE_OPENROUTER_API_KEY=${apiKey}`,
        `OPENROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; junie",
    },
  };
}

function resolveAgent(agents: Record<string, AgentConfig>, name: string): AgentConfig {
  const agent = agents[name.toLowerCase()];
  if (!agent) {
    logError(`Unknown agent: ${name}`);
    logError(`Available agents: ${Object.keys(agents).join(", ")}`);
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}

/**
 * Factory that creates agents + resolveAgent for a given CloudRunner.
 * Replaces the identical 16-line boilerplate in each cloud's agents.ts.
 */
export function createCloudAgents(runner: CloudRunner): {
  agents: Record<string, AgentConfig>;
  resolveAgent: (name: string) => AgentConfig;
} {
  const agentMap = createAgents(runner);
  return {
    agents: agentMap,
    resolveAgent: (name: string) => resolveAgent(agentMap, name),
  };
}

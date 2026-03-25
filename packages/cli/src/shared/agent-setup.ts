// shared/agent-setup.ts — Shared agent helpers + definitions for SSH-based clouds
// Cloud-agnostic: receives runServer/uploadFile via CloudRunner interface.

import type { AgentConfig } from "./agents.js";
import type { Result } from "./ui.js";

import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getErrorMessage } from "@openrouter/spawn-shared";
import { getTmpDir } from "./paths.js";
import { asyncTryCatch, asyncTryCatchIf, isOperationalError, tryCatchIf } from "./result.js";
import { validateRemotePath } from "./ssh.js";
import { Err, jsonEscape, logError, logInfo, logStep, logWarn, Ok, prompt, shellQuote, withRetry } from "./ui.js";

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
  downloadFile(remotePath: string, localPath: string): Promise<void>;
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
    withRetry(`${agentName} install`, () => wrapSshCall(runner.runServer(installCmd, timeoutSecs)), 4, 10, true),
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
  const safePath = validateRemotePath(remotePath);

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
              `mkdir -p $(dirname "${safePath}") && chmod 600 ${shellQuote(tempRemote)} && mv ${shellQuote(tempRemote)} "${safePath}"`,
            );
          })(),
        ),
      4,
      5,
      true,
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
  const finalize = `claude install --force >/dev/null 2>&1 || true; ${pathSetup}`;

  const script = [
    `export PATH="${claudePath}:$PATH"`,
    `if [ -f ~/.bash_profile ] && grep -q 'spawn:env\\|Claude Code PATH\\|spawn:path' ~/.bash_profile 2>/dev/null; then rm -f ~/.bash_profile; fi`,
    `if command -v claude >/dev/null 2>&1; then ${finalize}; exit 0; fi`,
    `echo "==> Installing Claude Code (method 1/2: curl installer)..."`,
    "curl --proto '=https' -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || true",
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
  logInfo("Claude Code agent installed successfully");
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

  // Safety: base64 output only contains [A-Za-z0-9+/=] — never single quotes —
  // so interpolating into a single-quoted shell string is safe.
  const settingsB64 = Buffer.from(settingsJson).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(settingsB64)) {
    throw new Error("Unexpected characters in base64 output");
  }

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

export async function offerGithubAuth(runner: CloudRunner, explicitlyRequested?: boolean): Promise<void> {
  if (process.env.SPAWN_SKIP_GITHUB_AUTH) {
    return;
  }
  if (!githubAuthRequested && !explicitlyRequested) {
    return;
  }

  let ghCmd = "curl --proto '=https' -fsSL https://openrouter.ai/labs/spawn/shared/github-auth.sh | bash";
  if (githubToken) {
    const tokenB64 = Buffer.from(githubToken).toString("base64");
    ghCmd = `export GITHUB_TOKEN=$(printf '%s' ${shellQuote(tokenB64)} | base64 -d) && ${ghCmd}`;
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
      cmds.push(`git config --global user.name ${shellQuote(hostGitName)}`);
    }
    if (hostGitEmail) {
      cmds.push(`git config --global user.email ${shellQuote(hostGitEmail)}`);
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

async function setupCodexConfig(runner: CloudRunner): Promise<void> {
  logStep("Configuring Codex CLI for OpenRouter...");
  const config = `model = "openai/gpt-5.3-codex"
model_provider = "openrouter"
sandbox_mode = "danger-full-access"

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

  // Prompt for Telegram bot token before building the config JSON so we can
  // include it in a single atomic write.
  let telegramBotToken = "";
  if (enabledSteps?.has("telegram")) {
    logStep("Setting up Telegram...");
    const envToken = process.env.TELEGRAM_BOT_TOKEN ?? process.env.SPAWN_TELEGRAM_BOT_TOKEN ?? "";
    if (!envToken) {
      logInfo("To get a bot token:");
      logInfo("  1. Open Telegram and search for @BotFather");
      logInfo("  2. Send /newbot and follow the prompts");
      logInfo("  3. Copy the token (looks like 123456:ABC-DEF...)");
      logInfo("  Press Enter to skip if you don't have one yet.");
    }
    telegramBotToken = (envToken || (await prompt("Telegram bot token: "))).trim();
    if (!telegramBotToken) {
      logInfo("No token entered — set up Telegram via the web dashboard after launch");
    }
  }

  const gatewayToken = token ?? crypto.randomUUID().replace(/-/g, "");

  // Run `openclaw onboard --non-interactive` to create a properly structured
  // config with auth profiles, provider setup, gateway config, and workspace.
  // This replaces our previous manual JSON construction + deep-merge approach
  // that bypassed OpenClaw's credential/auth profile system.
  const onboardCmd =
    "source ~/.spawnrc 2>/dev/null; " +
    "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
    "openclaw onboard --non-interactive" +
    ` --openrouter-api-key ${shellQuote(apiKey)}` +
    " --gateway-auth token" +
    ` --gateway-token ${shellQuote(gatewayToken)}` +
    " --skip-health" +
    " --accept-risk";
  const onboardResult = await asyncTryCatchIf(isOperationalError, () => runner.runServer(onboardCmd, 120));
  if (!onboardResult.ok) {
    logWarn("openclaw onboard failed — falling back to manual config");
    // Minimal fallback: upload a basic config so the agent can still start
    const fallbackConfig = JSON.stringify(
      {
        env: {
          OPENROUTER_API_KEY: apiKey,
        },
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: gatewayToken,
          },
        },
        agents: {
          defaults: {
            model: {
              primary: modelId,
            },
            sandbox: {
              mode: "off",
            },
          },
        },
      },
      null,
      2,
    );
    await uploadConfigFile(runner, fallbackConfig, "$HOME/.openclaw/openclaw.json");
  }

  // Set custom model if user selected one different from the onboard default
  if (modelId !== "openrouter/auto") {
    const modelResult = await asyncTryCatchIf(isOperationalError, () =>
      runner.runServer(
        "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
          `openclaw config set agents.defaults.model.primary ${shellQuote(modelId)} >/dev/null`,
      ),
    );
    if (!modelResult.ok) {
      logWarn("Custom model config failed (non-fatal)");
    }
  }

  // Disable Docker sandboxing — when Docker is installed on the VM, openclaw
  // auto-detects it and runs agents inside containers, which hangs the session.
  await asyncTryCatchIf(isOperationalError, () =>
    runner.runServer(
      "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
        "openclaw config set agents.defaults.sandbox.mode off >/dev/null",
    ),
  );

  // Configure browser via CLI (openclaw config set) — the supported way to set
  // browser options. Redirect stdout to suppress doctor warnings on each call.
  const browserResult = await asyncTryCatchIf(isOperationalError, () =>
    runner.runServer(
      "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
        "openclaw config set browser.executablePath /usr/bin/google-chrome-stable >/dev/null; " +
        "openclaw config set browser.noSandbox true >/dev/null; " +
        "openclaw config set browser.headless true >/dev/null; " +
        "openclaw config set browser.defaultProfile openclaw >/dev/null",
    ),
  );
  if (!browserResult.ok) {
    logWarn("Browser config setup failed (non-fatal)");
  }

  // Write channel stubs so the dashboard renders channel cards properly,
  // even when the user hasn't configured them yet. Without stubs the
  // dashboard shows "Unsupported type: . Use Raw mode."
  const channelNames = [
    "telegram",
    "whatsapp",
    "discord",
    "slack",
    "signal",
    "googlechat",
    "bluebubbles",
  ].filter((ch) => !enabledSteps || enabledSteps.has(ch));
  if (channelNames.length > 0) {
    const stubCmds = channelNames.map((ch) => `openclaw config set channels.${ch}.enabled true >/dev/null`).join("; ");
    await asyncTryCatchIf(isOperationalError, () =>
      runner.runServer("export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " + stubCmds),
    );
  }

  // Configure Telegram channel if a bot token was provided
  if (telegramBotToken) {
    const telegramResult = await asyncTryCatchIf(isOperationalError, () =>
      runner.runServer(
        "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
          "openclaw config set channels.telegram.enabled true >/dev/null; " +
          `openclaw config set channels.telegram.botToken ${shellQuote(telegramBotToken)} >/dev/null; ` +
          "openclaw config set channels.telegram.dmPolicy pairing >/dev/null; " +
          "openclaw config set channels.telegram.groupPolicy open >/dev/null",
      ),
    );
    if (telegramResult.ok) {
      logInfo("Telegram bot token configured");
    } else {
      logWarn("Telegram config failed (non-fatal)");
    }
  }

  // Write USER.md bootstrap file
  const messagingLines: string[] = [];
  if (enabledSteps?.has("telegram")) {
    messagingLines.push(
      "",
      "## Messaging Channels",
      "",
      "- **Telegram**: If a bot token was provided, it is already configured.",
      "  To verify: `openclaw config get channels.telegram.botToken`",
      "",
    );
  }

  const userMd = [
    "# User",
    "",
    "## Web Dashboard",
    "",
    "This machine has a web dashboard running on port 18789.",
    "When helping the user set up channels that require QR code scanning",
    "(WhatsApp, Telegram, etc.), always guide them to use the web dashboard",
    "instead of the TUI — QR codes cannot be scanned from a terminal.",
    "",
    "The dashboard URL is: http://localhost:18789",
    "(It may also be SSH-tunneled to the user's local machine automatically.)",
    ...messagingLines,
    "",
  ].join("\n");
  // Workspace dir is created by `openclaw onboard`; ensure it exists for the fallback path.
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
  if (!/^[A-Za-z0-9+/=]+$/.test(wrapperB64)) {
    throw new Error("Unexpected characters in base64 output");
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(unitB64)) {
    throw new Error("Unexpected characters in base64 output");
  }

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
    `source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"; zeroclaw onboard --api-key "\${OPENROUTER_API_KEY}" --provider openrouter`,
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
    // Force native runtime (no Docker) — zeroclaw auto-detects Docker and
    // launches in a container otherwise, which hangs the interactive session.
    'if grep -q "^\\[runtime\\]" config.toml 2>/dev/null; then',
    "  sed -i 's/^adapter = .*/adapter = \"native\"/' config.toml",
    "else",
    "  printf '\\n[runtime]\\nadapter = \"native\"\\n' >> config.toml",
    "fi",
  ].join("\n");
  await runner.runServer(patchScript);
  logInfo("ZeroClaw configured for autonomous operation");
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
  'export PATH="$HOME/.npm-global/bin:$PATH"; ' +
  // Force IPv4 DNS resolution to avoid IPv6 connectivity failures on some clouds
  // (e.g. Sprite VMs with flaky IPv6 routing to the npm registry)
  'export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"';

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

/**
 * Shell snippet that verifies the kilocode binary is actually available after
 * npm install. @kilocode/cli v7+ uses a postinstall script that downloads a
 * native binary. On some clouds (notably GCP with cloudInitTier "node"), the
 * postinstall can fail silently, leaving the bin symlink pointing to a JS
 * wrapper but no actual native binary to exec.
 *
 * This snippet:
 * 1. Checks if `kilocode` is already working
 * 2. If not, finds the npm package dir and re-runs the postinstall
 * 3. If still not found, searches for the native binary in the package dir
 *    and symlinks it into a PATH-accessible location
 */
const KILOCODE_BINARY_VERIFY =
  "{ " +
  'export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ' +
  // Quick check: if kilocode already works, nothing to do
  "if command -v kilocode >/dev/null 2>&1 && kilocode --version >/dev/null 2>&1; then exit 0; fi; " +
  // Find the npm package directory (works with both --prefix and default installs)
  '_kc_pkg="$(npm prefix -g 2>/dev/null)/lib/node_modules/@kilocode/cli"; ' +
  '[ -d "$_kc_pkg" ] || _kc_pkg="$HOME/.npm-global/lib/node_modules/@kilocode/cli"; ' +
  'if [ -d "$_kc_pkg" ]; then ' +
  // Re-run the postinstall script explicitly
  // cd ~ first to avoid "current working directory was deleted" errors in bun/node
  'echo "==> kilocode binary not found, re-running postinstall..."; ' +
  'cd ~ && cd "$_kc_pkg" && npm run postinstall 2>/dev/null || true; ' +
  'export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ' +
  "if command -v kilocode >/dev/null 2>&1 && kilocode --version >/dev/null 2>&1; then exit 0; fi; " +
  // Postinstall re-run didn't help — search for native binary in the package
  'echo "==> Searching for kilocode binary in package directory..."; ' +
  '_kc_bin="$(find "$_kc_pkg" -name "kilocode*" -type f -perm /111 2>/dev/null | head -1)"; ' +
  'if [ -n "$_kc_bin" ]; then ' +
  '_kc_dest="$(npm prefix -g 2>/dev/null || echo /usr/local)/bin/kilocode"; ' +
  '[ -w "$(dirname "$_kc_dest")" ] || _kc_dest="$HOME/.npm-global/bin/kilocode"; ' +
  'mkdir -p "$(dirname "$_kc_dest")"; ' +
  'ln -sf "$_kc_bin" "$_kc_dest"; ' +
  'echo "==> Linked kilocode binary: $_kc_bin -> $_kc_dest"; ' +
  "fi; " +
  "fi; " +
  // Final check
  'export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ' +
  "command -v kilocode >/dev/null 2>&1 || " +
  '{ echo "WARNING: kilocode binary still not found after recovery attempts"; }; ' +
  "}";

/**
 * Shell snippet that verifies the junie binary is actually available after
 * npm install. @jetbrains/junie-cli uses a postinstall script that downloads a
 * native binary. On some clouds (notably Sprite with flaky IPv6 routing), the
 * postinstall can fail, leaving bin/index.js present but the native binary absent.
 *
 * This snippet:
 * 1. Checks if `junie` is already working
 * 2. If not, finds the npm package dir and re-runs the postinstall
 * 3. Warns if still not found after recovery
 */
const JUNIE_BINARY_VERIFY =
  "{ " +
  'export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ' +
  // Quick check: if junie already works, nothing to do
  "if command -v junie >/dev/null 2>&1 && junie --version >/dev/null 2>&1; then exit 0; fi; " +
  // Find the npm package directory
  '_jn_pkg="$(npm prefix -g 2>/dev/null)/lib/node_modules/@jetbrains/junie-cli"; ' +
  '[ -d "$_jn_pkg" ] || _jn_pkg="$HOME/.npm-global/lib/node_modules/@jetbrains/junie-cli"; ' +
  'if [ -d "$_jn_pkg" ]; then ' +
  // Re-run the postinstall script explicitly
  // cd ~ first to avoid "current working directory was deleted" errors in bun/node
  'echo "==> junie binary not found, re-running postinstall..."; ' +
  'cd ~ && cd "$_jn_pkg" && npm run postinstall 2>/dev/null || true; ' +
  'export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ' +
  "if command -v junie >/dev/null 2>&1 && junie --version >/dev/null 2>&1; then exit 0; fi; " +
  "fi; " +
  // Final check
  'export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ' +
  "command -v junie >/dev/null 2>&1 || " +
  '{ echo "WARNING: junie binary still not found after recovery attempts"; }; ' +
  "}";

// ─── Auto-Update Service ─────────────────────────────────────────────────────

/**
 * Install a systemd timer + service that periodically updates the agent
 * binary and system packages without disrupting running instances.
 *
 * Safety for running instances:
 * - Binary agents (Go, Rust): Linux keeps old inode in memory; replacement on disk is safe
 * - npm agents: Node.js caches all loaded modules in memory at startup. npm install -g
 *   replaces files on disk via a staging dir. Running processes are unaffected since
 *   CLI agents load everything at startup (no lazy imports after the swap).
 *
 * The new version takes effect on next restart via the existing restart loop.
 * Skipped for local cloud and non-systemd systems.
 */
export async function setupAutoUpdate(runner: CloudRunner, agentName: string, updateCmd: string): Promise<void> {
  logStep("Setting up agent auto-update service...");

  const wrapperScript = [
    "#!/bin/bash",
    "set -eo pipefail",
    'LOGFILE="/var/log/spawn-auto-update.log"',
    'LOCKFILE="/var/lock/spawn-auto-update.lock"',
    "",
    'log() { printf "[%s] %s\\n" "$(date -u +\'%Y-%m-%dT%H:%M:%SZ\')" "$*" >> "$LOGFILE"; }',
    "",
    "# Exclusive lock — skip if another update is already running",
    'exec 9>"$LOCKFILE"',
    "if ! flock -n 9; then",
    '  log "Another update is already running, skipping"',
    "  exit 0",
    "fi",
    "",
    '[ -f "$HOME/.spawnrc" ] && source "$HOME/.spawnrc" 2>/dev/null',
    'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.claude/local/bin:$PATH"',
    "",
    "# ── Phase 1: System package updates ──",
    'log "Updating system packages"',
    "if command -v apt-get >/dev/null 2>&1; then",
    "  _sudo_sys=''",
    '  [ "$(id -u)" != "0" ] && _sudo_sys="sudo"',
    "  export DEBIAN_FRONTEND=noninteractive",
    "  # Disable Ubuntu's unattended-upgrades to avoid dpkg lock contention.",
    "  # We handle all updates here — running both causes lock conflicts.",
    "  if $_sudo_sys systemctl is-active --quiet unattended-upgrades 2>/dev/null; then",
    "    $_sudo_sys systemctl disable --now unattended-upgrades 2>/dev/null || true",
    '    log "Disabled unattended-upgrades (spawn handles updates)"',
    "  fi",
    "  # Wait up to 5 min for any in-progress dpkg/apt operation to finish",
    '  $_sudo_sys flock -w 300 /var/lib/dpkg/lock-frontend apt-get update -qq >> "$LOGFILE" 2>&1 || log "apt-get update failed (non-fatal)"',
    '  $_sudo_sys flock -w 300 /var/lib/dpkg/lock-frontend apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" >> "$LOGFILE" 2>&1 || log "apt-get upgrade failed (non-fatal)"',
    '  $_sudo_sys apt-get autoremove -y -qq >> "$LOGFILE" 2>&1 || true',
    '  log "System packages updated"',
    "fi",
    "",
    "# ── Phase 2: Agent update ──",
    `log "Starting ${agentName} update"`,
    updateCmd + ' >> "$LOGFILE" 2>&1',
    "_exit=$?",
    'if [ "$_exit" -eq 0 ]; then',
    `  log "${agentName} update completed successfully"`,
    "else",
    `  log "${agentName} update failed (exit code $_exit)"`,
    "fi",
    'exit "$_exit"',
  ].join("\n");

  // __USER__ and __HOME__ are sed-substituted at deploy time
  const unitFile = [
    "[Unit]",
    `Description=Spawn auto-update for ${agentName}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "ExecStart=/usr/local/bin/spawn-auto-update",
    "User=__USER__",
    "Environment=HOME=__HOME__",
    "TimeoutStartSec=1800",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");

  const timerFile = [
    "[Unit]",
    `Description=Run spawn auto-update for ${agentName} every 6 hours`,
    "",
    "[Timer]",
    "OnBootSec=15min",
    "OnUnitActiveSec=6h",
    "RandomizedDelaySec=30min",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
  ].join("\n");

  const wrapperB64 = Buffer.from(wrapperScript).toString("base64");
  const unitB64 = Buffer.from(unitFile).toString("base64");
  const timerB64 = Buffer.from(timerFile).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(wrapperB64)) {
    throw new Error("Unexpected characters in base64 output");
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(unitB64)) {
    throw new Error("Unexpected characters in base64 output");
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(timerB64)) {
    throw new Error("Unexpected characters in base64 output");
  }

  const script = [
    "if ! command -v systemctl >/dev/null 2>&1; then exit 0; fi",
    '_sudo=""',
    '[ "$(id -u)" != "0" ] && _sudo="sudo"',
    "printf '%s' '" + wrapperB64 + "' | base64 -d | $_sudo tee /usr/local/bin/spawn-auto-update > /dev/null",
    "$_sudo chmod +x /usr/local/bin/spawn-auto-update",
    "printf '%s' '" + unitB64 + "' | base64 -d > /tmp/spawn-auto-update.service.tmp",
    'sed -i "s|__USER__|$(whoami)|;s|__HOME__|$HOME|" /tmp/spawn-auto-update.service.tmp',
    "$_sudo mv /tmp/spawn-auto-update.service.tmp /etc/systemd/system/spawn-auto-update.service",
    "printf '%s' '" + timerB64 + "' | base64 -d | $_sudo tee /etc/systemd/system/spawn-auto-update.timer > /dev/null",
    "$_sudo systemctl daemon-reload",
    "$_sudo systemctl enable spawn-auto-update.timer 2>/dev/null",
    "$_sudo systemctl start spawn-auto-update.timer",
  ].join("\n");

  const result = await asyncTryCatch(() => runner.runServer(script));
  if (result.ok) {
    logInfo("Agent auto-update service installed (runs every 6 hours)");
  } else {
    logWarn("Auto-update setup failed (non-fatal, agent still works)");
  }
}

// ─── Default Agent Definitions ───────────────────────────────────────────────

// Last zeroclaw release that shipped Linux prebuilt binaries (v0.1.9a has none).
// Used for direct binary install to avoid a Rust source build timeout.
const ZEROCLAW_PREBUILT_TAG = "v0.1.7-beta.30";

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
      updateCmd:
        'export PATH="$HOME/.claude/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.n/bin:$PATH"; ' +
        "npm install -g @anthropic-ai/claude-code@latest 2>/dev/null || " +
        "curl --proto '=https' -fsSL https://claude.ai/install.sh | bash",
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
      configure: () => setupCodexConfig(runner),
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex",
      updateCmd:
        'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"; ' +
        "npm install -g ${_NPM_G_FLAGS:-} @openai/codex@latest",
    },

    openclaw: (() => {
      const dashboardToken = crypto.randomUUID().replace(/-/g, "");
      return {
        name: "OpenClaw",
        cloudInitTier: "full" satisfies AgentConfig["cloudInitTier"],
        preProvision: detectGithubAuth,
        modelDefault: "openrouter/auto",
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
          setupOpenclawConfig(runner, apiKey, modelId || "openrouter/auto", dashboardToken, enabledSteps),
        preLaunch: () => startGateway(runner),
        preLaunchMsg: "Your web dashboard will open automatically — use it for WhatsApp QR scanning and channel setup.",
        launchCmd: () =>
          "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; openclaw tui",
        tunnel: {
          remotePort: 18789,
          browserUrl: (localPort: number) => `http://localhost:${localPort}/#token=${dashboardToken}`,
        },
        updateCmd:
          'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"; ' +
          "npm install -g ${_NPM_G_FLAGS:-} openclaw@latest",
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
      updateCmd: openCodeInstallCmd(),
    },

    kilocode: {
      name: "Kilo Code",
      cloudInitTier: "node",
      modelEnvVar: "KILOCODE_MODEL",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Kilo Code",
          `cd "$HOME" && ${NPM_PREFIX_SETUP} && npm install -g \${_NPM_G_FLAGS} @kilocode/cli && ${NPM_GLOBAL_PATH_PERSIST} && ${KILOCODE_BINARY_VERIFY}`,
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "KILO_PROVIDER_TYPE=openrouter",
        `KILO_OPEN_ROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode",
      updateCmd:
        'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"; ' +
        "npm install -g ${_NPM_G_FLAGS:-} @kilocode/cli@latest",
    },

    zeroclaw: {
      name: "ZeroClaw",
      cloudInitTier: "minimal",
      modelEnvVar: "ZEROCLAW_MODEL",
      preProvision: detectGithubAuth,
      install: async () => {
        // Direct binary install from pinned release (v0.1.9a "latest" has no assets,
        // causing the bootstrap --prefer-prebuilt path to 404-fail and fall back to
        // a Rust source build that exceeds the 600s install timeout).
        const directInstallCmd =
          `_ZC_ARCH="$(uname -m)"; ` +
          `if [ "$_ZC_ARCH" = "x86_64" ]; then _ZC_TARGET="x86_64-unknown-linux-gnu"; ` +
          `elif [ "$_ZC_ARCH" = "aarch64" ] || [ "$_ZC_ARCH" = "arm64" ]; then _ZC_TARGET="aarch64-unknown-linux-gnu"; ` +
          `else echo "Unsupported arch: $_ZC_ARCH" >&2; exit 1; fi; ` +
          `_ZC_URL="https://github.com/zeroclaw-labs/zeroclaw/releases/download/${ZEROCLAW_PREBUILT_TAG}/zeroclaw-\${_ZC_TARGET}.tar.gz"; ` +
          `_ZC_TMP="$(mktemp -d)"; ` +
          `curl --proto '=https' -fsSL "$_ZC_URL" -o "$_ZC_TMP/zeroclaw.tar.gz" && ` +
          `tar -xzf "$_ZC_TMP/zeroclaw.tar.gz" -C "$_ZC_TMP" && ` +
          `{ mkdir -p "$HOME/.local/bin" && install -m 755 "$_ZC_TMP/zeroclaw" "$HOME/.local/bin/zeroclaw"; } && ` +
          `rm -rf "$_ZC_TMP"`;
        await installAgent(runner, "ZeroClaw", directInstallCmd, 120);
      },
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "ZEROCLAW_PROVIDER=openrouter",
        "ZEROCLAW_RUNTIME=native",
      ],
      configure: (apiKey) => setupZeroclawConfig(runner, apiKey),
      launchCmd: () =>
        "export PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH; source ~/.spawnrc 2>/dev/null; zeroclaw agent",
      updateCmd:
        'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"; ' +
        `_ZC_ARCH="$(uname -m)"; ` +
        `if [ "$_ZC_ARCH" = "x86_64" ]; then _ZC_TARGET="x86_64-unknown-linux-gnu"; ` +
        `elif [ "$_ZC_ARCH" = "aarch64" ] || [ "$_ZC_ARCH" = "arm64" ]; then _ZC_TARGET="aarch64-unknown-linux-gnu"; ` +
        "else exit 1; fi; " +
        `_ZC_URL="https://github.com/zeroclaw-labs/zeroclaw/releases/latest/download/zeroclaw-\${_ZC_TARGET}.tar.gz"; ` +
        `_ZC_TMP="$(mktemp -d)"; ` +
        `curl --proto '=https' -fsSL "$_ZC_URL" -o "$_ZC_TMP/zeroclaw.tar.gz" && ` +
        `tar -xzf "$_ZC_TMP/zeroclaw.tar.gz" -C "$_ZC_TMP" && ` +
        `install -m 755 "$_ZC_TMP/zeroclaw" "$HOME/.local/bin/zeroclaw" && ` +
        `rm -rf "$_ZC_TMP"`,
    },

    hermes: {
      name: "Hermes Agent",
      cloudInitTier: "minimal",
      modelEnvVar: "LLM_MODEL",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Hermes Agent",
          // Force git to use HTTPS instead of SSH for GitHub URLs — pip dependencies
          // using git+ssh:// timeout on cloud VMs where outbound SSH is blocked/slow.
          'git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && ' +
            'git config --global url."https://github.com/".insteadOf "git@github.com:" && ' +
            "curl --proto '=https' -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
          600,
        ),
      envVars: (apiKey) => [
        `OPENROUTER_API_KEY=${apiKey}`,
        "OPENAI_BASE_URL=https://openrouter.ai/api/v1",
        `OPENAI_API_KEY=${apiKey}`,
        "HERMES_YOLO_MODE=1",
      ],
      configure: async (_apiKey, _modelId, enabledSteps) => {
        // YOLO mode is on by default (in envVars above). If the user explicitly
        // unchecked it in setup options, remove it from .spawnrc.
        if (enabledSteps && !enabledSteps.has("yolo-mode")) {
          await runner.runServer("sed -i '/HERMES_YOLO_MODE/d' ~/.spawnrc");
          logInfo("YOLO mode disabled — Hermes will prompt before installing tools");
        }
      },
      launchCmd: () =>
        "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.local/bin:$HOME/.hermes/hermes-agent/venv/bin:$PATH; hermes",
      updateCmd:
        // Same SSH→HTTPS rewrite for auto-update runs
        'git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && ' +
        'git config --global url."https://github.com/".insteadOf "git@github.com:" && ' +
        "curl --proto '=https' -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
    },

    junie: {
      name: "Junie",
      cloudInitTier: "node",
      preProvision: detectGithubAuth,
      install: () =>
        installAgent(
          runner,
          "Junie",
          `${NPM_PREFIX_SETUP} && npm install -g \${_NPM_G_FLAGS} @jetbrains/junie-cli && ${NPM_GLOBAL_PATH_PERSIST} && ${JUNIE_BINARY_VERIFY}`,
        ),
      envVars: (apiKey) => [
        `JUNIE_OPENROUTER_API_KEY=${apiKey}`,
        `OPENROUTER_API_KEY=${apiKey}`,
      ],
      launchCmd: () => "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; junie",
      updateCmd:
        'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"; ' +
        "npm install -g ${_NPM_G_FLAGS:-} @jetbrains/junie-cli@latest",
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

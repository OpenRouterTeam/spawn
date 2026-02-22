// gcp/gcp.ts — Core GCP Compute Engine provider: gcloud CLI wrapper, auth, provisioning, SSH

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  selectFromList,
  jsonEscape,
  validateServerName,
  toKebabCase,
  defaultSpawnName,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";

const DASHBOARD_URL = "https://console.cloud.google.com/compute/instances";

// ─── Machine Type Tiers ─────────────────────────────────────────────────────

export interface MachineTypeTier {
  id: string;
  label: string;
}

export const MACHINE_TYPES: MachineTypeTier[] = [
  { id: "e2-micro", label: "Shared CPU \u00b7 2 vCPU \u00b7 1 GB RAM (~$7/mo)" },
  { id: "e2-small", label: "Shared CPU \u00b7 2 vCPU \u00b7 2 GB RAM (~$14/mo)" },
  { id: "e2-medium", label: "Shared CPU \u00b7 2 vCPU \u00b7 4 GB RAM (~$28/mo)" },
  { id: "e2-standard-2", label: "2 vCPU \u00b7 8 GB RAM (~$49/mo)" },
  { id: "e2-standard-4", label: "4 vCPU \u00b7 16 GB RAM (~$98/mo)" },
  { id: "n2-standard-2", label: "2 vCPU \u00b7 8 GB RAM, higher perf (~$72/mo)" },
  { id: "n2-standard-4", label: "4 vCPU \u00b7 16 GB RAM, higher perf (~$144/mo)" },
  { id: "c4-standard-2", label: "2 vCPU \u00b7 8 GB RAM, latest gen (~$82/mo)" },
];

export const DEFAULT_MACHINE_TYPE = "e2-medium";

// ─── Zone Options ────────────────────────────────────────────────────────────

export interface ZoneOption {
  id: string;
  label: string;
}

export const ZONES: ZoneOption[] = [
  { id: "us-central1-a", label: "Iowa, US" },
  { id: "us-east1-b", label: "South Carolina, US" },
  { id: "us-east4-a", label: "N. Virginia, US" },
  { id: "us-west1-a", label: "Oregon, US" },
  { id: "us-west2-a", label: "Los Angeles, US" },
  { id: "northamerica-northeast1-a", label: "Montreal, Canada" },
  { id: "europe-west1-b", label: "Belgium" },
  { id: "europe-west4-a", label: "Netherlands" },
  { id: "europe-west6-a", label: "Zurich, Switzerland" },
  { id: "asia-east1-a", label: "Taiwan" },
  { id: "asia-southeast1-a", label: "Singapore" },
  { id: "australia-southeast1-a", label: "Sydney, Australia" },
];

export const DEFAULT_ZONE = "us-central1-a";

// ─── State ──────────────────────────────────────────────────────────────────

let gcpProject = "";
let gcpZone = "";
let gcpInstanceName = "";
let gcpServerIp = "";
let gcpUsername = "";

export function getState() {
  return { gcpProject, gcpZone, gcpInstanceName, gcpServerIp, gcpUsername };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── gcloud CLI Wrapper ─────────────────────────────────────────────────────

function getGcloudCmd(): string | null {
  if (Bun.spawnSync(["which", "gcloud"], { stdio: ["ignore", "pipe", "ignore"] }).exitCode === 0) {
    return "gcloud";
  }
  // Check common install locations
  const paths = [
    `${process.env.HOME}/google-cloud-sdk/bin/gcloud`,
    "/usr/lib/google-cloud-sdk/bin/gcloud",
    "/snap/bin/gcloud",
  ];
  for (const p of paths) {
    if (existsSync(p)) { return p; }
  }
  return null;
}

/** Run a gcloud command and return stdout. */
function gcloudSync(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const cmd = getGcloudCmd()!;
  const proc = Bun.spawnSync([cmd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
  };
}

/** Run a gcloud command asynchronously and return stdout. */
async function gcloud(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = getGcloudCmd()!;
  const proc = Bun.spawn([cmd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/** Run a gcloud command interactively (inheriting stdio). */
async function gcloudInteractive(args: string[]): Promise<number> {
  const cmd = getGcloudCmd()!;
  const proc = Bun.spawn([cmd, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  return proc.exited;
}

// ─── CLI Installation ───────────────────────────────────────────────────────

export async function ensureGcloudCli(): Promise<void> {
  if (getGcloudCmd()) {
    logInfo("gcloud CLI available");
    return;
  }

  logStep("Installing Google Cloud SDK...");

  if (process.platform === "darwin") {
    // Try Homebrew on macOS
    const brewCheck = Bun.spawnSync(["which", "brew"], { stdio: ["ignore", "pipe", "ignore"] });
    if (brewCheck.exitCode === 0) {
      const proc = Bun.spawn(["brew", "install", "--cask", "google-cloud-sdk"], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if ((await proc.exited) === 0) {
        // Source the path
        const prefix = new TextDecoder().decode(
          Bun.spawnSync(["brew", "--prefix"], { stdio: ["ignore", "pipe", "ignore"] }).stdout
        ).trim();
        const pathInc = `${prefix}/share/google-cloud-sdk/path.bash.inc`;
        if (existsSync(pathInc)) {
          // Add gcloud to PATH
          const sdkBin = `${prefix}/share/google-cloud-sdk/bin`;
          if (!process.env.PATH?.includes(sdkBin)) {
            process.env.PATH = `${sdkBin}:${process.env.PATH}`;
          }
        }
        if (getGcloudCmd()) {
          logInfo("Google Cloud SDK installed via Homebrew");
          return;
        }
      }
    }
  }

  // Linux / macOS without brew: use Google's installer
  const proc = Bun.spawn(
    ["bash", "-c", [
      "_gcp_tmp=$(mktemp -d)",
      `curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz" -o "$_gcp_tmp/gcloud.tar.gz"`,
      `tar -xzf "$_gcp_tmp/gcloud.tar.gz" -C "$HOME"`,
      `"$HOME/google-cloud-sdk/install.sh" --quiet --path-update true`,
      `rm -rf "$_gcp_tmp"`,
    ].join(" && ")],
    { stdio: ["ignore", "inherit", "pipe"] },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    logError("Failed to install Google Cloud SDK");
    logError("Install manually: https://cloud.google.com/sdk/docs/install");
    throw new Error("gcloud install failed");
  }

  // Add to PATH
  const sdkBin = `${process.env.HOME}/google-cloud-sdk/bin`;
  if (!process.env.PATH?.includes(sdkBin)) {
    process.env.PATH = `${sdkBin}:${process.env.PATH}`;
  }

  if (!getGcloudCmd()) {
    logError("gcloud not found after install. You may need to restart your shell.");
    throw new Error("gcloud not in PATH");
  }
  logInfo("Google Cloud SDK installed");
}

// ─── Authentication ─────────────────────────────────────────────────────────

export async function authenticate(): Promise<void> {
  // Check for active account
  const result = gcloudSync([
    "auth", "list", "--filter=status:ACTIVE", "--format=value(account)",
  ]);
  const activeAccount = result.stdout.split("\n")[0]?.trim();

  if (activeAccount?.includes("@")) {
    logInfo(`Authenticated as: ${activeAccount}`);
    return;
  }

  logWarn("No active Google Cloud account -- launching gcloud auth login...");
  const exitCode = await gcloudInteractive(["auth", "login"]);
  if (exitCode !== 0) {
    logError("Authentication failed. You can also set credentials via:");
    logError("  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json");
    throw new Error("gcloud auth failed");
  }
  logInfo("Authenticated with Google Cloud");
}

// ─── Project Resolution ─────────────────────────────────────────────────────

export async function resolveProject(): Promise<void> {
  // 1. Env var
  if (process.env.GCP_PROJECT) {
    gcpProject = process.env.GCP_PROJECT;
    logInfo(`Using GCP project from environment: ${gcpProject}`);
    return;
  }

  // 2. gcloud config
  const configResult = gcloudSync(["config", "get-value", "project"]);
  let project = configResult.stdout;
  if (project === "(unset)") { project = ""; }

  // 3. Confirm or pick
  if (project && process.env.SPAWN_NON_INTERACTIVE !== "1") {
    const confirm = await prompt(`Use project '${project}'? [Y/n]: `);
    if (/^[nN]/.test(confirm)) {
      project = "";
    }
  }

  if (!project) {
    logInfo("Fetching your GCP projects...");
    const listResult = await gcloud([
      "projects", "list",
      "--filter=lifecycleState=ACTIVE",
      "--format=value(projectId,name)",
    ]);

    if (listResult.exitCode !== 0 || !listResult.stdout) {
      logError("Failed to list GCP projects");
      logError("Set one before retrying:");
      logError("  export GCP_PROJECT=your-project-id");
      throw new Error("No GCP project");
    }

    const items = listResult.stdout.split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const parts = line.split("\t");
        return `${parts[0]}|${parts[1] || parts[0]}`;
      });

    if (items.length === 0) {
      logError("No active GCP projects found");
      logError("Create one at: https://console.cloud.google.com/projectcreate");
      throw new Error("No GCP projects");
    }

    project = await selectFromList(items, "GCP projects", items[0].split("|")[0]);
  }

  if (!project) {
    logError("No GCP project selected");
    logError("Set one before retrying:");
    logError("  export GCP_PROJECT=your-project-id");
    throw new Error("No GCP project");
  }

  gcpProject = project;
  logInfo(`Using GCP project: ${gcpProject}`);
}

// ─── Interactive Pickers ────────────────────────────────────────────────────

export async function promptMachineType(): Promise<string> {
  if (process.env.GCP_MACHINE_TYPE) {
    logInfo(`Using machine type from environment: ${process.env.GCP_MACHINE_TYPE}`);
    return process.env.GCP_MACHINE_TYPE;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return DEFAULT_MACHINE_TYPE;
  }

  process.stderr.write("\n");
  const items = MACHINE_TYPES.map((t) => `${t.id}|${t.label}`);
  return selectFromList(items, "GCP machine types", DEFAULT_MACHINE_TYPE);
}

export async function promptZone(): Promise<string> {
  if (process.env.GCP_ZONE) {
    logInfo(`Using zone from environment: ${process.env.GCP_ZONE}`);
    return process.env.GCP_ZONE;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return DEFAULT_ZONE;
  }

  process.stderr.write("\n");
  const items = ZONES.map((z) => `${z.id}|${z.label}`);
  return selectFromList(items, "GCP zones", DEFAULT_ZONE);
}

// ─── SSH Key ────────────────────────────────────────────────────────────────

function ensureSshKey(): string {
  const keyPath = `${process.env.HOME}/.ssh/id_ed25519`;
  const pubKeyPath = `${keyPath}.pub`;

  if (!existsSync(pubKeyPath)) {
    logStep("Generating SSH key...");
    mkdirSync(`${process.env.HOME}/.ssh`, { recursive: true });
    const result = Bun.spawnSync(
      ["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", "", "-q"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.exitCode !== 0) {
      logError("Failed to generate SSH key");
      throw new Error("SSH keygen failed");
    }
  }

  const pubKey = readFileSync(pubKeyPath, "utf-8").trim();
  logInfo("SSH key ready");
  return pubKey;
}

// ─── Username ───────────────────────────────────────────────────────────────

function resolveUsername(): string {
  if (gcpUsername) { return gcpUsername; }
  const result = Bun.spawnSync(["whoami"], { stdio: ["ignore", "pipe", "ignore"] });
  const username = new TextDecoder().decode(result.stdout).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    logError("Invalid username detected");
    throw new Error("Invalid username");
  }
  gcpUsername = username;
  return username;
}

// ─── Server Name ────────────────────────────────────────────────────────────

export async function getServerName(): Promise<string> {
  if (process.env.GCP_INSTANCE_NAME) {
    const name = process.env.GCP_INSTANCE_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid GCP_INSTANCE_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using instance name from environment: ${name}`);
    return name;
  }

  const kebab = process.env.SPAWN_NAME_KEBAB
    || (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "");
  return kebab || defaultSpawnName();
}

export async function promptSpawnName(): Promise<void> {
  if (process.env.SPAWN_NAME_KEBAB) { return; }

  let kebab: string;
  if (process.env.SPAWN_NAME) {
    kebab = toKebabCase(process.env.SPAWN_NAME) || defaultSpawnName();
  } else if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    kebab = defaultSpawnName();
  } else {
    const fallback = defaultSpawnName();
    process.stderr.write("\n");
    const answer = await prompt(`GCP instance name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

// ─── Cloud Init Startup Script ──────────────────────────────────────────────

function getStartupScript(username: string, tier: CloudInitTier = "full"): string {
  const packages = getPackagesForTier(tier);
  const lines = [
    "#!/bin/bash",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -y",
    `apt-get install -y --no-install-recommends ${packages.join(" ")}`,
  ];
  if (needsNode(tier)) {
    lines.push(
      "# Install Node.js 22 via n",
      `su - "${username}" -c '${NODE_INSTALL_CMD}'`,
      "# Install Claude Code as the login user",
      `su - "${username}" -c 'curl -fsSL https://claude.ai/install.sh | bash' || true`,
      "# Configure npm global prefix",
      `su - "${username}" -c 'mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global'`,
    );
  }
  if (needsBun(tier)) {
    lines.push(
      "# Install Bun as the login user",
      `su - "${username}" -c 'curl -fsSL https://bun.sh/install | bash' || true`,
      `ln -sf /home/${username}/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true`,
    );
  }
  lines.push(
    "# Configure PATH for all users",
    'echo \'export PATH="${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"\' >> /etc/profile.d/spawn.sh',
    "chmod +x /etc/profile.d/spawn.sh",
    "touch /tmp/.cloud-init-complete",
  );
  return lines.join("\n") + "\n";
}

// ─── Provisioning ───────────────────────────────────────────────────────────

export async function createInstance(
  name: string,
  zone: string,
  machineType: string,
  tier?: CloudInitTier,
): Promise<void> {
  const username = resolveUsername();
  const pubKey = ensureSshKey();

  logStep(`Creating GCP instance '${name}' (type: ${machineType}, zone: ${zone})...`);

  // Write startup script to a temp file
  const tmpFile = `/tmp/spawn_startup_${Date.now()}.sh`;
  writeFileSync(tmpFile, getStartupScript(username, tier));

  const args = [
    "compute", "instances", "create", name,
    `--zone=${zone}`,
    `--machine-type=${machineType}`,
    "--image-family=ubuntu-2404-lts-amd64",
    "--image-project=ubuntu-os-cloud",
    `--metadata-from-file=startup-script=${tmpFile}`,
    `--metadata=ssh-keys=${username}:${pubKey}`,
    `--project=${gcpProject}`,
    "--quiet",
  ];

  let result = await gcloud(args);

  // Auto-reauth on expired tokens
  if (result.exitCode !== 0 && /reauthentication|refresh.*auth|token.*expired|credentials.*invalid/i.test(result.stderr)) {
    logWarn("Auth tokens expired -- running gcloud auth login...");
    const reauth = await gcloudInteractive(["auth", "login"]);
    if (reauth === 0) {
      await gcloudInteractive(["config", "set", "project", gcpProject]);
      logInfo("Re-authenticated, retrying instance creation...");
      result = await gcloud(args);
    }
  }

  // Clean up temp file
  try { Bun.spawnSync(["rm", "-f", tmpFile]); } catch { /* ignore */ }

  if (result.exitCode !== 0) {
    logError("Failed to create GCP instance");
    if (result.stderr) { logError(`gcloud error: ${result.stderr}`); }
    logWarn("Common issues:");
    logWarn("  - Billing not enabled (enable at https://console.cloud.google.com/billing)");
    logWarn("  - Compute Engine API not enabled (enable at https://console.cloud.google.com/apis)");
    logWarn("  - Instance quota exceeded (try different GCP_ZONE)");
    logWarn("  - Machine type unavailable (try different GCP_MACHINE_TYPE or GCP_ZONE)");
    throw new Error("Instance creation failed");
  }

  // Get external IP
  const ipResult = gcloudSync([
    "compute", "instances", "describe", name,
    `--zone=${zone}`,
    `--project=${gcpProject}`,
    "--format=get(networkInterfaces[0].accessConfigs[0].natIP)",
  ]);

  gcpInstanceName = name;
  gcpZone = zone;
  gcpServerIp = ipResult.stdout;

  logInfo(`Instance created: IP=${gcpServerIp}`);

  // Save connection info
  const dir = `${process.env.HOME}/.spawn`;
  mkdirSync(dir, { recursive: true });
  const _zoneEscaped = jsonEscape(zone);
  const _projectEscaped = jsonEscape(gcpProject);
  const json = JSON.stringify({
    ip: gcpServerIp,
    user: username,
    server_name: name,
    cloud: "gcp",
    zone,
    project: gcpProject,
  });
  writeFileSync(`${dir}/last-connection.json`, json + "\n");
}

// ─── SSH Operations ─────────────────────────────────────────────────────────

const SSH_OPTS = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR";

export async function waitForSsh(maxAttempts = 30): Promise<void> {
  logStep("Waiting for SSH connectivity...");
  const username = resolveUsername();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const proc = Bun.spawn(
        ["ssh", ...SSH_OPTS.split(" "), "-o", "ConnectTimeout=5", `${username}@${gcpServerIp}`, "echo ok"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode === 0 && stdout.includes("ok")) {
        logInfo("SSH is ready");
        return;
      }
    } catch {
      // ignore
    }
    logStep(`SSH not ready yet (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }
  logError(`SSH connectivity failed after ${maxAttempts} attempts`);
  throw new Error("SSH wait timeout");
}

export async function waitForCloudInit(maxAttempts = 60): Promise<void> {
  await waitForSsh();

  logStep("Waiting for startup script completion...");
  const username = resolveUsername();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const proc = Bun.spawn(
        ["ssh", ...SSH_OPTS.split(" "), "-o", "ConnectTimeout=5", `${username}@${gcpServerIp}`, "test -f /tmp/.cloud-init-complete"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      if ((await proc.exited) === 0) {
        logInfo("Startup script completed");
        return;
      }
    } catch {
      // ignore
    }
    logStep(`Startup script running (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }
  logWarn("Startup script may not have completed, continuing...");
}

export async function runServer(cmd: string, timeoutSecs?: number): Promise<void> {
  const username = resolveUsername();
  const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;

  const proc = Bun.spawn(
    ["ssh", ...SSH_OPTS.split(" "), `${username}@${gcpServerIp}`, `bash -c ${shellQuote(fullCmd)}`],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env },
  );
  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
  }
}

export async function runServerCapture(cmd: string, timeoutSecs?: number): Promise<string> {
  const username = resolveUsername();
  const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;

  const proc = Bun.spawn(
    ["ssh", ...SSH_OPTS.split(" "), `${username}@${gcpServerIp}`, `bash -c ${shellQuote(fullCmd)}`],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) { throw new Error(`run_server_capture failed (exit ${exitCode})`); }
  return stdout.trim();
}

export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  const username = resolveUsername();
  // Expand $HOME on remote side
  const expandedPath = remotePath.replace(/^\$HOME/, "~");

  const proc = Bun.spawn(
    ["scp", ...SSH_OPTS.split(" "), localPath, `${username}@${gcpServerIp}:${expandedPath}`],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) { throw new Error(`upload_file failed for ${remotePath}`); }
}

export async function interactiveSession(cmd: string): Promise<number> {
  const username = resolveUsername();
  const term = process.env.TERM || "xterm-256color";
  const fullCmd = `export TERM=${term} PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c ${JSON.stringify(cmd)}`;

  const proc = Bun.spawn(
    ["ssh", ...SSH_OPTS.split(" "), "-t", `${username}@${gcpServerIp}`, `bash -c ${shellQuote(fullCmd)}`],
    { stdio: ["inherit", "inherit", "inherit"], env: process.env },
  );
  const exitCode = await proc.exited;

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your GCP instance '${gcpInstanceName}' is still running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${DASHBOARD_URL}`);
  logWarn("");
  logInfo("To delete from CLI:");
  logInfo("  spawn delete");
  logInfo("To reconnect:");
  logInfo(`  gcloud compute ssh ${gcpInstanceName} --zone=${gcpZone} --project=${gcpProject}`);

  return exitCode;
}

// ─── Retry Helper ───────────────────────────────────────────────────────────

export async function runWithRetry(
  maxAttempts: number,
  sleepSec: number,
  timeoutSecs: number,
  cmd: string,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runServer(cmd, timeoutSecs);
      return;
    } catch {
      logWarn(`Command failed (attempt ${attempt}/${maxAttempts}): ${cmd}`);
      if (attempt < maxAttempts) { await sleep(sleepSec * 1000); }
    }
  }
  logError(`Command failed after ${maxAttempts} attempts: ${cmd}`);
  throw new Error(`runWithRetry exhausted: ${cmd}`);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export async function destroyInstance(name?: string): Promise<void> {
  const instanceName = name || gcpInstanceName;
  const zone = gcpZone || process.env.GCP_ZONE || DEFAULT_ZONE;

  if (!instanceName) {
    logError("destroy: no instance name provided");
    throw new Error("No instance name");
  }

  logStep(`Destroying GCP instance '${instanceName}'...`);
  const result = await gcloud([
    "compute", "instances", "delete", instanceName,
    `--zone=${zone}`,
    `--project=${gcpProject}`,
    "--quiet",
  ]);

  if (result.exitCode !== 0) {
    logError(`Failed to destroy GCP instance '${instanceName}'`);
    logWarn("The instance may still be running and incurring charges.");
    logWarn(`Delete it manually: ${DASHBOARD_URL}`);
    throw new Error("Instance deletion failed");
  }
  logInfo(`Instance '${instanceName}' destroyed`);
}

// ─── Connection Tracking ────────────────────────────────────────────────────

export function saveLaunchCmd(launchCmd: string): void {
  const connFile = `${process.env.HOME}/.spawn/last-connection.json`;
  try {
    const data = JSON.parse(readFileSync(connFile, "utf-8"));
    data.launch_cmd = launchCmd;
    writeFileSync(connFile, JSON.stringify(data) + "\n");
  } catch {
    // non-fatal
  }
}

// ─── Shell Quoting ──────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

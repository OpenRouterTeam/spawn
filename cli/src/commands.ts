import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "child_process";
import {
  loadManifest,
  agentKeys,
  cloudKeys,
  matrixStatus,
  countImplemented,
  RAW_BASE,
  REPO,
  CACHE_DIR,
  type Manifest,
} from "./manifest.js";
import { VERSION } from "./version.js";
import { validateIdentifier, validateScriptContent } from "./security.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 10_000; // 10 seconds

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function handleCancel(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

function spawnBashScript(script: string, args: string[], cwd?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
      cwd: cwd || process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function withSpinner<T>(msg: string, fn: () => Promise<T>): Promise<T> {
  const s = p.spinner();
  s.start(msg);
  try {
    const result = await fn();
    s.stop(msg);
    return result;
  } catch (err) {
    s.stop(pc.red("Failed"));
    throw err;
  }
}

async function loadManifestWithSpinner(): Promise<Manifest> {
  return withSpinner("Loading manifest...", loadManifest);
}

function validateNonEmptyString(value: string, fieldName: string, helpCommand: string): void {
  if (!value || value.trim() === "") {
    p.log.error(`${fieldName} cannot be empty`);
    p.log.info(`Run ${pc.cyan(helpCommand)} to see available ${fieldName.toLowerCase()}s.`);
    process.exit(1);
  }
}

function errorMessage(message: string): never {
  p.log.error(message);
  process.exit(1);
}

function mapToSelectOptions<T extends { name: string; description: string }>(
  keys: string[],
  items: Record<string, T>
): Array<{ value: string; label: string; hint: string }> {
  return keys.map((key) => ({
    value: key,
    label: items[key].name,
    hint: items[key].description,
  }));
}

function getImplementedClouds(manifest: Manifest, agent: string): string[] {
  return cloudKeys(manifest).filter(
    (c: string): boolean => matrixStatus(manifest, c, agent) === "implemented"
  );
}

function validateAgent(manifest: Manifest, agent: string): asserts agent is keyof typeof manifest.agents {
  if (!manifest.agents[agent]) {
    p.log.error(`Unknown agent: ${pc.bold(agent)}`);
    p.log.info(`Run ${pc.cyan("spawn agents")} to see available agents.`);
    process.exit(1);
  }
}

function validateCloud(manifest: Manifest, cloud: string): asserts cloud is keyof typeof manifest.clouds {
  if (!manifest.clouds[cloud]) {
    p.log.error(`Unknown cloud: ${pc.bold(cloud)}`);
    p.log.info(`Run ${pc.cyan("spawn clouds")} to see available clouds.`);
    process.exit(1);
  }
}

function validateImplementation(manifest: Manifest, cloud: string, agent: string): void {
  const status = matrixStatus(manifest, cloud, agent);
  if (status !== "implemented") {
    errorMessage(
      `${manifest.agents[agent].name} on ${manifest.clouds[cloud].name} is not yet implemented.`
    );
  }
}

// ── Interactive ────────────────────────────────────────────────────────────────

export async function cmdInteractive(): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  const manifest = await loadManifestWithSpinner();

  const agents = agentKeys(manifest);
  const agentChoice = await p.select({
    message: "Select an agent",
    options: mapToSelectOptions(agents, manifest.agents),
  });
  if (p.isCancel(agentChoice)) handleCancel();

  const clouds = getImplementedClouds(manifest, agentChoice);

  if (clouds.length === 0) {
    p.log.error(`No clouds available for ${manifest.agents[agentChoice].name}`);
    process.exit(1);
  }

  const cloudChoice = await p.select({
    message: "Select a cloud provider",
    options: mapToSelectOptions(clouds, manifest.clouds),
  });
  if (p.isCancel(cloudChoice)) handleCancel();

  const agentName = manifest.agents[agentChoice].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.outro("Handing off to spawn script...");

  await execScript(cloudChoice, agentChoice);
}

// ── Run ────────────────────────────────────────────────────────────────────────

export async function cmdRun(agent: string, cloud: string): Promise<void> {
  // Validate input arguments
  validateNonEmptyString(agent, "Agent name", "spawn agents");
  validateNonEmptyString(cloud, "Cloud name", "spawn clouds");

  const manifest = await loadManifestWithSpinner();

  validateAgent(manifest, agent);
  validateCloud(manifest, cloud);
  validateImplementation(manifest, cloud, agent);

  const agentName = manifest.agents[agent].name;
  const cloudName = manifest.clouds[cloud].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}...`);

  await execScript(cloud, agent);
}

async function execScript(cloud: string, agent: string): Promise<void> {
  const url = `https://openrouter.ai/lab/spawn/${cloud}/${agent}.sh`;

  // Download script then execute, preserving stdin/stdout/stderr for interactive use
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Fallback to GitHub raw
      const ghUrl = `${RAW_BASE}/${cloud}/${agent}.sh`;
      const ghRes = await fetch(ghUrl);
      if (!ghRes.ok) {
        p.log.error(`Failed to download script from both ${url} and ${ghUrl}`);
        console.error(`Primary URL returned: HTTP ${res.status}, Fallback URL returned: HTTP ${ghRes.status}`);
        process.exit(1);
      }
      await runBash(await ghRes.text());
      return;
    }
    await runBash(await res.text());
  } catch (err) {
    p.log.error("Failed to download or execute spawn script");
    console.error("Error:", getErrorMessage(err));
    process.exit(1);
  }
}

function runBash(script: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Script exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

// ── List ───────────────────────────────────────────────────────────────────────

const MIN_AGENT_COL_WIDTH = 16;
const MIN_CLOUD_COL_WIDTH = 10;
const COL_PADDING = 2;
const NAME_COLUMN_WIDTH = 18;

function calculateColumnWidth(items: string[], minWidth: number): number {
  return Math.max(minWidth, ...items.map((item) => item.length + COL_PADDING));
}

function renderMatrixHeader(clouds: string[], manifest: Manifest, agentColWidth: number, cloudColWidth: number): string {
  let header = "".padEnd(agentColWidth);
  for (const c of clouds) {
    header += pc.bold(manifest.clouds[c].name.padEnd(cloudColWidth));
  }
  return header;
}

function renderMatrixSeparator(clouds: string[], agentColWidth: number, cloudColWidth: number): string {
  let sep = "".padEnd(agentColWidth);
  for (const _ of clouds) {
    sep += pc.dim("─".repeat(cloudColWidth - COL_PADDING) + "  ");
  }
  return sep;
}

function renderMatrixRow(agent: string, clouds: string[], manifest: Manifest, agentColWidth: number, cloudColWidth: number): string {
  let row = pc.bold(manifest.agents[agent].name.padEnd(agentColWidth));
  for (const c of clouds) {
    const status = matrixStatus(manifest, c, agent);
    const icon = status === "implemented" ? "  \u2713" : "  \u2013";
    const colorFn = status === "implemented" ? pc.green : pc.dim;
    row += colorFn(icon.padEnd(cloudColWidth));
  }
  return row;
}

export async function cmdList(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  const agents = agentKeys(manifest);
  const clouds = cloudKeys(manifest);

  const agentColWidth = calculateColumnWidth(
    agents.map((a) => manifest.agents[a].name),
    MIN_AGENT_COL_WIDTH
  );
  const cloudColWidth = calculateColumnWidth(
    clouds.map((c) => manifest.clouds[c].name),
    MIN_CLOUD_COL_WIDTH
  );

  console.log();
  console.log(renderMatrixHeader(clouds, manifest, agentColWidth, cloudColWidth));
  console.log(renderMatrixSeparator(clouds, agentColWidth, cloudColWidth));

  for (const a of agents) {
    console.log(renderMatrixRow(a, clouds, manifest, agentColWidth, cloudColWidth));
  }

  const impl = countImplemented(manifest);
  const total = agents.length * clouds.length;
  console.log();
  console.log(pc.green(`${impl}/${total} combinations implemented`));
  console.log();
}

// ── Agents ─────────────────────────────────────────────────────────────────────

export async function cmdAgents(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  console.log();
  console.log(pc.bold("Agents"));
  console.log();
  for (const key of agentKeys(manifest)) {
    const a = manifest.agents[key];
    console.log(`  ${pc.green(a.name.padEnd(NAME_COLUMN_WIDTH))} ${pc.dim(a.description)}`);
  }
  console.log();
}

// ── Clouds ─────────────────────────────────────────────────────────────────────

export async function cmdClouds(): Promise<void> {
  const manifest = await loadManifestWithSpinner();

  console.log();
  console.log(pc.bold("Cloud Providers"));
  console.log();
  for (const key of cloudKeys(manifest)) {
    const c = manifest.clouds[key];
    console.log(`  ${pc.green(c.name.padEnd(NAME_COLUMN_WIDTH))} ${pc.dim(c.description)}`);
  }
  console.log();
}

// ── Agent Info ─────────────────────────────────────────────────────────────────

export async function cmdAgentInfo(agent: string): Promise<void> {
  // Validate input argument
  validateNonEmptyString(agent, "Agent name", "spawn agents");

  const manifest = await loadManifestWithSpinner();

  validateAgent(manifest, agent);

  const a = manifest.agents[agent];
  console.log();
  console.log(`${pc.bold(a.name)} ${pc.dim("\u2014")} ${a.description}`);
  console.log();
  console.log(pc.bold("Available clouds:"));
  console.log();

  let found = false;
  for (const cloud of cloudKeys(manifest)) {
    const status = matrixStatus(manifest, cloud, agent);
    if (status === "implemented") {
      const c = manifest.clouds[cloud];
      console.log(`  ${pc.green(c.name.padEnd(NAME_COLUMN_WIDTH))} ${pc.dim("spawn " + agent + " " + cloud)}`);
      found = true;
    }
  }

  if (!found) {
    console.log(pc.dim("  No implemented clouds yet."));
  }
  console.log();
}

// ── Improve ────────────────────────────────────────────────────────────────────

function isLocalSpawnCheckout(exists: (path: string) => boolean): boolean {
  return exists("./improve.sh") && exists("./manifest.json");
}

async function ensureRepoExists(repoDir: string, exists: (path: string) => boolean): Promise<void> {
  const { join } = await import("path");
  const { execSync } = await import("child_process");

  if (exists(join(repoDir, ".git"))) {
    p.log.step("Updating spawn repo...");
    try {
      execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe" });
    } catch (err) {
      // Git pull failed (network issue, merge conflict, etc.) - continue with existing repo
      console.error("Warning: Failed to update repo:", getErrorMessage(err));
    }
  } else {
    p.log.step("Cloning spawn repo...");
    execSync(`git clone https://github.com/${REPO}.git ${repoDir}`, { stdio: "inherit" });
  }
}

export async function cmdImprove(args: string[]): Promise<void> {
  const { existsSync: exists } = await import("fs");

  // Check if we're in a spawn checkout
  if (isLocalSpawnCheckout(exists)) {
    return spawnBashScript("improve.sh", args, ".");
  }

  const { join } = await import("path");
  const repoDir = join(CACHE_DIR, "repo");
  await ensureRepoExists(repoDir, exists);
  return spawnBashScript("improve.sh", args, repoDir);
}

// ── Update ─────────────────────────────────────────────────────────────────────

export async function cmdUpdate(): Promise<void> {
  const s = p.spinner();
  s.start("Checking for updates...");

  try {
    const res = await fetch(`${RAW_BASE}/cli/package.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error("fetch failed");
    const pkg = (await res.json()) as { version: string };
    const remoteVersion = pkg.version;

    if (remoteVersion === VERSION) {
      s.stop(`Already up to date ${pc.dim(`(v${VERSION})`)}`);
      return;
    }

    s.message(`Updating v${VERSION} \u2192 v${remoteVersion}...`);

    // Run the install script to update
    const installRes = await fetch(`${RAW_BASE}/cli/install.sh`);
    if (!installRes.ok) throw new Error("fetch install.sh failed");
    const installScript = await installRes.text();

    s.stop(`Update available: v${VERSION} \u2192 v${remoteVersion}`);
    p.log.info(`Run this to update:`);
    console.log();
    console.log(
      `  ${pc.cyan(`curl -fsSL ${RAW_BASE}/cli/install.sh | bash`)}`
    );
    console.log();
  } catch (err) {
    s.stop(pc.red("Failed to check for updates"));
    console.error("Error:", getErrorMessage(err));
  }
}

// ── Help ───────────────────────────────────────────────────────────────────────

export function cmdHelp(): void {
  console.log(`
${pc.bold("spawn")} \u2014 Launch any AI coding agent on any cloud

${pc.bold("USAGE")}
  spawn                       Interactive agent + cloud picker
  spawn <agent> <cloud>       Launch agent on cloud directly
  spawn <agent>               Show available clouds for agent
  spawn list                  Full matrix table
  spawn agents                List all agents with descriptions
  spawn clouds                List all cloud providers
  spawn improve [--loop]      Run improvement system
  spawn update                Check for CLI updates
  spawn version               Show version

${pc.bold("EXAMPLES")}
  spawn                       ${pc.dim("# Pick interactively")}
  spawn claude sprite         ${pc.dim("# Launch Claude Code on Sprite")}
  spawn aider hetzner         ${pc.dim("# Launch Aider on Hetzner Cloud")}
  spawn claude                ${pc.dim("# Show which clouds support Claude")}
  spawn list                  ${pc.dim("# See the full agent x cloud matrix")}

${pc.bold("INSTALL")}
  curl -fsSL ${RAW_BASE}/cli/install.sh | bash
`);
}

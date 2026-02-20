import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Types ───────────────────────────────────────────────────────────

interface AgentEntry {
  icon?: string;
  repo?: string;
  github_stars?: number;
  stars_updated?: string;
  license?: string;
  language?: string;
  creator?: string;
  created?: string;
  added?: string;
  runtime?: string;
  category?: string;
  tagline?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface CloudEntry {
  icon?: string;
  [key: string]: unknown;
}

interface SourceEntry {
  url: string;
  ext: string;
}

// ── Paths ───────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "../../..");
const MANIFEST_PATH = resolve(ROOT, "manifest.json");
const AGENT_SOURCES_PATH = resolve(ROOT, "assets/agents/.sources.json");
const CLOUD_SOURCES_PATH = resolve(ROOT, "assets/clouds/.sources.json");

// ── Parse args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const iconsOnly = args.includes("--icons-only");
const statsOnly = args.includes("--stats-only");
const cloudsOnly = args.includes("--clouds-only");
const agentsOnly = args.includes("--agents-only");
const validateOnly = args.includes("--validate");
const agentIdx = args.indexOf("--agent");
const onlyAgent = agentIdx !== -1 ? args[agentIdx + 1] : null;
const cloudIdx = args.indexOf("--cloud");
const onlyCloud = cloudIdx !== -1 ? args[cloudIdx + 1] : null;

let hasErrors = false;

// ── Load data ───────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const agents: Record<string, AgentEntry> = manifest.agents;
const clouds: Record<string, CloudEntry> = manifest.clouds;

const agentSources: Record<string, SourceEntry> = existsSync(
  AGENT_SOURCES_PATH
)
  ? JSON.parse(readFileSync(AGENT_SOURCES_PATH, "utf-8"))
  : {};

const cloudSources: Record<string, SourceEntry> = existsSync(
  CLOUD_SOURCES_PATH
)
  ? JSON.parse(readFileSync(CLOUD_SOURCES_PATH, "utf-8"))
  : {};

const agentIds = onlyAgent ? [onlyAgent] : Object.keys(agents);
const cloudIds = onlyCloud ? [onlyCloud] : Object.keys(clouds);
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const EXT_MAP: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const AGENT_METADATA_FIELDS = [
  "creator",
  "repo",
  "license",
  "created",
  "added",
  "github_stars",
  "stars_updated",
  "language",
  "runtime",
  "category",
  "tagline",
  "tags",
];

// ── Source URL validation ────────────────────────────────────────────

async function validateSources(
  label: string,
  ids: string[],
  entries: Record<string, { icon?: string; [k: string]: unknown }>,
  sources: Record<string, SourceEntry>,
  assetDir: string
) {
  console.log(`── Validating ${label} source URLs ──`);
  for (const id of ids) {
    const src = sources[id];
    if (!src) {
      if (entries[id]?.icon) {
        console.log(`  ✗  ${id}: has icon in manifest but MISSING from ${assetDir}/.sources.json`);
        hasErrors = true;
      } else {
        console.log(`  ⚠  ${id}: no source entry (no icon configured)`);
      }
      continue;
    }
    try {
      const res = await fetch(src.url, { method: "HEAD" });
      if (!res.ok) {
        console.log(
          `  ✗  ${id}: BROKEN source URL (HTTP ${res.status}) → ${src.url}`
        );
        hasErrors = true;
      } else {
        const contentType =
          res.headers.get("content-type")?.split(";")[0] ?? "";
        const isImage = contentType.startsWith("image/");
        if (!isImage) {
          console.log(
            `  ⚠  ${id}: source URL returns ${contentType}, not an image → ${src.url}`
          );
        } else {
          console.log(`  ✓  ${id}: OK (${contentType})`);
        }
      }
    } catch (err) {
      console.log(`  ✗  ${id}: UNREACHABLE → ${src.url} (${err})`);
      hasErrors = true;
    }
  }
}

// ── Generic icon refresh ────────────────────────────────────────────

async function refreshIconsFor(
  label: string,
  ids: string[],
  entries: Record<string, { icon?: string; [k: string]: unknown }>,
  sources: Record<string, SourceEntry>,
  assetDir: string
) {
  console.log(`── Refreshing ${label} icons ──`);
  for (const id of ids) {
    const src = sources[id];
    if (!src) {
      console.log(`  ⚠  ${id}: no entry in .sources.json, skipping icon`);
      continue;
    }
    try {
      const res = await fetch(src.url);
      if (!res.ok) {
        console.log(`  ⚠  ${id}: icon fetch failed (HTTP ${res.status})`);
        continue;
      }
      const contentType =
        res.headers.get("content-type")?.split(";")[0] ?? "";
      const ext = EXT_MAP[contentType] ?? src.ext;
      const outPath = resolve(ROOT, `${assetDir}/${id}.${ext}`);
      const rawUrl = `https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/${assetDir}/${id}.${ext}`;

      if (dryRun) {
        console.log(
          `  [dry-run] ${id}: would download ${src.url} → ${outPath}`
        );
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(outPath, buf);
        entries[id].icon = rawUrl;
        sources[id].ext = ext;
        console.log(
          `  ✓  ${id}: icon refreshed (${buf.length} bytes, .${ext})`
        );
      }
    } catch (err) {
      console.log(`  ⚠  ${id}: icon fetch error: ${err}`);
    }
  }
}

// ── GitHub metadata refresh (agents only) ───────────────────────────

// SECURITY: Validate GitHub repo format to prevent command injection via manifest.json
const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

async function refreshAgentStats() {
  console.log("── Refreshing agent GitHub stats ──");
  for (const id of agentIds) {
    const agent = agents[id];
    if (!agent.repo) {
      console.log(`  ⚠  ${id}: no repo field, skipping GitHub metadata`);
      continue;
    }
    if (!GITHUB_REPO_PATTERN.test(agent.repo)) {
      console.log(`  ⚠  ${id}: invalid repo format '${agent.repo}', skipping`);
      continue;
    }
    try {
      const proc = Bun.spawn(
        [
          "gh",
          "api",
          `repos/${agent.repo}`,
          "--jq",
          "{stargazers_count, license: .license.spdx_id, language}",
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const out = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const errText = await new Response(proc.stderr).text();
        console.log(`  ⚠  ${id}: gh api failed: ${errText.trim()}`);
        continue;
      }
      const data = JSON.parse(out);
      const oldStars = agent.github_stars;

      if (dryRun) {
        console.log(
          `  [dry-run] ${id}: stars ${oldStars ?? "?"} → ${data.stargazers_count}`
        );
        if (data.license && data.license !== agent.license)
          console.log(
            `  [dry-run] ${id}: license ${agent.license ?? "?"} → ${data.license}`
          );
        if (data.language && data.language !== agent.language)
          console.log(
            `  [dry-run] ${id}: language ${agent.language ?? "?"} → ${data.language}`
          );
      } else {
        agent.github_stars = data.stargazers_count;
        agent.stars_updated = today;
        if (data.license) agent.license = data.license;
        if (data.language) agent.language = data.language;
        const delta =
          oldStars != null
            ? ` (${data.stargazers_count - oldStars >= 0 ? "+" : ""}${data.stargazers_count - oldStars})`
            : "";
        console.log(`  ✓  ${id}: ${data.stargazers_count} stars${delta}`);
      }
    } catch (err) {
      console.log(`  ⚠  ${id}: GitHub metadata error: ${err}`);
    }
  }
}

// ── Metadata completeness check ─────────────────────────────────────

function validateAgentMetadata() {
  console.log("── Agent metadata completeness ──");
  for (const id of agentIds) {
    const agent = agents[id];
    const missing = AGENT_METADATA_FIELDS.filter((f) => agent[f] == null);
    if (missing.length > 0) {
      console.log(`  ⚠  ${id}: missing ${missing.join(", ")}`);
    } else {
      console.log(`  ✓  ${id}: all metadata fields present`);
    }
  }
}

function validateCloudIcons() {
  console.log("── Cloud icon completeness ──");
  for (const id of cloudIds) {
    const cloud = clouds[id];
    if (!cloud.icon) {
      console.log(`  ⚠  ${id}: missing icon`);
    } else {
      console.log(`  ✓  ${id}: icon present`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const scope = cloudsOnly
    ? "clouds"
    : agentsOnly
      ? "agents"
      : "agents + clouds";
  const mode = validateOnly
    ? "validate"
    : dryRun
      ? "dry-run"
      : "update";
  console.log(`${mode === "validate" ? "Validating" : "Updating"} metadata for ${scope}${mode === "dry-run" ? " [dry-run]" : ""}...\n`);

  if (validateOnly) {
    // Validate-only: HEAD-check all source URLs, report broken ones
    if (!cloudsOnly)
      await validateSources("agent", agentIds, agents, agentSources, "assets/agents");
    if (!agentsOnly)
      await validateSources("cloud", cloudIds, clouds, cloudSources, "assets/clouds");
    if (!cloudsOnly) validateAgentMetadata();
    if (!agentsOnly) validateCloudIcons();

    if (hasErrors) {
      console.log(
        "\n✗  Validation failed — fix broken source URLs in .sources.json files"
      );
      process.exit(1);
    } else {
      console.log("\n✓  All source URLs valid");
    }
    return;
  }

  // Agent icons
  if (!cloudsOnly && !statsOnly) {
    await refreshIconsFor(
      "agent",
      agentIds,
      agents,
      agentSources,
      "assets/agents"
    );
  }

  // Cloud icons
  if (!agentsOnly && !statsOnly) {
    await refreshIconsFor(
      "cloud",
      cloudIds,
      clouds,
      cloudSources,
      "assets/clouds"
    );
  }

  // Agent GitHub stats
  if (!cloudsOnly && !iconsOnly) {
    await refreshAgentStats();
  }

  // Validation
  if (!cloudsOnly) validateAgentMetadata();
  if (!agentsOnly) validateCloudIcons();

  if (!dryRun) {
    writeFileSync(
      MANIFEST_PATH,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8"
    );
    writeFileSync(
      AGENT_SOURCES_PATH,
      JSON.stringify(agentSources, null, 2) + "\n",
      "utf-8"
    );
    writeFileSync(
      CLOUD_SOURCES_PATH,
      JSON.stringify(cloudSources, null, 2) + "\n",
      "utf-8"
    );
    console.log("\n✓  manifest.json and .sources.json files updated");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

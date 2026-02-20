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

interface SourceEntry {
  url: string;
  ext: string;
}

// ── Paths ───────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "../../..");
const MANIFEST_PATH = resolve(ROOT, "manifest.json");
const SOURCES_PATH = resolve(ROOT, "assets/agents/.sources.json");

// ── Parse args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const iconsOnly = args.includes("--icons-only");
const statsOnly = args.includes("--stats-only");
const agentIdx = args.indexOf("--agent");
const onlyAgent = agentIdx !== -1 ? args[agentIdx + 1] : null;

// ── Load data ───────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const agents: Record<string, AgentEntry> = manifest.agents;
const sources: Record<string, SourceEntry> = existsSync(SOURCES_PATH)
  ? JSON.parse(readFileSync(SOURCES_PATH, "utf-8"))
  : {};

const agentIds = onlyAgent ? [onlyAgent] : Object.keys(agents);
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const EXT_MAP: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const METADATA_FIELDS = [
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

// ── Icon refresh ────────────────────────────────────────────────────

async function refreshIcons() {
  console.log("── Refreshing icons ──");
  for (const id of agentIds) {
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
      const outPath = resolve(ROOT, `assets/agents/${id}.${ext}`);
      const rawUrl = `https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/assets/agents/${id}.${ext}`;

      if (dryRun) {
        console.log(
          `  [dry-run] ${id}: would download ${src.url} → ${outPath}`
        );
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(outPath, buf);
        agents[id].icon = rawUrl;
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

// ── GitHub metadata refresh ─────────────────────────────────────────

async function refreshStats() {
  console.log("── Refreshing GitHub stats ──");
  for (const id of agentIds) {
    const agent = agents[id];
    if (!agent.repo) {
      console.log(`  ⚠  ${id}: no repo field, skipping GitHub metadata`);
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

function validateMetadata() {
  console.log("── Metadata completeness ──");
  for (const id of agentIds) {
    const agent = agents[id];
    const missing = METADATA_FIELDS.filter((f) => agent[f] == null);
    if (missing.length > 0) {
      console.log(`  ⚠  ${id}: missing ${missing.join(", ")}`);
    } else {
      console.log(`  ✓  ${id}: all metadata fields present`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Updating metadata for ${agentIds.length} agent(s)${dryRun ? " [dry-run]" : ""}...\n`
  );

  if (!statsOnly) await refreshIcons();
  if (!iconsOnly) await refreshStats();
  validateMetadata();

  if (!dryRun) {
    writeFileSync(
      MANIFEST_PATH,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8"
    );
    writeFileSync(
      SOURCES_PATH,
      JSON.stringify(sources, null, 2) + "\n",
      "utf-8"
    );
    console.log("\n✓  manifest.json and .sources.json updated");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

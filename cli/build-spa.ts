#!/usr/bin/env bun
// Build the SPA (Spawn's Personal Agent) Slack bot into a single bundled JS file.
// The source lives in .claude/skills/setup-spa/ and imports shared utilities from cli/src/.
//
// Usage:
//   bun run cli/build-spa.ts

import path from "path";

const cliDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.dirname(cliDir);
const entry = path.join(repoRoot, ".claude/skills/setup-spa/main.ts");
const outfile = path.join(cliDir, "spa.js");

console.log("build: .claude/skills/setup-spa/main.ts -> cli/spa.js");

const result = await Bun.build({
  entrypoints: [entry],
  outdir: cliDir,
  naming: "spa.js",
  target: "bun",
  minify: true,
  packages: "external",
});

if (!result.success) {
  console.error("FAIL: spa");
  for (const log of result.logs) console.error("  ", log);
  process.exit(1);
}

const stat = Bun.file(outfile);
console.log(`  spa.js  ${(stat.size / 1024).toFixed(1)} KB`);

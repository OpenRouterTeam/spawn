#!/usr/bin/env bun
// Build the SPA (Spawn's Personal Agent) Slack bot into a single bundled JS file.
//
// Usage:
//   bun run .claude/skills/setup-spa/build.ts

import path from "path";

const spaDir = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(spaDir, "main.ts");
const outfile = path.join(spaDir, "spa.js");

console.log("build: .claude/skills/setup-spa/main.ts -> .claude/skills/setup-spa/spa.js");

const result = await Bun.build({
  entrypoints: [entry],
  outdir: spaDir,
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

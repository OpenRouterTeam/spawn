#!/usr/bin/env bun
// Build bundled JS files for cloud providers that use TypeScript.
// Each cloud with a cli/src/{cloud}/main.ts gets bundled into {cloud}.js.
// These bundles are uploaded to GitHub releases for curl|bash execution.
//
// Usage:
//   bun run cli/build-clouds.ts          # build all clouds
//   bun run cli/build-clouds.ts fly      # build specific cloud

import { readdirSync, existsSync } from "fs";
import path from "path";

const cliDir = path.dirname(new URL(import.meta.url).pathname);
const srcDir = path.join(cliDir, "src");

async function buildCloud(cloud: string): Promise<boolean> {
  const entry = path.join(srcDir, cloud, "main.ts");
  const outfile = path.join(cliDir, `${cloud}.js`);

  if (!existsSync(entry)) {
    console.log(`skip: ${entry} not found`);
    return false;
  }

  console.log(`build: src/${cloud}/main.ts -> ${cloud}.js`);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: cliDir,
    naming: `${cloud}.js`,
    target: "bun",
    minify: true,
    packages: "bundle",
  });

  if (!result.success) {
    console.error(`FAIL: ${cloud}`);
    for (const log of result.logs) console.error("  ", log);
    return false;
  }

  const stat = Bun.file(outfile);
  console.log(`  ${cloud}.js  ${(stat.size / 1024).toFixed(1)} KB`);
  return true;
}

const filter = process.argv[2];
let built = 0;
let failed = 0;

if (filter) {
  (await buildCloud(filter)) ? built++ : failed++;
} else {
  // Auto-discover: any directory under src/ with a main.ts
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("__")) continue;
    if (!existsSync(path.join(srcDir, entry.name, "main.ts"))) continue;
    (await buildCloud(entry.name)) ? built++ : failed++;
  }
}

console.log(`\n${built} built, ${failed} failed`);
if (failed > 0) process.exit(1);

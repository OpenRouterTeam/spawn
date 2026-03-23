/**
 * docker-cloudinit-skip.test.ts — Verify Docker mode skips cloud-init wait.
 *
 * When --beta docker is active, waitForReady() must skip cloud-init polling
 * and only wait for SSH. This test reads the orchestrator source files to
 * verify the useDocker check is present in the waitForReady condition.
 *
 * Without this, non-minimal agents (openclaw, codex) wait 5 minutes for a
 * cloud-init marker that never appears when using Docker app images.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI_SRC = resolve(import.meta.dir, "..");

describe("Docker mode skips cloud-init wait", () => {
  it("Hetzner waitForReady includes useDocker in skip condition", () => {
    const source = readFileSync(resolve(CLI_SRC, "hetzner/main.ts"), "utf-8");
    // The waitForReady condition must include useDocker to skip cloud-init
    // when Docker mode is active (matching GCP's implementation)
    expect(source).toContain("useDocker || snapshotId || cloud.skipCloudInit");
  });

  it("GCP waitForReady includes useDocker in skip condition", () => {
    const source = readFileSync(resolve(CLI_SRC, "gcp/main.ts"), "utf-8");
    expect(source).toContain("useDocker || cloud.skipCloudInit");
  });
});

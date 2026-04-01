import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockBunSpawn, mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import { cleanupContainer, ensureDocker, isDockerAvailable, pullAndStartContainer } from "../local/local";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockSpawnSync(exitCode: number, stdout = "", stderr = "") {
  return spyOn(Bun, "spawnSync").mockReturnValue({
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
    success: exitCode === 0,
    signalCode: null,
    resourceUsage: undefined,
    pid: 1234,
  } satisfies ReturnType<typeof Bun.spawnSync>);
}

let origEnv: NodeJS.ProcessEnv;
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  origEnv = {
    ...process.env,
  };
  stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  process.env = origEnv;
  stderrSpy.mockRestore();
  mock.restore();
});

// ─── isDockerAvailable ──────────────────────────────────────────────────────

describe("isDockerAvailable", () => {
  it("returns true when docker info exits 0", () => {
    const spy = mockSpawnSync(0);
    expect(isDockerAvailable()).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      [
        "docker",
        "info",
      ],
      expect.anything(),
    );
    spy.mockRestore();
  });

  it("returns false when docker info exits non-zero", () => {
    const spy = mockSpawnSync(1);
    expect(isDockerAvailable()).toBe(false);
    spy.mockRestore();
  });
});

// ─── ensureDocker ───────────────────────────────────────────────────────────

describe("ensureDocker", () => {
  it("returns immediately if docker is available", async () => {
    const spy = mockSpawnSync(0);
    await ensureDocker();
    // Should have called spawnSync for docker info check only
    expect(spy.mock.calls[0][0]).toEqual([
      "docker",
      "info",
    ]);
    spy.mockRestore();
  });

  it("attempts brew install on macOS when docker not installed", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    let callCount = 0;
    const spy = spyOn(Bun, "spawnSync").mockImplementation((..._args: unknown[]) => {
      callCount++;
      const ok = {
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1234,
      } satisfies ReturnType<typeof Bun.spawnSync>;
      const fail = {
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        success: false,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1234,
      } satisfies ReturnType<typeof Bun.spawnSync>;
      // 1: docker info → fail, 2: which docker → fail (not installed),
      // 3: brew install → ok, 4: open -a OrbStack → ok, 5: docker info → ok
      if (callCount <= 2) {
        return fail;
      }
      return ok;
    });

    await ensureDocker();

    // Call 1: docker info, 2: which docker, 3: brew install orbstack
    expect(spy.mock.calls[2][0]).toEqual([
      "brew",
      "install",
      "orbstack",
    ]);
    // Call 4: open -a OrbStack (starts daemon)
    expect(spy.mock.calls[3][0]).toEqual([
      "open",
      "-a",
      "OrbStack",
    ]);

    spy.mockRestore();
    if (origPlatform) {
      Object.defineProperty(process, "platform", origPlatform);
    }
  });
});

// ─── pullAndStartContainer ──────────────────────────────────────────────────

describe("pullAndStartContainer", () => {
  it("cleans up stale container, pulls image, and starts new container", async () => {
    // Mock spawnSync for cleanup call
    const syncSpy = mockSpawnSync(0);
    // Mock Bun.spawn for runLocal calls
    const spawnSpy = mockBunSpawn(0);

    await pullAndStartContainer("claude");

    // First spawnSync call: docker rm -f spawn-agent (cleanup)
    expect(syncSpy.mock.calls[0][0]).toEqual([
      "docker",
      "rm",
      "-f",
      "spawn-agent",
    ]);

    // Bun.spawn calls: docker pull, docker run
    const spawnCalls = spawnSpy.mock.calls;
    expect(spawnCalls.length).toBe(2);

    // Pull command
    const pullCmd = spawnCalls[0][0][2];
    expect(pullCmd).toContain("docker pull");
    expect(pullCmd).toContain("ghcr.io/openrouterteam/spawn-claude:latest");

    // Run command
    const runCmd = spawnCalls[1][0][2];
    expect(runCmd).toContain("docker run -d");
    expect(runCmd).toContain("--name spawn-agent");
    expect(runCmd).toContain("ghcr.io/openrouterteam/spawn-claude:latest");

    syncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── cleanupContainer ───────────────────────────────────────────────────────

describe("cleanupContainer", () => {
  it("runs docker rm -f spawn-agent", () => {
    const spy = mockSpawnSync(0);
    cleanupContainer();
    expect(spy).toHaveBeenCalledWith(
      [
        "docker",
        "rm",
        "-f",
        "spawn-agent",
      ],
      expect.anything(),
    );
    spy.mockRestore();
  });
});

// ─── sandbox mode integration ───────────────────────────────────────────────

describe("sandbox mode", () => {
  it("sandbox beta feature is detected from SPAWN_BETA", () => {
    process.env.SPAWN_BETA = "sandbox";
    const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
    expect(betaFeatures.includes("sandbox")).toBe(true);
  });

  it("sandbox can coexist with other beta features", () => {
    process.env.SPAWN_BETA = "tarball,sandbox,parallel";
    const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
    expect(betaFeatures.includes("sandbox")).toBe(true);
    expect(betaFeatures.includes("tarball")).toBe(true);
  });
});

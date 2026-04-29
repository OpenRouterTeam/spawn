import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockBunSpawn, mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import {
  cleanupContainer,
  dockerInteractiveSession,
  ensureDocker,
  interactiveSession,
  isDockerAvailable,
  pullAndStartContainer,
  runLocal,
  runLocalArgs,
  validateAgentName,
  validateLocalPath,
} from "../local/local";

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

  it("attempts brew install on macOS when docker not installed and brew is present", async () => {
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
      // 3: which brew → ok, 4: brew install → ok,
      // 5: open -a OrbStack → ok, 6: docker info → ok (waitForReady loop)
      if (callCount <= 2) {
        return fail;
      }
      return ok;
    });

    await ensureDocker();

    // Call 3: which brew (probe)
    expect(spy.mock.calls[2][0]).toEqual([
      "which",
      "brew",
    ]);
    // Call 4: brew install orbstack
    expect(spy.mock.calls[3][0]).toEqual([
      "brew",
      "install",
      "orbstack",
    ]);
    // Call 5: open -a OrbStack (starts daemon)
    expect(spy.mock.calls[4][0]).toEqual([
      "open",
      "-a",
      "OrbStack",
    ]);

    spy.mockRestore();
    if (origPlatform) {
      Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("falls back to DMG download on macOS when brew is missing", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    // The DMG installer size-checks the downloaded file; have the curl mock
    // write a real fake-DMG large enough to pass the threshold.
    const { writeFileSync } = await import("node:fs");
    const { isString } = await import("@openrouter/spawn-shared");

    let callCount = 0;
    const sawCurl = {
      hit: false,
    };
    const sawHdiutilAttach = {
      hit: false,
    };
    const sawCp = {
      hit: false,
    };
    const sawHdiutilDetach = {
      hit: false,
    };

    const spy = spyOn(Bun, "spawnSync").mockImplementation((...args: unknown[]) => {
      callCount++;
      const argv = Array.isArray(args[0]) ? args[0] : [];
      const ok = {
        exitCode: 0,
        stdout: new TextEncoder().encode(argv[0] === "uname" ? "arm64\n" : ""),
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

      // Track which steps of the DMG installer ran.
      if (argv[0] === "curl") {
        sawCurl.hit = true;
        // Write a fake DMG large enough to pass the >1MB sanity check.
        const outIdx = argv.indexOf("-o");
        const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
        if (isString(outPath)) {
          writeFileSync(outPath, Buffer.alloc(2_000_000));
        }
      }
      if (argv[0] === "hdiutil" && argv[1] === "attach") {
        sawHdiutilAttach.hit = true;
      }
      if (argv[0] === "cp") {
        sawCp.hit = true;
      }
      if (argv[0] === "hdiutil" && argv[1] === "detach") {
        sawHdiutilDetach.hit = true;
      }

      // 1: docker info → fail, 2: which docker → fail, 3: which brew → fail.
      if (callCount <= 3) {
        return fail;
      }
      // Everything else (uname, curl, hdiutil, cp, xattr, open, docker info) → ok.
      return ok;
    });

    await ensureDocker();

    expect(sawCurl.hit).toBe(true);
    expect(sawHdiutilAttach.hit).toBe(true);
    expect(sawCp.hit).toBe(true);
    expect(sawHdiutilDetach.hit).toBe(true);

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
    // Mock Bun.spawn for runLocalArgs calls (array-based, no shell)
    const spawnSpy = mockBunSpawn(0);

    await pullAndStartContainer("claude");

    // First spawnSync call: docker rm -f spawn-agent (cleanup)
    expect(syncSpy.mock.calls[0][0]).toEqual([
      "docker",
      "rm",
      "-f",
      "spawn-agent",
    ]);

    // Bun.spawn calls: docker pull, docker run (array args, no shell)
    const spawnCalls = spawnSpy.mock.calls;
    expect(spawnCalls.length).toBe(2);

    // Pull command — passed as array directly, not through a shell
    expect(spawnCalls[0][0]).toEqual([
      "docker",
      "pull",
      "ghcr.io/openrouterteam/spawn-claude:latest",
    ]);

    // Run command — passed as array directly, not through a shell
    expect(spawnCalls[1][0]).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "spawn-agent",
      "ghcr.io/openrouterteam/spawn-claude:latest",
    ]);

    syncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── runLocalArgs ──────────────────────────────────────────────────────────

describe("runLocalArgs", () => {
  it("spawns command with array args (no shell interpretation)", async () => {
    const spawnSpy = mockBunSpawn(0);
    await runLocalArgs([
      "echo",
      "hello",
      "world",
    ]);
    expect(spawnSpy.mock.calls[0][0]).toEqual([
      "echo",
      "hello",
      "world",
    ]);
    spawnSpy.mockRestore();
  });

  it("throws on non-zero exit code", async () => {
    const spawnSpy = mockBunSpawn(1);
    expect(
      runLocalArgs([
        "false",
      ]),
    ).rejects.toThrow("Command failed (exit 1): false");
    spawnSpy.mockRestore();
  });

  it("does not interpret shell metacharacters in arguments", async () => {
    const spawnSpy = mockBunSpawn(0);
    await runLocalArgs([
      "echo",
      "$(whoami)",
      "; rm -rf /",
    ]);
    // Args are passed directly, not through a shell
    expect(spawnSpy.mock.calls[0][0]).toEqual([
      "echo",
      "$(whoami)",
      "; rm -rf /",
    ]);
    spawnSpy.mockRestore();
  });
});

// ─── runLocal command validation ────────────────────────────────────────────

describe("runLocal", () => {
  it("rejects empty command", async () => {
    await expect(runLocal("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    await expect(runLocal("echo\x00hello")).rejects.toThrow("Invalid command");
  });

  it("runs shell command and resolves on success", async () => {
    const spawnSpy = mockBunSpawn(0);
    await runLocal("echo hello");
    expect(spawnSpy).toHaveBeenCalled();
    spawnSpy.mockRestore();
  });

  it("throws on non-zero exit code", async () => {
    const spawnSpy = mockBunSpawn(1);
    await expect(runLocal("failing-cmd")).rejects.toThrow("Command failed");
    spawnSpy.mockRestore();
  });
});

// ─── interactiveSession command validation ──────────────────────────────────

describe("local/interactiveSession", () => {
  it("rejects empty command", async () => {
    await expect(interactiveSession("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    await expect(interactiveSession("echo\x00hi")).rejects.toThrow("Invalid command");
  });
});

// ─── dockerInteractiveSession command validation ────────────────────────────

describe("dockerInteractiveSession", () => {
  it("rejects empty command", async () => {
    await expect(dockerInteractiveSession("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    await expect(dockerInteractiveSession("echo\x00hi")).rejects.toThrow("Invalid command");
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

// ─── sandbox runner isolation ───────────────────────────────────────────────

describe("sandbox agent runner isolation", () => {
  it("agent.configure() uses Docker runner, not host runner, when sandbox is active", async () => {
    const { createCloudAgents } = await import("../shared/agent-setup");
    const { makeDockerRunner } = await import("../shared/orchestrate");

    const hostCommands: string[] = [];
    const hostRunner = {
      runServer: async (cmd: string) => {
        hostCommands.push(cmd);
      },
      uploadFile: async (_l: string, _r: string) => {},
      downloadFile: async (_r: string, _l: string) => {},
    };

    // Create agents with Docker-wrapped runner (as sandbox mode does)
    const dockerRunner = makeDockerRunner(hostRunner);
    const { resolveAgent: resolve } = createCloudAgents(dockerRunner);
    const agent = resolve("claude");

    // Run configure — it should use the Docker runner
    if (agent.configure) {
      await agent.configure("test-key");
    }

    // All commands from configure should go through docker exec
    const nonDockerCmds = hostCommands.filter((cmd) => !cmd.includes("docker"));
    expect(nonDockerCmds).toEqual([]);

    // At least one command should contain "docker exec" or "docker cp"
    const dockerCmds = hostCommands.filter((cmd) => cmd.includes("docker exec") || cmd.includes("docker cp"));
    expect(dockerCmds.length).toBeGreaterThan(0);
  });

  it("agent.configure() uses host runner directly without sandbox", async () => {
    const { createCloudAgents } = await import("../shared/agent-setup");

    const hostCommands: string[] = [];
    const hostRunner = {
      runServer: async (cmd: string) => {
        hostCommands.push(cmd);
      },
      uploadFile: async (_l: string, _r: string) => {},
      downloadFile: async (_r: string, _l: string) => {},
    };

    const { resolveAgent: resolve } = createCloudAgents(hostRunner);
    const agent = resolve("claude");

    if (agent.configure) {
      await agent.configure("test-key");
    }

    // Without sandbox, commands run directly (no docker wrapping)
    const dockerCmds = hostCommands.filter((cmd) => cmd.includes("docker exec"));
    expect(dockerCmds).toEqual([]);
  });
});

// ─── validateAgentName ─────────────────────────────────────────────────────

describe("validateAgentName", () => {
  it("accepts valid lowercase alphanumeric names", () => {
    expect(validateAgentName("claude")).toBe("claude");
    expect(validateAgentName("codex-cli")).toBe("codex-cli");
    expect(validateAgentName("open-code")).toBe("open-code");
    expect(validateAgentName("agent123")).toBe("agent123");
  });

  it("rejects empty string", () => {
    expect(() => validateAgentName("")).toThrow("must not be empty");
  });

  it("rejects names with uppercase characters", () => {
    expect(() => validateAgentName("Claude")).toThrow("must match");
  });

  it("rejects names with shell metacharacters", () => {
    expect(() => validateAgentName("claude;rm -rf /")).toThrow("must match");
    expect(() => validateAgentName("agent$(whoami)")).toThrow("must match");
    expect(() => validateAgentName("agent`id`")).toThrow("must match");
  });

  it("rejects names with path traversal", () => {
    expect(() => validateAgentName("../etc/passwd")).toThrow("must match");
    expect(() => validateAgentName("agent/../../root")).toThrow("must match");
  });

  it("rejects names with spaces", () => {
    expect(() => validateAgentName("my agent")).toThrow("must match");
  });
});

// ─── validateLocalPath ─────────────────────────────────────────────────────

describe("validateLocalPath", () => {
  it("accepts normal absolute paths", () => {
    const result = validateLocalPath("/tmp/file.txt");
    expect(result).toBe("/tmp/file.txt");
  });

  it("expands ~ to home directory", () => {
    const home = process.env.HOME ?? "";
    const result = validateLocalPath("~/file.txt");
    expect(result).toBe(`${home}/file.txt`);
  });

  it("expands $HOME to home directory", () => {
    const home = process.env.HOME ?? "";
    const result = validateLocalPath("$HOME/file.txt");
    expect(result).toBe(`${home}/file.txt`);
  });

  it("rejects paths with .. traversal", () => {
    expect(() => validateLocalPath("/home/user/../../../etc/passwd")).toThrow("path traversal");
  });

  it("rejects $HOME with .. traversal", () => {
    expect(() => validateLocalPath("$HOME/../etc/passwd")).toThrow("path traversal");
  });

  it("rejects ~ with .. traversal", () => {
    expect(() => validateLocalPath("~/../etc/shadow")).toThrow("path traversal");
  });
});

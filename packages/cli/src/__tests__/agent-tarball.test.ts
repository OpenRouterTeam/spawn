/**
 * agent-tarball.test.ts — Tests for pre-built tarball install logic.
 *
 * Verifies that tryTarballInstall:
 * - Queries the correct GitHub Release tag
 * - Runs curl | tar on the remote via runner.runServer
 * - Returns false when the release doesn't exist
 * - Returns false when runner.runServer throws
 * - Rejects URLs with shell injection characters
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

// NOTE: We do NOT mock ../shared/ui here because Bun's mock.module is
// process-global and would bleed into orchestrate.test.ts (which needs the
// real Ok/Err exports). Instead we suppress stderr with a spy in beforeEach.

const { tryTarballInstall } = await import("../shared/agent-tarball");

// ── Helpers ──────────────────────────────────────────────────────────────

function createMockRunner() {
  return {
    runServer: mock(() => Promise.resolve()),
    uploadFile: mock(() => Promise.resolve()),
  };
}

const RELEASE_PAYLOAD = {
  assets: [
    {
      name: "spawn-agent-openclaw-x86_64-20260305.tar.gz",
      browser_download_url:
        "https://github.com/OpenRouterTeam/spawn/releases/download/agent-openclaw-latest/spawn-agent-openclaw-x86_64-20260305.tar.gz",
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("tryTarballInstall", () => {
  let originalFetch: typeof global.fetch;
  let stderrSpy: ReturnType<typeof spyOn>;
  let capturedFetchUrl: string;

  beforeEach(() => {
    capturedFetchUrl = "";
    originalFetch = global.fetch;
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    stderrSpy.mockRestore();
  });

  it("queries correct GitHub Release tag", async () => {
    global.fetch = mock(async (url: string | URL | Request) => {
      capturedFetchUrl = String(url);
      return new Response(JSON.stringify(RELEASE_PAYLOAD));
    });
    const runner = createMockRunner();

    await tryTarballInstall(runner, "openclaw");

    expect(capturedFetchUrl).toContain("/releases/tags/agent-openclaw-latest");
  });

  it("runs curl | tar xz -C / on the remote VM", async () => {
    global.fetch = mock(async () => new Response(JSON.stringify(RELEASE_PAYLOAD)));
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw");

    expect(result).toBe(true);
    expect(runner.runServer).toHaveBeenCalledTimes(1);
    const cmd = String(runner.runServer.mock.calls[0][0]);
    expect(cmd).toContain("curl -fsSL");
    expect(cmd).toContain("tar xz -C /");
    expect(cmd).toContain(".spawn-tarball");
  });

  it("returns false when release does not exist (404)", async () => {
    global.fetch = mock(
      async () =>
        new Response("Not Found", {
          status: 404,
        }),
    );
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "nonexistent");

    expect(result).toBe(false);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("returns false when runner.runServer throws", async () => {
    global.fetch = mock(async () => new Response(JSON.stringify(RELEASE_PAYLOAD)));
    const runner = createMockRunner();
    runner.runServer.mockImplementation(() => Promise.reject(new Error("SSH connection refused")));

    const result = await tryTarballInstall(runner, "openclaw");

    expect(result).toBe(false);
  });

  it("returns false when release has no .tar.gz asset", async () => {
    const noTarball = {
      assets: [
        {
          name: "README.md",
          browser_download_url: "https://example.com",
        },
      ],
    };
    global.fetch = mock(async () => new Response(JSON.stringify(noTarball)));
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw");

    expect(result).toBe(false);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("returns false when release response has unexpected format", async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            unexpected: true,
          }),
        ),
    );
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw");

    expect(result).toBe(false);
  });

  it("returns false when URL contains shell injection characters", async () => {
    const malicious = {
      assets: [
        {
          name: "evil.tar.gz",
          browser_download_url: "https://github.com/x/y/releases/download/v1/a.tar.gz'; rm -rf / ; echo '",
        },
      ],
    };
    global.fetch = mock(async () => new Response(JSON.stringify(malicious)));
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw");

    expect(result).toBe(false);
    expect(runner.runServer).not.toHaveBeenCalled();
  });
});

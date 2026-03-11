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

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// Suppress stderr (logStep/logWarn) with a spy in beforeEach.

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
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  /** Create a mock fetch that returns the given response. */
  function mockFetch(response: Response): typeof fetch {
    return mock(async () => response);
  }

  /** Create a mock fetch that captures the URL and returns the given response. */
  function mockFetchCapture(response: Response): {
    fetchFn: typeof fetch;
    getUrl: () => string;
  } {
    let url = "";
    const fetchFn: typeof fetch = mock(async (input: string | URL | Request) => {
      url = String(input);
      return response;
    });
    return {
      fetchFn,
      getUrl: () => url,
    };
  }

  it("queries correct GitHub Release tag", async () => {
    const { fetchFn, getUrl } = mockFetchCapture(new Response(JSON.stringify(RELEASE_PAYLOAD)));
    const runner = createMockRunner();

    await tryTarballInstall(runner, "openclaw", fetchFn);

    expect(getUrl()).toContain("/releases/tags/agent-openclaw-latest");
  });

  it("runs curl | tar xz -C / on the remote VM", async () => {
    const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw", fetchFn);

    expect(result).toBe(true);
    // 2 calls: download+extract, then mirror files for non-root users
    expect(runner.runServer).toHaveBeenCalledTimes(2);
    const cmd = String(runner.runServer.mock.calls[0][0]);
    expect(cmd).toContain("curl -fsSL");
    expect(cmd).toContain("tar xz -C /");
    expect(cmd).toContain(".spawn-tarball");
    const mirrorCmd = String(runner.runServer.mock.calls[1][0]);
    expect(mirrorCmd).toContain("cp -a");
  });

  it("returns false when release does not exist (404)", async () => {
    const fetchFn = mockFetch(
      new Response("Not Found", {
        status: 404,
      }),
    );
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "nonexistent", fetchFn);

    expect(result).toBe(false);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("returns false when runner.runServer throws", async () => {
    const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
    const runner = createMockRunner();
    runner.runServer.mockImplementation(() => Promise.reject(new Error("SSH connection refused")));

    const result = await tryTarballInstall(runner, "openclaw", fetchFn);

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
    const fetchFn = mockFetch(new Response(JSON.stringify(noTarball)));
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw", fetchFn);

    expect(result).toBe(false);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  it("returns false when release response has unexpected format", async () => {
    const fetchFn = mockFetch(
      new Response(
        JSON.stringify({
          unexpected: true,
        }),
      ),
    );
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw", fetchFn);

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
    const fetchFn = mockFetch(new Response(JSON.stringify(malicious)));
    const runner = createMockRunner();

    const result = await tryTarballInstall(runner, "openclaw", fetchFn);

    expect(result).toBe(false);
    expect(runner.runServer).not.toHaveBeenCalled();
  });

  describe("non-root home directory mirroring", () => {
    it("mirrors dotfiles from /root/ to $HOME for non-root users", async () => {
      const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
      const runner = createMockRunner();

      await tryTarballInstall(runner, "openclaw", fetchFn);

      const mirrorCmd = String(runner.runServer.mock.calls[1][0]);
      expect(mirrorCmd).toContain("cp -a");
      expect(mirrorCmd).toContain('"$HOME/$_d"');
      for (const dir of [
        ".claude",
        ".local",
        ".npm-global",
        ".cargo",
        ".opencode",
        ".hermes",
        ".bun",
      ]) {
        expect(mirrorCmd).toContain(dir);
      }
    });

    it("mirrors the .spawn-tarball marker file", async () => {
      const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
      const runner = createMockRunner();

      await tryTarballInstall(runner, "openclaw", fetchFn);

      const mirrorCmd = String(runner.runServer.mock.calls[1][0]);
      expect(mirrorCmd).toContain('cp /root/.spawn-tarball "$HOME/.spawn-tarball"');
    });

    it("returns true even when mirror step fails (non-fatal)", async () => {
      const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
      const runner = createMockRunner();
      runner.runServer.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("cp failed"));

      const result = await tryTarballInstall(runner, "openclaw", fetchFn);

      expect(result).toBe(true);
    });

    it("guards mirror behind non-root check (id -u)", async () => {
      const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
      const runner = createMockRunner();

      await tryTarballInstall(runner, "openclaw", fetchFn);

      const mirrorCmd = String(runner.runServer.mock.calls[1][0]);
      expect(mirrorCmd).toContain('if [ "$(id -u)" != "0" ]; then');
    });

    it("fixes ownership of mirrored files with chown", async () => {
      const fetchFn = mockFetch(new Response(JSON.stringify(RELEASE_PAYLOAD)));
      const runner = createMockRunner();

      await tryTarballInstall(runner, "openclaw", fetchFn);

      const mirrorCmd = String(runner.runServer.mock.calls[1][0]);
      expect(mirrorCmd).toContain('chown -R "$(id -u):$(id -g)"');
    });
  });
});

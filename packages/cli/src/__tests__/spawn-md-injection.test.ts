/**
 * spawn-md-injection.test.ts — Verifies that applySpawnMdSetup base64-encodes
 * API key values to prevent shell injection via /etc/spawn/secrets.
 *
 * Regression test for #3361.
 */

import type { CloudRunner } from "../shared/agent-setup.js";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

describe("applySpawnMdSetup api_key injection safety", () => {
  let capturedCommands: string[] = [];
  let mockRunner: CloudRunner;
  let stderrSpy: ReturnType<typeof spyOn>;
  let savedIsTTY: boolean | undefined;
  let stdinOnSpy: ReturnType<typeof spyOn>;
  let stdinResumeSpy: ReturnType<typeof spyOn>;
  let stdinPauseSpy: ReturnType<typeof spyOn>;
  let stdinSetRawModeSpy: ReturnType<typeof spyOn>;
  let stdinRemoveListenerSpy: ReturnType<typeof spyOn>;

  // A value designed to break out of shell quoting contexts
  const MALICIOUS_KEY = '"; rm -rf /; echo "pwned\n$HOME\n$(whoami)';

  beforeEach(() => {
    capturedCommands = [];
    mockRunner = {
      runServer: mock(async (cmd: string) => {
        capturedCommands.push(cmd);
      }),
      uploadFile: mock(async () => {}),
      downloadFile: mock(async () => {}),
    };

    // Suppress stderr output from promptSecret / logInfo
    stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);

    // Make stdin appear as a TTY so promptSecret doesn't bail with ""
    savedIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // Mock setRawMode — define it first if missing (non-TTY stdin lacks it)
    if (typeof process.stdin.setRawMode !== "function") {
      Object.defineProperty(process.stdin, "setRawMode", {
        value: () => process.stdin,
        configurable: true,
        writable: true,
      });
    }
    stdinSetRawModeSpy = spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
    stdinResumeSpy = spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
    stdinPauseSpy = spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
    stdinRemoveListenerSpy = spyOn(process.stdin, "removeListener").mockReturnValue(process.stdin);

    // When promptSecret calls process.stdin.on("data", handler), immediately
    // feed the malicious value followed by a newline to resolve the promise.
    stdinOnSpy = spyOn(process.stdin, "on").mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          queueMicrotask(() => {
            handler(Buffer.from(MALICIOUS_KEY));
            handler(Buffer.from("\n"));
          });
        }
        return process.stdin;
      },
    );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedIsTTY,
      configurable: true,
    });
    stdinOnSpy.mockRestore();
    stdinSetRawModeSpy.mockRestore();
    stdinResumeSpy.mockRestore();
    stdinPauseSpy.mockRestore();
    stdinRemoveListenerSpy.mockRestore();
  });

  it("stores api_key values as base64, never raw shell-interpolatable strings", async () => {
    const { applySpawnMdSetup } = await import("../shared/spawn-md.js");

    await applySpawnMdSetup(
      mockRunner,
      {
        setup: [
          {
            type: "api_key",
            name: "MY_SECRET_KEY",
          },
        ],
      },
      "test-agent",
    );

    // The first runServer call writes to /etc/spawn/secrets
    expect(capturedCommands.length).toBeGreaterThanOrEqual(1);
    const secretsCmd = capturedCommands[0];

    // The raw malicious value must NOT appear anywhere in the command
    expect(secretsCmd).not.toContain("rm -rf");
    expect(secretsCmd).not.toContain("$(whoami)");
    expect(secretsCmd).not.toContain("$HOME");
    // No shell-executable export statement
    expect(secretsCmd).not.toContain("export ");

    // The command should use base64 encoding — verify the value is valid base64
    const expectedB64 = Buffer.from(MALICIOUS_KEY).toString("base64");
    expect(secretsCmd).toContain(expectedB64);

    // The format should be printf '%s=%s\n' 'NAME' 'B64VALUE'
    expect(secretsCmd).toContain("printf '%s=%s\\n'");
    expect(secretsCmd).toContain("'MY_SECRET_KEY'");

    // The second command should install the base64 loader, not a direct source
    expect(capturedCommands.length).toBeGreaterThanOrEqual(2);
    const loaderCmd = capturedCommands[1];
    expect(loaderCmd).toContain("while IFS");
    expect(loaderCmd).toContain("base64 -d");
    // Must NOT contain the old vulnerable pattern
    expect(loaderCmd).not.toContain("source /etc/spawn/secrets");
  });

  it("sanitizes step name to alphanumeric + underscore only", async () => {
    const { applySpawnMdSetup } = await import("../shared/spawn-md.js");

    await applySpawnMdSetup(
      mockRunner,
      {
        setup: [
          {
            type: "api_key",
            name: "MY;DROP$(evil)KEY",
          },
        ],
      },
      "test-agent",
    );

    expect(capturedCommands.length).toBeGreaterThanOrEqual(1);
    const secretsCmd = capturedCommands[0];

    // The escaped name should only contain [A-Za-z0-9_]
    expect(secretsCmd).toContain("'MYDROPevilKEY'");
    // The dangerous characters from the name must not appear unescaped
    expect(secretsCmd).not.toContain(";DROP");
    expect(secretsCmd).not.toContain("$(evil)");
  });
});

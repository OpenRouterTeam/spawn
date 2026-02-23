import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { preflightCredentialCheck } from "../commands";
import type { Manifest } from "../manifest";

// Mock @clack/prompts
const mockLog = {
  warn: mock(() => {}),
  info: mock(() => {}),
};
const mockConfirm = mock(() => Promise.resolve(true));
const mockIsCancel = mock(() => false);
mock.module("@clack/prompts", () => ({
  log: mockLog,
  confirm: mockConfirm,
  isCancel: mockIsCancel,
  // Stubs for other imports commands.ts might use
  intro: mock(() => {}),
  outro: mock(() => {}),
  select: mock(() => Promise.resolve("")),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  spinner: mock(() => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  })),
}));

function makeManifest(cloudAuth: string): Manifest {
  const m: Manifest = {
    agents: {},
    clouds: {
      testcloud: {
        name: "Test Cloud",
        description: "A test cloud",
        url: "https://test.cloud",
        type: "vps",
        auth: cloudAuth,
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: {},
  };
  return m;
}

describe("preflightCredentialCheck", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function clearEnv(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.info.mockClear();
    mockConfirm.mockClear();
    mockIsCancel.mockClear();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  it("should not warn when all credentials are set", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    setEnv("HCLOUD_TOKEN", "test-token");
    const manifest = makeManifest("HCLOUD_TOKEN");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("should not warn when cloud auth is 'none'", async () => {
    clearEnv("OPENROUTER_API_KEY");
    const manifest = makeManifest("none");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("should warn when cloud-specific credential is missing", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    clearEnv("HCLOUD_TOKEN");
    const manifest = makeManifest("HCLOUD_TOKEN");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(mockLog.warn.mock.calls[0][0]);
    expect(warnMsg).toContain("HCLOUD_TOKEN");
    expect(warnMsg).toContain("Test Cloud");
  });

  it("should warn when OPENROUTER_API_KEY is missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    setEnv("HCLOUD_TOKEN", "test-token");
    const manifest = makeManifest("HCLOUD_TOKEN");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(mockLog.warn.mock.calls[0][0]);
    expect(warnMsg).toContain("OPENROUTER_API_KEY");
  });

  it("should warn about multiple missing credentials", async () => {
    clearEnv("OPENROUTER_API_KEY");
    clearEnv("HCLOUD_TOKEN");
    const manifest = makeManifest("HCLOUD_TOKEN");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(mockLog.warn.mock.calls[0][0]);
    expect(warnMsg).toContain("OPENROUTER_API_KEY");
    expect(warnMsg).toContain("HCLOUD_TOKEN");
  });

  it("should show setup instructions hint", async () => {
    clearEnv("HCLOUD_TOKEN");
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    const manifest = makeManifest("HCLOUD_TOKEN");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.info).toHaveBeenCalled();
    const infoMsg = String(mockLog.info.mock.calls[0][0]);
    expect(infoMsg).toContain("spawn testcloud");
  });

  it("should handle multi-credential clouds with partial setup", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    setEnv("UPCLOUD_USERNAME", "user");
    clearEnv("UPCLOUD_PASSWORD");
    const manifest = makeManifest("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(mockLog.warn.mock.calls[0][0]);
    expect(warnMsg).toContain("UPCLOUD_PASSWORD");
    expect(warnMsg).not.toContain("UPCLOUD_USERNAME");
  });

  it("should not warn for CLI-based auth like 'gcloud auth login'", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-test");
    const manifest = makeManifest("gcloud auth login");

    // gcloud auth login doesn't parse to any env vars, so auth check returns "none"-like
    // But OPENROUTER_API_KEY is set so no warning
    await preflightCredentialCheck(manifest, "testcloud");

    // No env vars parsed from "gcloud auth login", only OPENROUTER_API_KEY check
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("should warn for CLI-based auth when OPENROUTER_API_KEY is missing", async () => {
    clearEnv("OPENROUTER_API_KEY");
    const manifest = makeManifest("gcloud auth login");

    await preflightCredentialCheck(manifest, "testcloud");

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(mockLog.warn.mock.calls[0][0]);
    expect(warnMsg).toContain("OPENROUTER_API_KEY");
  });
});

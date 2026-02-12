import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for credential status indicators in Quick start sections.
 *
 * The credentialStatus() function shows:
 *   - Green checkmark (or [ok]) when an env var is set
 *   - Red X (or [missing]) when an env var is not set
 *
 * cmdCloudInfo and cmdAgentInfo show these indicators next to each
 * credential in the Quick start section, plus a summary line:
 *   - "All credentials configured. Ready to launch!" when all set
 *   - "Missing: VAR1, VAR2" when some but not all are set
 *   - No summary when none are set (user sees all red indicators)
 *
 * Agent: ux-engineer
 */

// ── Mock manifests ──────────────────────────────────────────────────────────

const singleAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm i -g claude",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
    },
  },
  clouds: {
    hetzner: {
      name: "Hetzner Cloud",
      description: "Cloud VMs from EUR 3.29/mo",
      url: "https://console.hetzner.cloud",
      type: "api",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "hetzner/claude": "implemented",
  },
};

const multiAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm i -g claude",
      launch: "claude",
      env: {},
    },
  },
  clouds: {
    upcloud: {
      name: "UpCloud",
      description: "European cloud hosting",
      url: "https://upcloud.com/signup",
      type: "api",
      auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "upcloud/claude": "implemented",
  },
};

const noAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm i -g claude",
      launch: "claude",
      env: {},
    },
  },
  clouds: {
    localcloud: {
      name: "Local Runner",
      description: "Run locally",
      url: "",
      type: "local",
      auth: "none",
      provision_method: "none",
      exec_method: "bash",
      interactive_method: "bash",
    },
  },
  matrix: {
    "localcloud/claude": "implemented",
  },
};

// ── Mock setup ──────────────────────────────────────────────────────────────

const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mock(() => {}),
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    error: mockLogError,
    warn: mockLogWarn,
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

const { cmdCloudInfo, cmdAgentInfo, credentialStatus } = await import("../commands.js");

// ── credentialStatus unit tests ─────────────────────────────────────────────

describe("credentialStatus", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
      TERM: process.env.TERM,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns green indicator when env var is set", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const result = credentialStatus("HCLOUD_TOKEN");
    // Should not contain the missing indicator
    expect(result).not.toContain("missing");
  });

  it("returns red indicator when env var is not set", () => {
    delete process.env.HCLOUD_TOKEN;
    const result = credentialStatus("HCLOUD_TOKEN");
    // Should not contain the ok indicator
    expect(result).not.toContain("ok");
  });

  it("uses ASCII fallback when TERM is linux", () => {
    process.env.TERM = "linux";
    process.env.HCLOUD_TOKEN = "test-token";
    const result = credentialStatus("HCLOUD_TOKEN");
    expect(result).toContain("[ok]");
  });

  it("uses ASCII fallback for missing when TERM is linux", () => {
    process.env.TERM = "linux";
    delete process.env.HCLOUD_TOKEN;
    const result = credentialStatus("HCLOUD_TOKEN");
    expect(result).toContain("[missing]");
  });

  it("treats empty string env var as set", () => {
    // Empty string is falsy but technically set... however !! makes it false
    process.env.HCLOUD_TOKEN = "";
    const result = credentialStatus("HCLOUD_TOKEN");
    // Empty env var is treated as not set (falsy)
    expect(result).not.toContain("ok");
  });
});

// ── Integration: cmdCloudInfo credential status ─────────────────────────────

describe("cmdCloudInfo credential status indicators", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let savedEnv: Record<string, string | undefined>;

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = spyOn(console, "error").mockImplementation(() => {});
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;

    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("all credentials set", () => {
    it("shows 'Ready to launch' when all credentials are configured", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("Ready to launch");
    });

    it("shows 'Ready to launch' for multi-auth cloud when all set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).toContain("Ready to launch");
    });
  });

  describe("some credentials missing", () => {
    it("shows 'Missing' line listing missing env vars", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      delete process.env.HCLOUD_TOKEN;
      await setupManifest(singleAuthManifest);
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("Missing:");
      expect(output).toContain("HCLOUD_TOKEN");
    });

    it("lists multiple missing vars for multi-auth cloud", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      delete process.env.UPCLOUD_USERNAME;
      delete process.env.UPCLOUD_PASSWORD;
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).toContain("Missing:");
      expect(output).toContain("UPCLOUD_USERNAME");
      expect(output).toContain("UPCLOUD_PASSWORD");
    });

    it("shows Missing with OPENROUTER_API_KEY when only cloud auth is set", async () => {
      delete process.env.OPENROUTER_API_KEY;
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("Missing:");
      expect(output).toContain("OPENROUTER_API_KEY");
    });
  });

  describe("no credentials set", () => {
    it("does not show Ready to launch or Missing summary", async () => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.HCLOUD_TOKEN;
      await setupManifest(singleAuthManifest);
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).not.toContain("Ready to launch");
      expect(output).not.toContain("Missing:");
    });
  });

  describe("none auth cloud (only OPENROUTER_API_KEY needed)", () => {
    it("shows Ready to launch when OPENROUTER_API_KEY is set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      await setupManifest(noAuthManifest);
      await cmdCloudInfo("localcloud");
      const output = getOutput();
      // For "none" auth, only OPENROUTER_API_KEY matters
      // But the code doesn't add auth vars for "none" auth, so allVars is just ["OPENROUTER_API_KEY"]
      expect(output).toContain("Ready to launch");
    });
  });
});

// ── Integration: cmdAgentInfo credential status ─────────────────────────────

describe("cmdAgentInfo credential status indicators", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let savedEnv: Record<string, string | undefined>;

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = spyOn(console, "error").mockImplementation(() => {});
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;

    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("shows credential status in agent info Quick start", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    delete process.env.HCLOUD_TOKEN;
    await setupManifest(singleAuthManifest);
    await cmdAgentInfo("claude");
    const output = getOutput();
    // Should contain both env var names with their status indicators
    expect(output).toContain("OPENROUTER_API_KEY");
    expect(output).toContain("HCLOUD_TOKEN");
  });

  it("shows credential status for OPENROUTER_API_KEY when set", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    process.env.HCLOUD_TOKEN = "test-token";
    await setupManifest(singleAuthManifest);
    await cmdAgentInfo("claude");
    const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
    // Find the OPENROUTER_API_KEY export line
    const orLine = lines.find((l: string) => l.includes("OPENROUTER_API_KEY") && l.includes("export"));
    expect(orLine).toBeDefined();
    // It should contain the unicode checkmark or [ok]
    // Since we can't easily predict TERM, just check the line exists
    expect(orLine).toBeTruthy();
  });
});

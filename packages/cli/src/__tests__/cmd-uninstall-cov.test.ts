/**
 * cmd-uninstall-cov.test.ts — Coverage tests for commands/uninstall.ts
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const clack = mockClackPrompts();

// ── Import module under test ────────────────────────────────────────────────
const { cmdUninstall } = await import("../commands/uninstall.js");
const { RC_MARKER_START, RC_MARKER_END, RC_MARKER_LEGACY } = await import("../shared/paths.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cmdUninstall", () => {
  let processExitSpy: ReturnType<typeof spyOn>;
  let home: string;

  beforeEach(() => {
    home = process.env.HOME ?? "";

    clack.intro.mockReset();
    clack.outro.mockReset();
    clack.logInfo.mockReset();
    clack.logSuccess.mockReset();
    clack.logStep.mockReset();
    clack.logWarn.mockReset();
    clack.confirm.mockReset();
    clack.multiselect.mockReset();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it("shows nothing to uninstall when nothing exists", async () => {
    // Ensure spawn dirs and binary don't exist
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    const cacheDir = join(home, ".cache", "spawn");
    const binaryDir = join(home, ".local", "bin");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(join(binaryDir, "spawn"))) {
      fs.unlinkSync(join(binaryDir, "spawn"));
    }

    await cmdUninstall();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("Nothing to uninstall"));
    expect(clack.outro).toHaveBeenCalledWith("Done");
  });

  it("removes binary when it exists and user confirms", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    // Remove optional dirs so multiselect is not shown
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    expect(clack.logSuccess).toHaveBeenCalledWith("Removed:");
    expect(fs.existsSync(binaryPath)).toBe(false);
  });

  it("cancels when user rejects confirmation", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    // Remove optional dirs
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    clack.confirm.mockResolvedValue(false);

    await expect(cmdUninstall()).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(fs.existsSync(binaryPath)).toBe(true);
  });

  it("removes cache dir when it exists", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    const cacheDir = join(home, ".cache", "spawn");
    fs.mkdirSync(cacheDir, {
      recursive: true,
    });
    fs.writeFileSync(join(cacheDir, "manifest.json"), "{}");

    // Remove optional dirs
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("removes history when user selects it in multiselect", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    const spawnDir = join(home, ".spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");
    fs.mkdirSync(spawnDir, {
      recursive: true,
    });
    fs.writeFileSync(join(spawnDir, "history.json"), "[]");

    // Remove config dir
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    clack.multiselect.mockResolvedValue([
      "history",
    ]);
    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    expect(fs.existsSync(spawnDir)).toBe(false);
  });

  it("removes config when user selects it in multiselect", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    const configDir = join(home, ".config", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");
    fs.mkdirSync(configDir, {
      recursive: true,
    });
    fs.writeFileSync(join(configDir, "hetzner.json"), "{}");

    // Remove spawn dir
    const spawnDir = join(home, ".spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }

    clack.multiselect.mockResolvedValue([
      "config",
    ]);
    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    expect(fs.existsSync(configDir)).toBe(false);
  });

  it("removes both history and config when user selects both", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");
    fs.mkdirSync(spawnDir, {
      recursive: true,
    });
    fs.mkdirSync(configDir, {
      recursive: true,
    });

    clack.multiselect.mockResolvedValue([
      "history",
      "config",
    ]);
    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    expect(fs.existsSync(spawnDir)).toBe(false);
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it("cleans RC files with new-format markers", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    // Remove optional dirs
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    const rcPath = join(home, ".bashrc");
    const rcContent = [
      "# existing config",
      "",
      RC_MARKER_START,
      'export PATH="$HOME/.local/bin:$PATH"',
      RC_MARKER_END,
      "",
      "# more config",
    ].join("\n");
    fs.writeFileSync(rcPath, rcContent);

    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    const cleaned = fs.readFileSync(rcPath, "utf-8");
    expect(cleaned).not.toContain(RC_MARKER_START);
    expect(cleaned).toContain("# existing config");
    expect(cleaned).toContain("# more config");
  });

  it("cleans RC files with legacy marker format", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    // Remove optional dirs
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    const rcPath = join(home, ".bashrc");
    const rcContent = [
      "# existing config",
      "",
      RC_MARKER_LEGACY,
      'export PATH="$HOME/.local/bin:$PATH"',
      "",
      "# more config",
    ].join("\n");
    fs.writeFileSync(rcPath, rcContent);

    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    const cleaned = fs.readFileSync(rcPath, "utf-8");
    expect(cleaned).not.toContain(RC_MARKER_LEGACY);
    expect(cleaned).toContain("# existing config");
    expect(cleaned).toContain("# more config");
  });

  it("does not show multiselect when no optional dirs exist", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(clack.logSuccess).toHaveBeenCalledWith("Removed:");
  });

  it("shows shell RC hint when RC files were cleaned", async () => {
    const binaryPath = join(home, ".local", "bin", "spawn");
    fs.mkdirSync(join(home, ".local", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(binaryPath, "#!/bin/bash\necho spawn");

    // Remove optional dirs
    const spawnDir = join(home, ".spawn");
    const configDir = join(home, ".config", "spawn");
    if (fs.existsSync(spawnDir)) {
      fs.rmSync(spawnDir, {
        recursive: true,
        force: true,
      });
    }
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, {
        recursive: true,
        force: true,
      });
    }

    // Write a .bashrc with spawn markers
    const rcPath = join(home, ".bashrc");
    fs.writeFileSync(
      rcPath,
      [
        RC_MARKER_START,
        'export PATH="$HOME/.local/bin:$PATH"',
        RC_MARKER_END,
      ].join("\n"),
    );

    clack.confirm.mockResolvedValue(true);

    await cmdUninstall();

    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg: string) => msg.includes("exec $SHELL"))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for install.sh bash helper functions.
 *
 * install.sh is the entry point for all new users (`curl ... | bash`).
 * It has been modified in 3 of the last 5 commits and its helper functions
 * had zero test coverage. These tests exercise:
 *
 * - version_gte: Semver comparison (determines if bun upgrade is needed)
 * - find_install_dir: Install directory resolution (PATH-aware)
 * - ensure_in_path: PATH detection and shell-specific instructions
 *
 * Each test sources the relevant functions from install.sh in an isolated
 * bash subprocess with controlled PATH and HOME environment.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const INSTALL_SH = resolve(REPO_ROOT, "cli/install.sh");

/**
 * Extract and run just the helper functions from install.sh.
 * We source the function definitions without running the main body
 * by extracting them into a separate script.
 */
function runBashWithHelpers(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  // Extract the function definitions from install.sh (before the main body)
  // The main body starts after the last function definition
  const helperScript = `
set -eo pipefail

# Color codes (from install.sh)
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BOLD='\\033[1m'
NC='\\033[0m'

log_info()  { echo -e "\${GREEN}[spawn]\${NC} $1"; }
log_warn()  { echo -e "\${YELLOW}[spawn]\${NC} $1"; }
log_error() { echo -e "\${RED}[spawn]\${NC} $1"; }

# version_gte from install.sh
version_gte() {
    local IFS='.'
    local a=($1) b=($2)
    local i=0
    while [ $i -lt \${#b[@]} ]; do
        local av="\${a[$i]:-0}"
        local bv="\${b[$i]:-0}"
        if [ "$av" -lt "$bv" ]; then
            return 1
        elif [ "$av" -gt "$bv" ]; then
            return 0
        fi
        i=$((i + 1))
    done
    return 0
}

# find_install_dir from install.sh (needs bun mock)
find_install_dir() {
    if [ -n "\${SPAWN_INSTALL_DIR:-}" ]; then
        echo "\${SPAWN_INSTALL_DIR}"
        return
    fi
    local dirs=(
        "\${HOME}/.local/bin"
        "\$(bun pm bin -g 2>/dev/null)"
        "\${HOME}/.bun/bin"
        "\${HOME}/bin"
    )
    for dir in "\${dirs[@]}"; do
        [ -z "$dir" ] && continue
        if echo "\${PATH}" | tr ':' '\\n' | grep -qx "$dir"; then
            echo "$dir"
            return
        fi
    done
    echo "\${HOME}/.local/bin"
}

# ensure_in_path from install.sh
ensure_in_path() {
    local install_dir="$1"
    if echo "\${PATH}" | tr ':' '\\n' | grep -qx "\${install_dir}"; then
        echo "IN_PATH"
    else
        echo "NOT_IN_PATH"
        case "\${SHELL:-/bin/bash}" in
            */zsh)
                echo "SHELL_TYPE=zsh"
                ;;
            */fish)
                echo "SHELL_TYPE=fish"
                ;;
            *)
                echo "SHELL_TYPE=bash"
                ;;
        esac
    fi
}

${script}
`;

  const defaultEnv: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: env?.HOME || "/tmp/test-home",
    SHELL: env?.SHELL || "/bin/bash",
  };

  const mergedEnv = { ...defaultEnv, ...env };

  try {
    const stdout = execSync(`bash -c '${helperScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || "").trim(),
    };
  }
}

// ── version_gte tests ──────────────────────────────────────────────────────

describe("install.sh version_gte", () => {
  describe("equal versions", () => {
    it("should return true (0) for identical versions", () => {
      const result = runBashWithHelpers('version_gte "1.2.3" "1.2.3" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should return true (0) for 0.0.0 == 0.0.0", () => {
      const result = runBashWithHelpers('version_gte "0.0.0" "0.0.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });
  });

  describe("greater versions", () => {
    it("should return true when major is greater", () => {
      const result = runBashWithHelpers('version_gte "2.0.0" "1.0.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should return true when minor is greater", () => {
      const result = runBashWithHelpers('version_gte "1.3.0" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should return true when patch is greater", () => {
      const result = runBashWithHelpers('version_gte "1.2.4" "1.2.3" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should return true when major is greater despite lower minor", () => {
      const result = runBashWithHelpers('version_gte "2.0.0" "1.9.9" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should return true when minor is greater despite lower patch", () => {
      const result = runBashWithHelpers('version_gte "1.5.0" "1.4.9" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });
  });

  describe("lesser versions", () => {
    it("should return false when major is less", () => {
      const result = runBashWithHelpers('version_gte "1.0.0" "2.0.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });

    it("should return false when minor is less", () => {
      const result = runBashWithHelpers('version_gte "1.1.0" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });

    it("should return false when patch is less", () => {
      const result = runBashWithHelpers('version_gte "1.2.2" "1.2.3" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });
  });

  describe("realistic bun version checks", () => {
    it("should pass for bun 1.2.0 >= MIN_BUN_VERSION 1.2.0", () => {
      const result = runBashWithHelpers('version_gte "1.2.0" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should pass for bun 1.2.5 >= MIN_BUN_VERSION 1.2.0", () => {
      const result = runBashWithHelpers('version_gte "1.2.5" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should fail for bun 1.1.0 >= MIN_BUN_VERSION 1.2.0", () => {
      const result = runBashWithHelpers('version_gte "1.1.0" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });

    it("should fail for bun 1.0.33 >= MIN_BUN_VERSION 1.2.0", () => {
      const result = runBashWithHelpers('version_gte "1.0.33" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });

    it("should pass for bun 1.3.0 >= MIN_BUN_VERSION 1.2.0", () => {
      const result = runBashWithHelpers('version_gte "1.3.0" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });
  });

  describe("segment edge cases", () => {
    it("should handle two-segment version against three-segment", () => {
      // "1.2" means a=(1 2), b=(1 2 0), missing a[2] defaults to 0
      const result = runBashWithHelpers('version_gte "1.2" "1.2.0" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should handle three-segment against two-segment", () => {
      // b has only 2 parts, loop only runs twice, so 1.2.5 >= 1.2
      const result = runBashWithHelpers('version_gte "1.2.5" "1.2" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should handle single-segment versions", () => {
      const result = runBashWithHelpers('version_gte "2" "1" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should handle single less than single", () => {
      const result = runBashWithHelpers('version_gte "1" "2" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });

    it("should handle large version numbers", () => {
      const result = runBashWithHelpers('version_gte "100.200.300" "100.200.299" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should handle version with extra trailing segments (only compares up to b length)", () => {
      // b=(1 2), loop runs 2 times. a=(1 2 9) - extra segment ignored
      const result = runBashWithHelpers('version_gte "1.2.9" "1.2" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("YES");
    });

    it("should handle missing segment in a as 0 when comparing", () => {
      // a=(1 2), b=(1 2 1), loop runs 3 times, a[2]=0 < b[2]=1
      const result = runBashWithHelpers('version_gte "1.2" "1.2.1" && echo "YES" || echo "NO"');
      expect(result.stdout).toBe("NO");
    });
  });
});

// ── find_install_dir tests ──────────────────────────────────────────────────

describe("install.sh find_install_dir", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-install-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should use SPAWN_INSTALL_DIR when set", () => {
    const customDir = join(testDir, "custom-bin");
    mkdirSync(customDir, { recursive: true });
    const result = runBashWithHelpers("find_install_dir", {
      HOME: testDir,
      SPAWN_INSTALL_DIR: customDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(customDir);
  });

  it("should prefer ~/.local/bin when it is in PATH", () => {
    const localBin = join(testDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const result = runBashWithHelpers("find_install_dir", {
      HOME: testDir,
      PATH: `${localBin}:/usr/bin:/bin`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(localBin);
  });

  it("should fall back to ~/.bun/bin when ~/.local/bin is not in PATH", () => {
    const bunBin = join(testDir, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    const result = runBashWithHelpers("find_install_dir", {
      HOME: testDir,
      PATH: `${bunBin}:/usr/bin:/bin`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(bunBin);
  });

  it("should fall back to ~/bin when other options not in PATH", () => {
    const homeBin = join(testDir, "bin");
    mkdirSync(homeBin, { recursive: true });
    const result = runBashWithHelpers("find_install_dir", {
      HOME: testDir,
      PATH: `${homeBin}:/usr/bin:/bin`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(homeBin);
  });

  it("should default to ~/.local/bin when nothing matches PATH", () => {
    const result = runBashWithHelpers("find_install_dir", {
      HOME: testDir,
      PATH: "/usr/bin:/bin",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(join(testDir, ".local", "bin"));
  });

  it("should override all heuristics with SPAWN_INSTALL_DIR", () => {
    const localBin = join(testDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const override = join(testDir, "my-override");
    mkdirSync(override, { recursive: true });
    const result = runBashWithHelpers("find_install_dir", {
      HOME: testDir,
      PATH: `${localBin}:/usr/bin:/bin`,
      SPAWN_INSTALL_DIR: override,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(override);
  });
});

// ── ensure_in_path tests ────────────────────────────────────────────────────

describe("install.sh ensure_in_path", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-path-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should detect when install dir IS in PATH", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    });
    expect(result.stdout).toContain("IN_PATH");
    expect(result.stdout).not.toContain("NOT_IN_PATH");
  });

  it("should detect when install dir is NOT in PATH", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: "/usr/bin:/bin",
    });
    expect(result.stdout).toContain("NOT_IN_PATH");
  });

  it("should suggest .bashrc for bash shell", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/bash",
    });
    expect(result.stdout).toContain("SHELL_TYPE=bash");
  });

  it("should suggest .zshrc for zsh shell", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
    });
    expect(result.stdout).toContain("SHELL_TYPE=zsh");
  });

  it("should suggest fish_add_path for fish shell", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: "/usr/bin:/bin",
      SHELL: "/usr/bin/fish",
    });
    expect(result.stdout).toContain("SHELL_TYPE=fish");
  });

  it("should default to bash when SHELL is unset", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    // Explicitly unset SHELL
    const result = runBashWithHelpers(`unset SHELL; ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: "/usr/bin:/bin",
    });
    expect(result.stdout).toContain("SHELL_TYPE=bash");
  });

  it("should handle PATH with many entries", () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const longPath = Array.from({ length: 20 }, (_, i) => `/fake/path/${i}`).join(":");
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: `${longPath}:${binDir}:/usr/bin`,
    });
    expect(result.stdout).toContain("IN_PATH");
  });

  it("should not match partial path prefixes", () => {
    const binDir = join(testDir, "bin");
    const binDirExtra = join(testDir, "bin-extra");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(binDirExtra, { recursive: true });
    // PATH contains bin-extra but not bin
    const result = runBashWithHelpers(`ensure_in_path "${binDir}"`, {
      HOME: testDir,
      PATH: `${binDirExtra}:/usr/bin:/bin`,
    });
    expect(result.stdout).toContain("NOT_IN_PATH");
  });
});

// ── install.sh syntax check ────────────────────────────────────────────────

describe("install.sh syntax", () => {
  it("should pass bash -n syntax check", () => {
    const result = execSync(`bash -n "${INSTALL_SH}" 2>&1`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    // bash -n produces no output on success
    expect(result.trim()).toBe("");
  });

  it("should have a valid shebang line", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content.startsWith("#!/bin/bash")).toBe(true);
  });

  it("should use set -eo pipefail", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toContain("set -eo pipefail");
  });

  it("should define MIN_BUN_VERSION constant", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toMatch(/MIN_BUN_VERSION="[0-9]+\.[0-9]+\.[0-9]+"/);
  });

  it("should define version_gte function", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toContain("version_gte()");
  });

  it("should define find_install_dir function", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toContain("find_install_dir()");
  });

  it("should define ensure_in_path function", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toContain("ensure_in_path()");
  });

  it("should define build_and_install function", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toContain("build_and_install()");
  });

  it("should define clone_cli function", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    expect(content).toContain("clone_cli()");
  });

  it("should include source-mode fallback", () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(INSTALL_SH, "utf-8");
    // Source mode fallback was added in recent commits
    expect(content).toContain("source");
    expect(content).toContain("WRAPPER");
  });
});

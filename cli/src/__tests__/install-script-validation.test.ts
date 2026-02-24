import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { isString } from "../shared/type-guards";

/**
 * Validation tests for sh/cli/install.sh.
 *
 * install.sh is the critical entry point for all new users
 * (curl -fsSL ... | bash). It has been modified in multiple recent PRs
 * but had zero test coverage. These tests validate structure, conventions,
 * security, curl|bash compatibility, and the source-mode fallback wrapper.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const INSTALL_SH = join(REPO_ROOT, "sh", "cli", "install.sh");
const content = readFileSync(INSTALL_SH, "utf-8");
const lines = content.split("\n");

/** Get non-comment, non-empty lines */
function codeLines(): string[] {
  return lines.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

describe("install.sh validation", () => {
  // ── File existence and structure ─────────────────────────────────────

  describe("file structure", () => {
    it("should exist on disk", () => {
      expect(existsSync(INSTALL_SH)).toBe(true);
    });

    it("should start with #!/bin/bash shebang", () => {
      expect(lines[0]).toBe("#!/bin/bash");
    });

    it("should use set -eo pipefail", () => {
      expect(content).toContain("set -eo pipefail");
    });

    it("should not be empty", () => {
      expect(content.trim().length).toBeGreaterThan(100);
    });

    it("should not use set -u or set -o nounset", () => {
      const code = codeLines();
      const hasSetU = code.some(
        (l) => (/\bset\s+.*-.*u\b/.test(l) && !l.includes("pipefail")) || /set\s+-o\s+nounset/.test(l),
      );
      expect(hasSetU).toBe(false);
    });
  });

  // ── Repository constants ─────────────────────────────────────────────

  describe("repository constants", () => {
    it("should define SPAWN_REPO pointing to OpenRouterTeam/spawn", () => {
      expect(content).toContain('SPAWN_REPO="OpenRouterTeam/spawn"');
    });

    it("should define SPAWN_RAW_BASE using SPAWN_REPO", () => {
      expect(content).toContain("SPAWN_RAW_BASE=");
      expect(content).toContain("raw.githubusercontent.com");
      expect(content).toContain("${SPAWN_REPO}");
    });

    it("should define MIN_BUN_VERSION", () => {
      expect(content).toMatch(/MIN_BUN_VERSION="[0-9]+\.[0-9]+\.[0-9]+"/);
    });
  });

  // ── Required functions ───────────────────────────────────────────────

  describe("required functions", () => {
    it("should define log_info function", () => {
      expect(content).toMatch(/log_info\(\)/);
    });

    it("should define log_warn function", () => {
      expect(content).toMatch(/log_warn\(\)/);
    });

    it("should define log_error function", () => {
      expect(content).toMatch(/log_error\(\)/);
    });

    it("should define version_gte function", () => {
      expect(content).toContain("version_gte()");
    });

    it("should define ensure_min_bun_version function", () => {
      expect(content).toContain("ensure_min_bun_version()");
    });

    it("should define ensure_in_path function", () => {
      expect(content).toContain("ensure_in_path()");
    });

    it("should define clone_cli function", () => {
      expect(content).toContain("clone_cli()");
    });

    it("should define build_and_install function", () => {
      expect(content).toContain("build_and_install()");
    });
  });

  // ── curl|bash compatibility ──────────────────────────────────────────

  describe("curl|bash compatibility", () => {
    it("should not use source <(...) process substitution", () => {
      const code = codeLines();
      const hasProcessSub = code.some((l) => /source\s+<\(/.test(l));
      expect(hasProcessSub).toBe(false);
    });

    it("should not rely on BASH_SOURCE for path resolution", () => {
      // install.sh runs via curl|bash so BASH_SOURCE is meaningless
      expect(content).not.toContain("BASH_SOURCE");
    });

    it("should not rely on dirname $0 for path resolution", () => {
      expect(content).not.toContain('dirname "$0"');
      expect(content).not.toContain("dirname $0");
    });

    it("should use SPAWN_INSTALL_DIR env var for override", () => {
      expect(content).toContain("SPAWN_INSTALL_DIR");
    });

    it("should check for SPAWN_INSTALL_DIR before defaulting", () => {
      // build_and_install should check SPAWN_INSTALL_DIR first
      const fnStart = content.indexOf("build_and_install()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("SPAWN_INSTALL_DIR");
    });
  });

  // ── Bun installation ────────────────────────────────────────────────

  describe("bun installation", () => {
    it("should check if bun is available via command -v", () => {
      expect(content).toContain("command -v bun");
    });

    it("should install bun from bun.sh if not found", () => {
      expect(content).toContain("https://bun.sh/install");
    });

    it("should set BUN_INSTALL and PATH after installing bun", () => {
      expect(content).toContain("BUN_INSTALL=");
      expect(content).toContain("${BUN_INSTALL}/bin");
    });

    it("should show error and exit if bun installation fails", () => {
      // After installing bun, should check again and show error if still not found
      const afterInstall = content.slice(content.indexOf("https://bun.sh/install"));
      expect(afterInstall).toContain("command -v bun");
      expect(afterInstall).toContain("log_error");
      expect(afterInstall).toContain("exit 1");
    });

    it("should call ensure_min_bun_version after bun is available", () => {
      // ensure_min_bun_version should be called in the main flow
      const mainFlow = content.slice(content.lastIndexOf("ensure_min_bun_version"));
      expect(mainFlow).toContain("build_and_install");
    });
  });

  // ── Version comparison ──────────────────────────────────────────────

  describe("version_gte logic", () => {
    // Extract the full function body by finding the next function or end of file
    const fnStart = content.indexOf("version_gte()");
    const fnEnd = content.indexOf("\n\n# ---", fnStart);
    const fnBody = content.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);

    it("should use IFS='.' to split semver", () => {
      expect(fnBody).toContain("IFS='.'");
    });

    it("should handle missing segments with default 0", () => {
      // ${a[$i]:-0} or similar default-to-zero pattern
      expect(fnBody).toContain(":-0");
    });

    it("should return 1 (false) when version is less", () => {
      expect(fnBody).toContain("return 1");
    });

    it("should return 0 (true) when version is greater or equal", () => {
      expect(fnBody).toContain("return 0");
    });
  });

  // ── Build and install logic ─────────────────────────────────────────

  describe("build_and_install", () => {
    it("should create a temp directory", () => {
      expect(content).toContain("mktemp -d");
    });

    it("should clean up temp directory on exit via trap", () => {
      expect(content).toContain("trap");
      expect(content).toContain("rm -rf");
    });

    it("should clone CLI source", () => {
      expect(content).toContain("clone_cli");
    });

    it("should run bun install", () => {
      expect(content).toContain("bun install");
    });

    it("should attempt bun run build", () => {
      expect(content).toContain("bun run build");
    });

    it("should default install dir to ~/.local/bin", () => {
      const fnStart = content.indexOf("build_and_install()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("${HOME}/.local/bin");
    });

    it("should create the install directory if it does not exist", () => {
      const fnStart = content.indexOf("build_and_install()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain('mkdir -p "${INSTALL_DIR}"');
    });

    it("should set chmod +x on the spawn binary", () => {
      expect(content).toContain('chmod +x "${INSTALL_DIR}/spawn"');
    });

    it("should call ensure_in_path at the end", () => {
      const fnStart = content.indexOf("build_and_install()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("ensure_in_path");
    });
  });

  // ── Build fallback (binary download) ────────────────────────────────

  describe("build fallback and binary download", () => {
    it("should attempt local build first via bun run build", () => {
      expect(content).toContain("bun run build");
    });

    it("should fall back to downloading pre-built binary if build fails", () => {
      expect(content).toContain("log_warn");
      expect(content).toContain("downloading pre-built binary");
    });

    it("should download from GitHub releases with cli-latest tag", () => {
      expect(content).toContain("github.com");
      expect(content).toContain("releases/download");
      expect(content).toContain("cli-latest");
      expect(content).toContain("cli.js");
    });

    it("should validate that downloaded binary is not empty", () => {
      expect(content).toContain("[ ! -s cli.js ]");
    });

    it("should copy built or downloaded cli.js to install directory", () => {
      expect(content).toContain('cp cli.js "${INSTALL_DIR}/spawn"');
    });

    it("should show helpful message after installation", () => {
      const fnStart = content.indexOf("ensure_in_path()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain('spawn" version');
      expect(fnBody).toContain("to get started");
    });
  });

  // ── clone_cli function ──────────────────────────────────────────────

  describe("clone_cli", () => {
    it("should not require git (avoids macOS Xcode CLT trigger)", () => {
      expect(content).not.toContain("command -v git");
      expect(content).not.toContain("git clone");
      expect(content).not.toContain("sparse-checkout");
    });

    it("should download source via curl and GitHub API", () => {
      const fnStart = content.indexOf("clone_cli()");
      const fnEnd = content.indexOf("\n# --- Helper: build", fnStart);
      const fnBody = content.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
      expect(fnBody).toContain("curl");
      expect(fnBody).toContain("api.github.com");
    });

    it("should download package.json and bun.lock", () => {
      expect(content).toContain("package.json");
      expect(content).toContain("bun.lock");
    });

    it("should download tsconfig.json", () => {
      expect(content).toContain("tsconfig.json");
    });

    it("should exclude __tests__ directory from downloads", () => {
      expect(content).toContain("__tests__");
    });
  });

  // ── symlink into /usr/local/bin ────────────────────────────────────

  describe("symlink to /usr/local/bin", () => {
    it("should symlink spawn into /usr/local/bin for immediate availability", () => {
      const fnStart = content.indexOf("ensure_in_path()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("/usr/local/bin/spawn");
      expect(fnBody).toContain("ln -sf");
    });

    it("should try sudo if /usr/local/bin is not writable", () => {
      const fnStart = content.indexOf("ensure_in_path()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("sudo ln -sf");
    });

    it("should gracefully handle symlink failure", () => {
      // Should not hard-fail if symlink fails — falls back to exec $SHELL
      const fnStart = content.indexOf("ensure_in_path()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("|| true");
      expect(fnBody).toContain("exec");
    });

    it("should default install to ~/.local/bin", () => {
      expect(content).toContain("${HOME}/.local/bin");
    });
  });

  // ── ensure_in_path function ────────────────────────────────────────

  describe("ensure_in_path", () => {
    it("should run spawn version after install", () => {
      expect(content).toContain('/spawn" version');
    });

    it("should patch zsh rc file for zsh users", () => {
      expect(content).toContain(".zshrc");
    });

    it("should patch fish PATH for fish users", () => {
      expect(content).toContain("fish_add_path");
    });

    it("should patch bashrc as default", () => {
      expect(content).toContain(".bashrc");
    });

    it("should detect shell from SHELL env var", () => {
      expect(content).toContain("${SHELL:-");
    });

    it("should show exec $SHELL fallback when symlink fails", () => {
      const fnStart = content.indexOf("ensure_in_path()");
      const fnBody = content.slice(fnStart);
      expect(fnBody).toContain("exec");
    });
  });

  // ── Security ─────────────────────────────────────────────────────────

  describe("security", () => {
    it("should not contain hardcoded API keys or tokens", () => {
      const code = codeLines();
      for (const line of code) {
        expect(line).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
        expect(line).not.toMatch(/token[=:]\s*[a-f0-9]{32,}/i);
      }
    });

    it("should not use eval to execute downloaded content", () => {
      const code = codeLines();
      // eval should not be used to run arbitrary downloaded scripts
      // (bun.sh/install is piped to bash, which is standard practice)
      const evalLines = code.filter((l) => l.includes("eval") && !l.includes("2>/dev/null") && !l.includes("#"));
      expect(evalLines).toEqual([]);
    });

    it("should quote variables in file operations", () => {
      // Critical paths should quote variables
      expect(content).toContain('"${INSTALL_DIR}/spawn"');
      expect(content).toContain('"${tmpdir}"');
    });

    it("should use -fsSL flags for curl downloads", () => {
      const curlLines = codeLines().filter((l) => l.includes("curl"));
      for (const line of curlLines) {
        expect(line).toMatch(/-fsSL/);
      }
    });
  });

  // ── Consistency with package.json ──────────────────────────────────

  describe("consistency with package.json", () => {
    it("should reference same repo as package.json", () => {
      const pkgContent = readFileSync(join(REPO_ROOT, "cli", "package.json"), "utf-8");
      const pkg = JSON.parse(pkgContent);
      // install.sh uses OpenRouterTeam/spawn
      expect(content).toContain("OpenRouterTeam/spawn");
      // package.json should reference same repo
      if (pkg.repository) {
        const repo = isString(pkg.repository) ? pkg.repository : pkg.repository.url || "";
        expect(repo.toLowerCase()).toContain("openrouterteam/spawn");
      }
    });

    it("should download the correct files that exist in cli/src/", () => {
      // The curl-based download path downloads .ts files from cli/src/
      // Verify that the files listed in install.sh actually exist
      const srcDir = join(REPO_ROOT, "cli", "src");
      expect(existsSync(join(srcDir, "index.ts"))).toBe(true);
      expect(existsSync(join(srcDir, "commands.ts"))).toBe(true);
      expect(existsSync(join(srcDir, "manifest.ts"))).toBe(true);
    });
  });

  // ── Main flow order ────────────────────────────────────────────────

  describe("main execution flow", () => {
    it("should check for bun before building", () => {
      const bunCheck = content.indexOf("command -v bun");
      const buildCall = content.lastIndexOf("build_and_install");
      expect(bunCheck).toBeLessThan(buildCall);
    });

    it("should ensure min bun version before building", () => {
      const versionCheck = content.lastIndexOf("ensure_min_bun_version");
      const buildCall = content.lastIndexOf("build_and_install");
      expect(versionCheck).toBeLessThan(buildCall);
    });

    it("should call build_and_install as the last major step", () => {
      const lastFewLines = lines.slice(-5).join("\n");
      expect(lastFewLines).toContain("build_and_install");
    });
  });

  // ── Error handling ────────────────────────────────────────────────

  describe("error handling", () => {
    it("should show re-run instructions on bun install failure", () => {
      expect(content).toContain("curl -fsSL ${SPAWN_RAW_BASE}/sh/cli/install.sh | bash");
    });

    it("should show manual bun install instructions on failure", () => {
      expect(content).toContain("curl -fsSL https://bun.sh/install | bash");
    });

    it("should exit with code 1 on failures", () => {
      const exitLines = codeLines().filter((l) => l.trim() === "exit 1");
      expect(exitLines.length).toBeGreaterThanOrEqual(2);
    });

    it("should show upgrade instructions if bun version is too low", () => {
      const fnStart = content.indexOf("ensure_min_bun_version()");
      const fnEnd = content.indexOf("\n# --- Helper: ensure", fnStart);
      const fnBody = content.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
      expect(fnBody).toContain("bun upgrade");
      expect(fnBody).toContain("exit 1");
    });
  });
});

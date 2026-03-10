import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCacheDir,
  getCacheFile,
  getHistoryPath,
  getSpawnCloudConfigPath,
  getSpawnDir,
  getSshDir,
  getTmpDir,
  getUpdateFailedPath,
  getUserHome,
} from "../shared/paths";

describe("paths", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = {
      ...process.env,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getUserHome", () => {
    it("returns HOME env var when set", () => {
      process.env.HOME = "/custom/home";
      expect(getUserHome()).toBe("/custom/home");
    });

    it("falls back to os.homedir() when HOME is unset", () => {
      delete process.env.HOME;
      expect(getUserHome()).toBe(homedir());
    });
  });

  describe("getSpawnDir", () => {
    it("returns ~/.spawn by default", () => {
      delete process.env.SPAWN_HOME;
      expect(getSpawnDir()).toBe(join(getUserHome(), ".spawn"));
    });

    it("uses SPAWN_HOME when set to valid absolute path", () => {
      const testPath = join(getUserHome(), ".custom-spawn");
      process.env.SPAWN_HOME = testPath;
      expect(getSpawnDir()).toBe(testPath);
    });

    it("rejects relative SPAWN_HOME", () => {
      process.env.SPAWN_HOME = "relative/path";
      expect(() => getSpawnDir()).toThrow("must be an absolute path");
    });

    it("rejects path traversal outside home directory", () => {
      process.env.SPAWN_HOME = "/tmp/../../root/.spawn";
      expect(() => getSpawnDir()).toThrow("must be within your home directory");
    });
  });

  describe("getHistoryPath", () => {
    it("returns history.json inside spawn dir", () => {
      delete process.env.SPAWN_HOME;
      expect(getHistoryPath()).toBe(join(getUserHome(), ".spawn", "history.json"));
    });
  });

  describe("getSpawnCloudConfigPath", () => {
    it("returns ~/.config/spawn/{cloud}.json", () => {
      expect(getSpawnCloudConfigPath("aws")).toBe(join(getUserHome(), ".config", "spawn", "aws.json"));
    });

    it("works for different cloud names", () => {
      expect(getSpawnCloudConfigPath("hetzner")).toBe(join(getUserHome(), ".config", "spawn", "hetzner.json"));
    });
  });

  describe("getCacheDir", () => {
    it("returns XDG_CACHE_HOME/spawn when XDG_CACHE_HOME is set", () => {
      process.env.XDG_CACHE_HOME = "/custom/cache";
      expect(getCacheDir()).toBe("/custom/cache/spawn");
    });

    it("falls back to ~/.cache/spawn", () => {
      delete process.env.XDG_CACHE_HOME;
      expect(getCacheDir()).toBe(join(getUserHome(), ".cache", "spawn"));
    });
  });

  describe("getCacheFile", () => {
    it("returns manifest.json inside cache dir", () => {
      delete process.env.XDG_CACHE_HOME;
      expect(getCacheFile()).toBe(join(getUserHome(), ".cache", "spawn", "manifest.json"));
    });
  });

  describe("getUpdateFailedPath", () => {
    it("returns ~/.config/spawn/.update-failed", () => {
      expect(getUpdateFailedPath()).toBe(join(getUserHome(), ".config", "spawn", ".update-failed"));
    });
  });

  describe("getSshDir", () => {
    it("returns ~/.ssh", () => {
      expect(getSshDir()).toBe(join(getUserHome(), ".ssh"));
    });
  });

  describe("getTmpDir", () => {
    it("returns os.tmpdir()", () => {
      expect(getTmpDir()).toBe(tmpdir());
    });
  });
});

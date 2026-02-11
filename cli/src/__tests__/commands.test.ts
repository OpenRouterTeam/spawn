import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  cmdRun,
  cmdList,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdHelp,
} from "../commands";
import {
  createConsoleMocks,
  createProcessExitMock,
  restoreMocks,
  createMockManifest,
} from "./test-helpers";

const mockManifest = createMockManifest();

// Note: Bun test doesn't support module mocking the same way as vitest
// These tests require refactoring commands.ts to use dependency injection

describe("commands", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let processExitSpy: ReturnType<typeof createProcessExitMock>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    processExitSpy = createProcessExitMock();
  });

  afterEach(() => {
    restoreMocks(consoleMocks.log, consoleMocks.error, processExitSpy);
  });

  describe("cmdHelp", () => {
    it("should print help text", () => {
      cmdHelp();
      expect(consoleMocks.log).toHaveBeenCalled();
      const helpText = consoleMocks.log.mock.calls.join("\n");
      expect(helpText).toContain("spawn");
      expect(helpText).toContain("USAGE");
      expect(helpText).toContain("EXAMPLES");
    });
  });

  // These functions are tested in dedicated files using mock.module():
  // - cmdList: commands-list-grid.test.ts, commands-compact-list.test.ts
  // - cmdAgents/cmdClouds: commands-display.test.ts, commands-output.test.ts, commands-list-grid.test.ts
  // - cmdAgentInfo/cmdCloudInfo: commands-info-details.test.ts, commands-display.test.ts, cloud-info.test.ts
  // - cmdRun: commands-resolve-run.test.ts, commands-swap-resolve.test.ts, cmdrun-resolution.test.ts
  // - Download/failure: download-and-failure.test.ts, commands-update-download.test.ts
});

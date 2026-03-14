import { describe, expect, it } from "bun:test";
import { findUnknownFlag } from "../flags";
import { getAgentOptionalSteps, validateStepNames } from "../shared/agents";

describe("--steps and --config flags", () => {
  it("should recognize --steps and --config as known flags", () => {
    expect(
      findUnknownFlag([
        "--steps",
      ]),
    ).toBeNull();
    expect(
      findUnknownFlag([
        "--config",
      ]),
    ).toBeNull();
  });
});

describe("validateStepNames", () => {
  it("should validate known steps for claude", () => {
    const { valid, invalid } = validateStepNames("claude", [
      "github",
      "reuse-api-key",
    ]);
    expect(valid).toEqual([
      "github",
      "reuse-api-key",
    ]);
    expect(invalid).toEqual([]);
  });

  it("should validate known steps for openclaw", () => {
    const { valid, invalid } = validateStepNames("openclaw", [
      "github",
      "browser",
      "telegram",
    ]);
    expect(valid).toEqual([
      "github",
      "browser",
      "telegram",
    ]);
    expect(invalid).toEqual([]);
  });

  it("should separate invalid step names", () => {
    const { valid, invalid } = validateStepNames("claude", [
      "github",
      "nonexistent",
      "bogus",
    ]);
    expect(valid).toEqual([
      "github",
    ]);
    expect(invalid).toEqual([
      "nonexistent",
      "bogus",
    ]);
  });

  it("should return all invalid for unknown agent with no extra steps", () => {
    // unknown agent still has COMMON_STEPS (github, reuse-api-key)
    const { valid, invalid } = validateStepNames("unknown-agent", [
      "browser",
      "telegram",
    ]);
    expect(valid).toEqual([]);
    expect(invalid).toEqual([
      "browser",
      "telegram",
    ]);
  });

  it("should handle empty steps array", () => {
    const { valid, invalid } = validateStepNames("claude", []);
    expect(valid).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

describe("OptionalStep metadata", () => {
  it("openclaw telegram step should have dataEnvVar", () => {
    const steps = getAgentOptionalSteps("openclaw");
    const telegram = steps.find((s) => s.value === "telegram");
    expect(telegram).toBeDefined();
    expect(telegram?.dataEnvVar).toBe("TELEGRAM_BOT_TOKEN");
  });

  it("common steps should not have dataEnvVar or interactive", () => {
    const steps = getAgentOptionalSteps("claude");
    for (const step of steps) {
      expect(step.dataEnvVar).toBeUndefined();
      expect(step.interactive).toBeUndefined();
    }
  });
});

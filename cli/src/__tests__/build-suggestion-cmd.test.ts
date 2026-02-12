import { describe, it, expect } from "bun:test";
import { buildSuggestionCmd } from "../commands";

/**
 * Tests for buildSuggestionCmd (commands.ts).
 *
 * This helper builds the suggested spawn command shown in typo correction hints.
 * When pairArg is provided, it includes both agent and cloud in the correct order.
 *
 * Agent: ux-engineer
 */

describe("buildSuggestionCmd", () => {
  it("should return 'spawn <match>' when no pairArg for agent", () => {
    expect(buildSuggestionCmd("claude", "agent")).toBe("spawn claude");
  });

  it("should return 'spawn <match>' when no pairArg for cloud", () => {
    expect(buildSuggestionCmd("sprite", "cloud")).toBe("spawn sprite");
  });

  it("should return 'spawn <agent> <cloud>' when kind is agent with cloud pairArg", () => {
    expect(buildSuggestionCmd("claude", "agent", "sprite")).toBe("spawn claude sprite");
  });

  it("should return 'spawn <agent> <cloud>' when kind is cloud with agent pairArg", () => {
    expect(buildSuggestionCmd("sprite", "cloud", "claude")).toBe("spawn claude sprite");
  });

  it("should put agent first regardless of which is the match", () => {
    // When match is an agent correction (kind=agent), match goes first
    expect(buildSuggestionCmd("aider", "agent", "hetzner")).toBe("spawn aider hetzner");
    // When match is a cloud correction (kind=cloud), pairArg (agent) goes first
    expect(buildSuggestionCmd("hetzner", "cloud", "aider")).toBe("spawn aider hetzner");
  });

  it("should handle undefined pairArg same as no pairArg", () => {
    expect(buildSuggestionCmd("claude", "agent", undefined)).toBe("spawn claude");
    expect(buildSuggestionCmd("sprite", "cloud", undefined)).toBe("spawn sprite");
  });
});

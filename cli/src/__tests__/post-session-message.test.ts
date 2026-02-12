import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { showPostSessionMessage, PERSISTENT_CLOUD_TYPES } from "../commands.js";

describe("showPostSessionMessage", () => {
  let logs: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  describe("persistent cloud types show a reminder", () => {
    it("should show reminder for api cloud type", () => {
      showPostSessionMessage("hetzner", "Hetzner Cloud", "api", "claude", "https://www.hetzner.com/cloud/");
      const output = logs.join("\n");
      expect(output).toContain("server is still running");
      expect(output).toContain("spawn claude hetzner");
      expect(output).toContain("https://www.hetzner.com/cloud/");
      expect(output).toContain("stop billing");
    });

    it("should show reminder for cli cloud type", () => {
      showPostSessionMessage("aws-lightsail", "AWS Lightsail", "cli", "aider");
      const output = logs.join("\n");
      expect(output).toContain("server is still running");
      expect(output).toContain("spawn aider aws-lightsail");
    });

    it("should show reminder for api+cli cloud type", () => {
      showPostSessionMessage("fly", "Fly.io", "api+cli", "goose", "https://fly.io");
      const output = logs.join("\n");
      expect(output).toContain("server is still running");
      expect(output).toContain("spawn goose fly");
      expect(output).toContain("https://fly.io");
    });
  });

  describe("ephemeral cloud types do not show a reminder", () => {
    it("should not show reminder for sandbox cloud type", () => {
      showPostSessionMessage("e2b", "E2B", "sandbox", "claude");
      expect(logs.length).toBe(0);
    });

    it("should not show reminder for local cloud type", () => {
      showPostSessionMessage("local", "Local Machine", "local", "claude");
      expect(logs.length).toBe(0);
    });
  });

  describe("dashboard URL handling", () => {
    it("should show dashboard URL when provided", () => {
      showPostSessionMessage("digitalocean", "DigitalOcean", "api", "claude", "https://www.digitalocean.com/");
      const output = logs.join("\n");
      expect(output).toContain("Dashboard:");
      expect(output).toContain("https://www.digitalocean.com/");
    });

    it("should omit dashboard line when URL is not provided", () => {
      showPostSessionMessage("gcp", "GCP Compute Engine", "cli", "claude");
      const output = logs.join("\n");
      expect(output).not.toContain("Dashboard:");
      expect(output).toContain("server is still running");
    });
  });

  describe("reconnect command", () => {
    it("should show correct reconnect command for agent and cloud", () => {
      showPostSessionMessage("vultr", "Vultr", "api", "codex", "https://www.vultr.com/");
      const output = logs.join("\n");
      expect(output).toContain("spawn codex vultr");
    });
  });
});

describe("PERSISTENT_CLOUD_TYPES", () => {
  it("should include api", () => {
    expect(PERSISTENT_CLOUD_TYPES.has("api")).toBe(true);
  });

  it("should include cli", () => {
    expect(PERSISTENT_CLOUD_TYPES.has("cli")).toBe(true);
  });

  it("should include api+cli", () => {
    expect(PERSISTENT_CLOUD_TYPES.has("api+cli")).toBe(true);
  });

  it("should not include sandbox", () => {
    expect(PERSISTENT_CLOUD_TYPES.has("sandbox")).toBe(false);
  });

  it("should not include local", () => {
    expect(PERSISTENT_CLOUD_TYPES.has("local")).toBe(false);
  });
});

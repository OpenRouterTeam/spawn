import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, readFileSync } from "node:fs";

import { BUNDLES, DEFAULT_BUNDLE, loadCredsFromConfig, saveCredsToConfig, AWS_CONFIG_PATH } from "../aws/aws";

// ─── Credential caching tests ────────────────────────────────────────────────

describe("aws/credential-cache", () => {
  let originalConfig: string | null = null;

  beforeEach(() => {
    if (existsSync(AWS_CONFIG_PATH)) {
      originalConfig = readFileSync(AWS_CONFIG_PATH, "utf-8");
    } else {
      originalConfig = null;
    }
  });

  afterEach(() => {
    if (originalConfig !== null) {
      Bun.write(AWS_CONFIG_PATH, originalConfig);
    } else if (existsSync(AWS_CONFIG_PATH)) {
      unlinkSync(AWS_CONFIG_PATH);
    }
  });

  describe("loadCredsFromConfig", () => {
    it("returns null when config file does not exist", () => {
      if (existsSync(AWS_CONFIG_PATH)) {
        unlinkSync(AWS_CONFIG_PATH);
      }
      expect(loadCredsFromConfig()).toBeNull();
    });

    it("returns null for malformed JSON", async () => {
      await Bun.write(AWS_CONFIG_PATH, "not-json", {
        mode: 0o600,
      });
      expect(loadCredsFromConfig()).toBeNull();
    });

    it("returns null when accessKeyId is missing", async () => {
      await Bun.write(
        AWS_CONFIG_PATH,
        JSON.stringify({
          secretAccessKey: "secretsecretkey1234",
        }),
        {
          mode: 0o600,
        },
      );
      expect(loadCredsFromConfig()).toBeNull();
    });

    it("returns null when secretAccessKey is too short", async () => {
      await Bun.write(
        AWS_CONFIG_PATH,
        JSON.stringify({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "tooshort",
        }),
        {
          mode: 0o600,
        },
      );
      expect(loadCredsFromConfig()).toBeNull();
    });

    it("returns null for invalid accessKeyId format", async () => {
      await Bun.write(
        AWS_CONFIG_PATH,
        JSON.stringify({
          accessKeyId: "invalid key!",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        }),
        {
          mode: 0o600,
        },
      );
      expect(loadCredsFromConfig()).toBeNull();
    });

    it("returns credentials for valid data", async () => {
      await Bun.write(
        AWS_CONFIG_PATH,
        JSON.stringify({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
          region: "eu-west-1",
        }),
        {
          mode: 0o600,
        },
      );
      const result = loadCredsFromConfig();
      expect(result).not.toBeNull();
      expect(result?.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(result?.secretAccessKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCY");
      expect(result?.region).toBe("eu-west-1");
    });

    it("defaults region to us-east-1 when not stored", async () => {
      await Bun.write(
        AWS_CONFIG_PATH,
        JSON.stringify({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        }),
        {
          mode: 0o600,
        },
      );
      const result = loadCredsFromConfig();
      expect(result?.region).toBe("us-east-1");
    });
  });

  describe("saveCredsToConfig", () => {
    it("writes credentials to config file", async () => {
      if (existsSync(AWS_CONFIG_PATH)) {
        unlinkSync(AWS_CONFIG_PATH);
      }
      await saveCredsToConfig("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "us-west-2");
      const result = loadCredsFromConfig();
      expect(result?.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(result?.secretAccessKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCY");
      expect(result?.region).toBe("us-west-2");
    });

    it("round-trips credentials with special characters in secret key", async () => {
      if (existsSync(AWS_CONFIG_PATH)) {
        unlinkSync(AWS_CONFIG_PATH);
      }
      const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCY==";
      await saveCredsToConfig("AKIAIOSFODNN7EXAMPLE", secret, "ap-northeast-1");
      const result = loadCredsFromConfig();
      expect(result?.secretAccessKey).toBe(secret);
    });

    it("overwrites existing config file", async () => {
      await saveCredsToConfig("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "us-east-1");
      await saveCredsToConfig("AKIAIOSFODNN7EXAMPLE2", "newSecretKeyNewSecretKey1234567", "eu-central-1");
      const result = loadCredsFromConfig();
      expect(result?.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE2");
      expect(result?.region).toBe("eu-central-1");
    });
  });
});

// ─── aws.ts tests ────────────────────────────────────────────────────────────

describe("aws/aws", () => {
  describe("BUNDLES", () => {
    it("has multiple bundle tiers", () => {
      expect(BUNDLES.length).toBeGreaterThanOrEqual(5);
    });

    it("all bundles have required fields", () => {
      for (const b of BUNDLES) {
        expect(b.id).toBeTruthy();
        expect(b.label).toBeTruthy();
      }
    });

    it("bundle IDs follow naming convention", () => {
      for (const b of BUNDLES) {
        expect(b.id).toMatch(/_3_0$/);
      }
    });

    it("labels include pricing info", () => {
      for (const b of BUNDLES) {
        expect(b.label).toContain("$");
        expect(b.label).toContain("/mo");
      }
    });
  });

  describe("DEFAULT_BUNDLE", () => {
    it("is nano_3_0", () => {
      expect(DEFAULT_BUNDLE.id).toBe("nano_3_0");
    });

    it("references a valid bundle", () => {
      const found = BUNDLES.find((b) => b.id === DEFAULT_BUNDLE.id);
      expect(found).toBeDefined();
    });
  });
});

import type { Manifest } from "../manifest";
import type { TestEnvironment } from "./test-helpers";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKeys, cloudKeys, countImplemented, loadManifest, matrixStatus, stripDangerousKeys } from "../manifest";
import {
  createEmptyManifest,
  createMockManifest,
  mockSuccessfulFetch,
  setupTestEnvironment,
  teardownTestEnvironment,
} from "./test-helpers";

const mockManifest = createMockManifest();

describe("manifest", () => {
  describe("agentKeys", () => {
    it("should return all agent keys", () => {
      const keys = agentKeys(mockManifest);
      expect(keys).toEqual([
        "claude",
        "codex",
      ]);
    });

    it("should return empty array for empty agents", () => {
      const emptyManifest = createEmptyManifest();
      const keys = agentKeys(emptyManifest);
      expect(keys).toEqual([]);
    });
  });

  describe("cloudKeys", () => {
    it("should return all cloud keys", () => {
      const keys = cloudKeys(mockManifest);
      expect(keys).toEqual([
        "sprite",
        "hetzner",
      ]);
    });

    it("should return empty array for empty clouds", () => {
      const emptyManifest = createEmptyManifest();
      const keys = cloudKeys(emptyManifest);
      expect(keys).toEqual([]);
    });
  });

  describe("matrixStatus", () => {
    it("should return 'implemented' for existing implemented combination", () => {
      const status = matrixStatus(mockManifest, "sprite", "claude");
      expect(status).toBe("implemented");
    });

    it("should return 'missing' for existing missing combination", () => {
      const status = matrixStatus(mockManifest, "hetzner", "codex");
      expect(status).toBe("missing");
    });

    it("should return 'missing' for non-existent combination", () => {
      const status = matrixStatus(mockManifest, "aws", "claude");
      expect(status).toBe("missing");
    });

    it("should handle edge case with undefined matrix entry", () => {
      const status = matrixStatus(mockManifest, "nonexistent", "agent");
      expect(status).toBe("missing");
    });
  });

  describe("countImplemented", () => {
    it("should count implemented combinations correctly", () => {
      const count = countImplemented(mockManifest);
      expect(count).toBe(3);
    });

    it("should return 0 for empty matrix", () => {
      const emptyManifest = createEmptyManifest();
      const count = countImplemented(emptyManifest);
      expect(count).toBe(0);
    });

    it("should return 0 when all are missing", () => {
      const allMissing: Manifest = {
        agents: mockManifest.agents,
        clouds: mockManifest.clouds,
        matrix: {
          "sprite/claude": "missing",
          "sprite/codex": "missing",
          "hetzner/claude": "missing",
          "hetzner/codex": "missing",
        },
      };
      const count = countImplemented(allMissing);
      expect(count).toBe(0);
    });
  });

  describe("loadManifest", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should fetch from network when cache is missing", async () => {
      // Mock successful fetch
      global.fetch = mockSuccessfulFetch(mockManifest);

      const manifest = await loadManifest(true); // Force refresh

      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("manifest.json"),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("should use disk cache when fresh", async () => {
      // Write fresh cache
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));

      // Mock fetch — must NOT be called when cache is fresh
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest();

      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should refresh cache when forceRefresh is true", async () => {
      // Write stale cache
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));

      // Mock successful fetch with different data
      const updatedManifest = {
        ...mockManifest,
        agents: {},
      };
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(updatedManifest))));

      const manifest = await loadManifest(true);

      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});

// ── stripDangerousKeys (prototype pollution defense) ─────────────────────────

describe("stripDangerousKeys", () => {
  it("strips __proto__ from parsed JSON", () => {
    const input = JSON.parse('{"agents":{},"clouds":{},"matrix":{},"__proto__":{"polluted":true}}');
    expect(Object.hasOwn(input, "__proto__")).toBe(true);
    const result = stripDangerousKeys(input);
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(result.agents).toEqual({});
  });

  it("strips constructor key", () => {
    const input = Object.assign(Object.create(null), {
      name: "test",
      constructor: {
        evil: true,
      },
    });
    const result = stripDangerousKeys(input);
    expect(Object.keys(result)).toEqual([
      "name",
    ]);
    expect(result.name).toBe("test");
  });

  it("strips prototype key", () => {
    const input = Object.assign(Object.create(null), {
      data: 1,
      prototype: {
        inject: true,
      },
    });
    const result = stripDangerousKeys(input);
    expect(Object.keys(result)).toEqual([
      "data",
    ]);
    expect(result.data).toBe(1);
  });

  it("strips dangerous keys from nested objects", () => {
    const input = {
      agents: {
        claude: {
          __proto__: {
            evil: true,
          },
          name: "Claude",
        },
      },
    };
    const result = stripDangerousKeys(input);
    expect(result.agents.claude.name).toBe("Claude");
    expect(Object.keys(result.agents.claude)).toEqual([
      "name",
    ]);
  });

  it("handles arrays correctly", () => {
    const input = {
      items: [
        {
          name: "a",
        },
        {
          name: "b",
          __proto__: {},
        },
      ],
    };
    const result = stripDangerousKeys(input);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("a");
    expect(result.items[1].name).toBe("b");
  });

  it("passes through primitives unchanged", () => {
    expect(stripDangerousKeys("hello")).toBe("hello");
    expect(stripDangerousKeys(42)).toBe(42);
    expect(stripDangerousKeys(true)).toBe(true);
    expect(stripDangerousKeys(null)).toBe(null);
  });

  it("preserves normal keys", () => {
    const input = {
      agents: {
        a: 1,
      },
      clouds: {
        b: 2,
      },
      matrix: {
        c: 3,
      },
    };
    const result = stripDangerousKeys(input);
    expect(result).toEqual(input);
  });

  it("handles deeply nested dangerous keys", () => {
    const input = {
      a: {
        b: {
          c: {
            constructor: "bad",
            value: "good",
          },
        },
      },
    };
    const result = stripDangerousKeys(input);
    expect(result.a.b.c.value).toBe("good");
    expect(Object.keys(result.a.b.c)).toEqual([
      "value",
    ]);
  });
});

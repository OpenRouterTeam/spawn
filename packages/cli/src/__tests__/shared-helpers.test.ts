import { describe, expect, it } from "bun:test";
import { generateEnvConfig } from "../shared/agents";
import { hasMessage, hasStatus, toObjectArray, toRecord } from "../shared/type-guards";

// ─── generateEnvConfig ──────────────────────────────────────────────────────

describe("generateEnvConfig", () => {
  it("returns header with IS_SANDBOX for empty input", () => {
    const result = generateEnvConfig([]);
    expect(result).toContain("export IS_SANDBOX='1'");
    expect(result).toContain("# [spawn:env]");
  });

  it("generates correct export lines for valid pairs", () => {
    const result = generateEnvConfig([
      "API_KEY=sk-123",
      "BASE_URL=https://example.com",
    ]);
    expect(result).toContain("export API_KEY='sk-123'");
    expect(result).toContain("export BASE_URL='https://example.com'");
  });

  it("skips pairs without = sign", () => {
    const result = generateEnvConfig([
      "NO_EQUALS_HERE",
    ]);
    expect(result).not.toContain("NO_EQUALS_HERE");
    // Should still have the header
    expect(result).toContain("export IS_SANDBOX='1'");
  });

  it("rejects env var names that fail validation regex", () => {
    const result = generateEnvConfig([
      "lowercase=bad",
      "1DIGIT_START=bad",
      "HAS SPACE=bad",
      "HAS-DASH=bad",
    ]);
    expect(result).not.toContain("lowercase");
    expect(result).not.toContain("1DIGIT_START");
    expect(result).not.toContain("HAS SPACE");
    expect(result).not.toContain("HAS-DASH");
  });

  it("escapes single quotes in values to prevent shell injection", () => {
    const result = generateEnvConfig([
      "MY_VAR=it's a test",
    ]);
    // Single quotes should be escaped as '\'' (end quote, escaped quote, start quote)
    expect(result).toContain("export MY_VAR='it'\\''s a test'");
  });

  it("splits only on the first = sign in a pair", () => {
    const result = generateEnvConfig([
      "URL=https://example.com?a=1&b=2",
    ]);
    expect(result).toContain("export URL='https://example.com?a=1&b=2'");
  });

  it("allows underscore-prefixed names", () => {
    const result = generateEnvConfig([
      "_PRIVATE=secret",
    ]);
    expect(result).toContain("export _PRIVATE='secret'");
  });
});

// ─── toRecord ───────────────────────────────────────────────────────────────

describe("toRecord", () => {
  it("returns the object for a plain object", () => {
    const obj = {
      key: "value",
    };
    expect(toRecord(obj)).toBe(obj);
  });

  it("returns null for null", () => {
    expect(toRecord(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toRecord(undefined)).toBeNull();
  });

  it("returns null for a string", () => {
    expect(toRecord("hello")).toBeNull();
  });

  it("returns null for a number", () => {
    expect(toRecord(42)).toBeNull();
  });

  it("returns null for an array", () => {
    expect(
      toRecord([
        1,
        2,
        3,
      ]),
    ).toBeNull();
  });

  it("returns the object for an empty object", () => {
    const obj = {};
    expect(toRecord(obj)).toBe(obj);
  });
});

// ─── toObjectArray ──────────────────────────────────────────────────────────

describe("toObjectArray", () => {
  it("returns filtered array of objects from mixed input", () => {
    const obj1 = {
      a: 1,
    };
    const obj2 = {
      b: 2,
    };
    const result = toObjectArray([
      obj1,
      "str",
      42,
      null,
      obj2,
      [
        1,
        2,
      ],
    ]);
    expect(result).toEqual([
      obj1,
      obj2,
    ]);
  });

  it("returns empty array for non-array input", () => {
    expect(toObjectArray("hello")).toEqual([]);
    expect(toObjectArray(42)).toEqual([]);
    expect(toObjectArray(null)).toEqual([]);
    expect(toObjectArray(undefined)).toEqual([]);
    expect(
      toObjectArray({
        key: "val",
      }),
    ).toEqual([]);
  });

  it("returns all items when all are objects", () => {
    const items = [
      {
        a: 1,
      },
      {
        b: 2,
      },
      {
        c: 3,
      },
    ];
    expect(toObjectArray(items)).toEqual(items);
  });

  it("returns empty array for array of non-objects", () => {
    expect(
      toObjectArray([
        1,
        "two",
        null,
        true,
      ]),
    ).toEqual([]);
  });
});

// ─── hasStatus ──────────────────────────────────────────────────────────────

describe("hasStatus", () => {
  it("returns true for objects with numeric status", () => {
    expect(
      hasStatus({
        status: 404,
      }),
    ).toBe(true);
    expect(
      hasStatus({
        status: 0,
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(hasStatus(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasStatus(undefined)).toBe(false);
  });

  it("returns false for objects without status", () => {
    expect(
      hasStatus({
        code: 200,
      }),
    ).toBe(false);
  });

  it("returns false for objects with non-numeric status", () => {
    expect(
      hasStatus({
        status: "200",
      }),
    ).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(hasStatus("string")).toBe(false);
    expect(hasStatus(42)).toBe(false);
  });
});

// ─── hasMessage ─────────────────────────────────────────────────────────────

describe("hasMessage", () => {
  it("returns true for objects with string message", () => {
    expect(
      hasMessage({
        message: "error",
      }),
    ).toBe(true);
    expect(
      hasMessage({
        message: "",
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(hasMessage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasMessage(undefined)).toBe(false);
  });

  it("returns false for objects without message", () => {
    expect(
      hasMessage({
        error: "oops",
      }),
    ).toBe(false);
  });

  it("returns false for objects with non-string message", () => {
    expect(
      hasMessage({
        message: 123,
      }),
    ).toBe(false);
    expect(
      hasMessage({
        message: null,
      }),
    ).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(hasMessage("string")).toBe(false);
    expect(hasMessage(42)).toBe(false);
  });
});

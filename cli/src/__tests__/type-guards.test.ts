import { describe, it, expect } from "bun:test";
import { isString, isNumber, hasStatus, hasMessage, toRecord, toObjectArray } from "../shared/type-guards";

describe("toRecord", () => {
  it("returns Record for plain objects", () => {
    const result = toRecord({ a: 1, b: "two" });
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("returns null for null", () => {
    expect(toRecord(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toRecord(undefined)).toBeNull();
  });

  it("returns null for arrays", () => {
    expect(toRecord([1, 2, 3])).toBeNull();
  });

  it("returns null for primitives", () => {
    expect(toRecord("hello")).toBeNull();
    expect(toRecord(42)).toBeNull();
    expect(toRecord(true)).toBeNull();
  });

  it("returns Record for nested objects", () => {
    const result = toRecord({ nested: { deep: true } });
    expect(result).toEqual({ nested: { deep: true } });
  });

  it("returns empty Record for empty object", () => {
    const result = toRecord({});
    expect(result).toEqual({});
  });
});

describe("toObjectArray", () => {
  it("filters array to only objects", () => {
    const input = [{ a: 1 }, null, "string", { b: 2 }, 42, [1, 2]];
    const result = toObjectArray(input);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns empty array for non-array input", () => {
    expect(toObjectArray(null)).toEqual([]);
    expect(toObjectArray(undefined)).toEqual([]);
    expect(toObjectArray("string")).toEqual([]);
    expect(toObjectArray(42)).toEqual([]);
    expect(toObjectArray({ a: 1 })).toEqual([]);
  });

  it("returns empty array for array of non-objects", () => {
    expect(toObjectArray([1, "two", null, true])).toEqual([]);
  });

  it("preserves all objects in a clean array", () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = toObjectArray(input);
    expect(result).toEqual(input);
    expect(result).toHaveLength(3);
  });

  it("excludes arrays nested in the input array", () => {
    const input = [{ a: 1 }, [1, 2], { b: 2 }];
    const result = toObjectArray(input);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("existing guards", () => {
  it("isString", () => {
    expect(isString("hello")).toBe(true);
    expect(isString(42)).toBe(false);
    expect(isString(null)).toBe(false);
  });

  it("isNumber", () => {
    expect(isNumber(42)).toBe(true);
    expect(isNumber("42")).toBe(false);
    expect(isNumber(null)).toBe(false);
  });

  it("hasStatus", () => {
    expect(hasStatus({ status: 200 })).toBe(true);
    expect(hasStatus({ status: "200" })).toBe(false);
    expect(hasStatus(null)).toBe(false);
    expect(hasStatus({})).toBe(false);
  });

  it("hasMessage", () => {
    expect(hasMessage({ message: "hi" })).toBe(true);
    expect(hasMessage({ message: 42 })).toBe(false);
    expect(hasMessage(null)).toBe(false);
    expect(hasMessage({})).toBe(false);
  });
});

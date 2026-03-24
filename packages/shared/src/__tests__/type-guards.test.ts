import { describe, expect, it } from "bun:test";
import { getErrorMessage, hasStatus, isNumber, isPlainObject, isString, toObjectArray, toRecord } from "../type-guards";

describe("isPlainObject", () => {
  it("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(
      isPlainObject({
        a: 1,
      }),
    ).toBe(true);
    expect(
      isPlainObject({
        nested: {
          b: 2,
        },
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPlainObject(undefined)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isPlainObject([])).toBe(false);
    expect(
      isPlainObject([
        1,
        2,
        3,
      ]),
    ).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isPlainObject("str")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });
});

describe("isString", () => {
  it("returns true for strings", () => {
    expect(isString("")).toBe(true);
    expect(isString("hello")).toBe(true);
  });

  it("returns false for non-strings", () => {
    expect(isString(42)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString({})).toBe(false);
  });
});

describe("isNumber", () => {
  it("returns true for numbers", () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(42)).toBe(true);
    expect(isNumber(-1)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(true);
  });

  it("returns false for non-numbers", () => {
    expect(isNumber("42")).toBe(false);
    expect(isNumber(null)).toBe(false);
    expect(isNumber(undefined)).toBe(false);
  });
});

describe("hasStatus", () => {
  it("returns true for objects with numeric status", () => {
    expect(
      hasStatus({
        status: 200,
      }),
    ).toBe(true);
    expect(
      hasStatus({
        status: 0,
      }),
    ).toBe(true);
    expect(
      hasStatus({
        status: 500,
        other: "field",
      }),
    ).toBe(true);
  });

  it("returns false for objects without numeric status", () => {
    expect(
      hasStatus({
        status: "ok",
      }),
    ).toBe(false);
    expect(hasStatus({})).toBe(false);
    expect(
      hasStatus({
        status: undefined,
      }),
    ).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(hasStatus(null)).toBe(false);
    expect(hasStatus(undefined)).toBe(false);
    expect(hasStatus("string")).toBe(false);
  });
});

describe("getErrorMessage", () => {
  it("returns .message for Error-like objects", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(
      getErrorMessage({
        message: "custom error",
      }),
    ).toBe("custom error");
  });

  it("returns String(err) for non-Error values", () => {
    expect(getErrorMessage("string error")).toBe("string error");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});

describe("toRecord", () => {
  it("returns plain objects as-is", () => {
    const obj = {
      a: 1,
    };
    expect(toRecord(obj)).toBe(obj);
    expect(toRecord({})).toEqual({});
  });

  it("returns null for non-plain-objects", () => {
    expect(toRecord(null)).toBeNull();
    expect(toRecord(undefined)).toBeNull();
    expect(
      toRecord([
        1,
        2,
      ]),
    ).toBeNull();
    expect(toRecord("str")).toBeNull();
    expect(toRecord(42)).toBeNull();
  });
});

describe("toObjectArray", () => {
  it("filters non-plain-object items from arrays", () => {
    const result = toObjectArray([
      {
        a: 1,
      },
      "skip",
      null,
      {
        b: 2,
      },
      42,
    ]);
    expect(result).toEqual([
      {
        a: 1,
      },
      {
        b: 2,
      },
    ]);
  });

  it("returns all items if all are plain objects", () => {
    expect(
      toObjectArray([
        {
          x: 1,
        },
        {
          y: 2,
        },
      ]),
    ).toEqual([
      {
        x: 1,
      },
      {
        y: 2,
      },
    ]);
  });

  it("returns empty array for non-arrays", () => {
    expect(toObjectArray("not array")).toEqual([]);
    expect(toObjectArray(null)).toEqual([]);
    expect(toObjectArray(undefined)).toEqual([]);
    expect(toObjectArray(42)).toEqual([]);
    expect(toObjectArray({})).toEqual([]);
  });

  it("returns empty array for array of only non-objects", () => {
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

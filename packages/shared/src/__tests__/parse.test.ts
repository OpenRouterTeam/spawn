import { describe, it, expect } from "bun:test";
import * as v from "valibot";
import { parseJsonWith, parseJsonObj } from "../parse";

describe("parseJsonWith", () => {
  const UserSchema = v.object({ id: v.number(), name: v.string() });

  it("returns validated data for valid JSON matching schema", () => {
    const result = parseJsonWith('{"id": 1, "name": "Alice"}', UserSchema);
    expect(result).toEqual({ id: 1, name: "Alice" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonWith("not json", UserSchema)).toBeNull();
    expect(parseJsonWith("{broken", UserSchema)).toBeNull();
  });

  it("returns null for valid JSON that does not match schema", () => {
    expect(parseJsonWith('{"id": "not-a-number", "name": "Alice"}', UserSchema)).toBeNull();
    expect(parseJsonWith('{"wrong": "shape"}', UserSchema)).toBeNull();
  });

  it("works with simple schemas", () => {
    const StringSchema = v.string();
    expect(parseJsonWith('"hello"', StringSchema)).toBe("hello");
    expect(parseJsonWith("42", StringSchema)).toBeNull();
  });

  it("works with array schemas", () => {
    const ArraySchema = v.array(v.number());
    expect(parseJsonWith("[1, 2, 3]", ArraySchema)).toEqual([1, 2, 3]);
    expect(parseJsonWith('["a", "b"]', ArraySchema)).toBeNull();
  });
});

describe("parseJsonObj", () => {
  it("returns Record for valid JSON objects", () => {
    expect(parseJsonObj('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonObj('{"nested": {"b": 2}}')).toEqual({ nested: { b: 2 } });
  });

  it("returns null for JSON arrays", () => {
    expect(parseJsonObj("[1, 2]")).toBeNull();
  });

  it("returns null for JSON primitives", () => {
    expect(parseJsonObj('"str"')).toBeNull();
    expect(parseJsonObj("42")).toBeNull();
    expect(parseJsonObj("true")).toBeNull();
    expect(parseJsonObj("null")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonObj("not json")).toBeNull();
    expect(parseJsonObj("{broken")).toBeNull();
    expect(parseJsonObj("")).toBeNull();
  });
});

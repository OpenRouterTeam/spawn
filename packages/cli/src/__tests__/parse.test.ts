import { describe, it, expect } from "bun:test";
import * as v from "valibot";
import { parseJsonWith, parseJsonRaw } from "../shared/parse";

describe("parseJsonWith", () => {
  const NumberSchema = v.object({
    count: v.number(),
  });

  it("should return validated data for valid JSON matching the schema", () => {
    const result = parseJsonWith('{"count": 42}', NumberSchema);
    expect(result).toEqual({
      count: 42,
    });
  });

  it("should return null for valid JSON that doesn't match the schema", () => {
    const result = parseJsonWith('{"count": "not a number"}', NumberSchema);
    expect(result).toBeNull();
  });

  it("should return null for invalid JSON", () => {
    const result = parseJsonWith("not json at all", NumberSchema);
    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = parseJsonWith("", NumberSchema);
    expect(result).toBeNull();
  });

  it("should handle nested schemas", () => {
    const NestedSchema = v.object({
      user: v.object({
        name: v.string(),
        age: v.number(),
      }),
    });
    const result = parseJsonWith('{"user": {"name": "Alice", "age": 30}}', NestedSchema);
    expect(result).toEqual({
      user: {
        name: "Alice",
        age: 30,
      },
    });
  });

  it("should handle optional fields", () => {
    const OptSchema = v.object({
      name: v.string(),
      email: v.optional(v.string()),
    });
    const result = parseJsonWith('{"name": "Bob"}', OptSchema);
    expect(result).toEqual({
      name: "Bob",
    });
  });

  it("should handle record schemas", () => {
    const RecordSchema = v.record(v.string(), v.unknown());
    const result = parseJsonWith('{"key": "value", "num": 1}', RecordSchema);
    expect(result).toEqual({
      key: "value",
      num: 1,
    });
  });

  it("should reject array when object schema expected", () => {
    const result = parseJsonWith("[1, 2, 3]", NumberSchema);
    expect(result).toBeNull();
  });
});

describe("parseJsonRaw", () => {
  it("should parse valid JSON to unknown", () => {
    const result = parseJsonRaw('{"key": "value"}');
    expect(result).toEqual({
      key: "value",
    });
  });

  it("should parse JSON arrays", () => {
    const result = parseJsonRaw("[1, 2, 3]");
    expect(result).toEqual([
      1,
      2,
      3,
    ]);
  });

  it("should return null for invalid JSON", () => {
    const result = parseJsonRaw("not json");
    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = parseJsonRaw("");
    expect(result).toBeNull();
  });

  it("should parse primitive JSON values", () => {
    expect(parseJsonRaw("42")).toBe(42);
    expect(parseJsonRaw('"hello"')).toBe("hello");
    expect(parseJsonRaw("true")).toBe(true);
    expect(parseJsonRaw("null")).toBeNull();
  });
});

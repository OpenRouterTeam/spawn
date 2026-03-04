import { describe, it, expect } from "bun:test";
import { OAUTH_CODE_REGEX } from "../shared/oauth";

describe("OAUTH_CODE_REGEX", () => {
  it("accepts alphanumeric, hyphens, and underscores (regression #2116)", () => {
    expect(OAUTH_CODE_REGEX.test("abc123def456ghi789")).toBe(true);
    expect(OAUTH_CODE_REGEX.test("abcdef12-3456-7890-abcd")).toBe(true);
    expect(OAUTH_CODE_REGEX.test("auth_code_abc123def456")).toBe(true);
    expect(OAUTH_CODE_REGEX.test("code_with-both_styles-here")).toBe(true);
  });

  it("enforces length bounds (16–128)", () => {
    expect(OAUTH_CODE_REGEX.test("a".repeat(15))).toBe(false);
    expect(OAUTH_CODE_REGEX.test("a".repeat(16))).toBe(true);
    expect(OAUTH_CODE_REGEX.test("a".repeat(128))).toBe(true);
    expect(OAUTH_CODE_REGEX.test("a".repeat(129))).toBe(false);
  });

  it("rejects dangerous characters", () => {
    expect(OAUTH_CODE_REGEX.test("code;rm -rf /abc")).toBe(false);
    expect(OAUTH_CODE_REGEX.test("code<script>alert")).toBe(false);
    expect(OAUTH_CODE_REGEX.test("code with spaces!")).toBe(false);
    expect(OAUTH_CODE_REGEX.test("")).toBe(false);
  });
});

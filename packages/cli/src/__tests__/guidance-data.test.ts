import { describe, expect, it } from "bun:test";
import { buildDashboardHint } from "../guidance-data";

describe("buildDashboardHint", () => {
  it("returns a hint with the URL when provided", () => {
    const result = buildDashboardHint("https://example.com/dashboard");
    expect(result).toContain("https://example.com/dashboard");
    expect(result).toContain("Check your dashboard");
  });

  it("returns a generic hint when URL is undefined", () => {
    const result = buildDashboardHint(undefined);
    expect(result).toContain("Check your cloud provider dashboard");
    expect(result).not.toContain("undefined");
  });

  it("returns a generic hint when URL is empty string", () => {
    const result = buildDashboardHint("");
    expect(result).toContain("Check your cloud provider dashboard");
  });
});

import { describe, expect, it } from "bun:test";
import { parsePickerInput } from "../picker";

describe("parsePickerInput", () => {
  it("parses three-field tab-separated lines (value, label, hint)", () => {
    const result = parsePickerInput("us-east-1\tVirginia\tRecommended");
    expect(result).toEqual([
      {
        value: "us-east-1",
        label: "Virginia",
        hint: "Recommended",
      },
    ]);
  });

  it("parses two-field lines (value, label) with no hint", () => {
    const result = parsePickerInput("us-east-1\tVirginia");
    expect(result).toEqual([
      {
        value: "us-east-1",
        label: "Virginia",
      },
    ]);
  });

  it("uses value as label when only value is provided", () => {
    const result = parsePickerInput("us-east-1");
    expect(result).toEqual([
      {
        value: "us-east-1",
        label: "us-east-1",
      },
    ]);
  });

  it("filters empty and whitespace-only lines", () => {
    const result = parsePickerInput("a\tAlpha\n\n   \nb\tBeta\n");
    expect(result).toEqual([
      {
        value: "a",
        label: "Alpha",
      },
      {
        value: "b",
        label: "Beta",
      },
    ]);
  });

  it("handles mixed field counts in a single input", () => {
    const input = [
      "val1\tLabel1\tHint1",
      "val2\tLabel2",
      "val3",
    ].join("\n");
    const result = parsePickerInput(input);
    expect(result).toEqual([
      {
        value: "val1",
        label: "Label1",
        hint: "Hint1",
      },
      {
        value: "val2",
        label: "Label2",
      },
      {
        value: "val3",
        label: "val3",
      },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parsePickerInput("")).toEqual([]);
    expect(parsePickerInput("   ")).toEqual([]);
    expect(parsePickerInput("\n\n")).toEqual([]);
  });

  it("trims whitespace from fields", () => {
    const result = parsePickerInput("  val \t  Label \t  Hint  ");
    expect(result).toEqual([
      {
        value: "val",
        label: "Label",
        hint: "Hint",
      },
    ]);
  });

  it("parses multiple lines correctly", () => {
    const input = "us-central1-a\tIowa\nus-east1-b\tVirginia";
    const result = parsePickerInput(input);
    expect(result).toEqual([
      {
        value: "us-central1-a",
        label: "Iowa",
      },
      {
        value: "us-east1-b",
        label: "Virginia",
      },
    ]);
  });
});

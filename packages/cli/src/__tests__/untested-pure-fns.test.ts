import type { Manifest } from "../manifest.js";

import { describe, expect, it } from "bun:test";
import { resolveDisplayName } from "../commands/index.js";
import { groupByType } from "../commands/shared.js";
import { validateScriptTemplate } from "../shared/agent-setup.js";

// ── validateScriptTemplate ───────────────────────────────────────────────────

describe("validateScriptTemplate", () => {
  it("accepts plain strings without interpolation", () => {
    expect(() => validateScriptTemplate("echo hello", "test")).not.toThrow();
    expect(() => validateScriptTemplate("", "empty")).not.toThrow();
  });

  it("accepts backticks (used in markdown skill content)", () => {
    expect(() => validateScriptTemplate("echo `date`", "backtick")).not.toThrow();
    expect(() => validateScriptTemplate("```code block```", "markdown")).not.toThrow();
  });

  it("accepts bare dollar signs and $VAR references", () => {
    expect(() => validateScriptTemplate("echo $HOME", "env")).not.toThrow();
    expect(() => validateScriptTemplate("cost is $5.00", "dollar")).not.toThrow();
  });

  it("throws on ${} interpolation patterns", () => {
    expect(() => validateScriptTemplate("echo ${HOME}", "interp")).toThrow(/contains \$\{\} interpolation/);
    expect(() => validateScriptTemplate("${}", "empty-interp")).toThrow(/contains \$\{\} interpolation/);
    expect(() => validateScriptTemplate("prefix ${foo} suffix", "mid")).toThrow(/contains \$\{\} interpolation/);
  });

  it("includes the label in the error message", () => {
    expect(() => validateScriptTemplate("${x}", "my-script")).toThrow(/my-script/);
  });

  it("throws on nested interpolation", () => {
    expect(() => validateScriptTemplate("${a${b}}", "nested")).toThrow(/contains \$\{\} interpolation/);
  });
});

// ── resolveDisplayName ───────────────────────────────────────────────────────

describe("resolveDisplayName", () => {
  const manifest: Manifest = {
    agents: {
      claude: {
        name: "Claude Code",
        description: "desc",
        url: "https://example.com",
        install: "npm i",
        launch: "claude",
        env: {},
      },
    },
    clouds: {
      sprite: {
        name: "Sprite",
        description: "desc",
        price: "$5/mo",
        url: "https://example.com",
        type: "managed",
        auth: "SPRITE_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: {
      "sprite/claude": "implemented",
    },
  };

  it("returns the display name for a known agent", () => {
    expect(resolveDisplayName(manifest, "claude", "agent")).toBe("Claude Code");
  });

  it("returns the display name for a known cloud", () => {
    expect(resolveDisplayName(manifest, "sprite", "cloud")).toBe("Sprite");
  });

  it("returns the raw key when agent is not in manifest", () => {
    expect(resolveDisplayName(manifest, "unknown-agent", "agent")).toBe("unknown-agent");
  });

  it("returns the raw key when cloud is not in manifest", () => {
    expect(resolveDisplayName(manifest, "unknown-cloud", "cloud")).toBe("unknown-cloud");
  });

  it("returns the raw key when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
    expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
  });
});

// ── groupByType ──────────────────────────────────────────────────────────────

describe("groupByType", () => {
  it("groups keys by the classifier function", () => {
    const types: Record<string, string> = {
      sprite: "managed",
      hetzner: "self-hosted",
      aws: "self-hosted",
      gcp: "self-hosted",
    };
    const result = groupByType(
      [
        "sprite",
        "hetzner",
        "aws",
        "gcp",
      ],
      (k) => types[k],
    );
    expect(result).toEqual({
      managed: [
        "sprite",
      ],
      "self-hosted": [
        "hetzner",
        "aws",
        "gcp",
      ],
    });
  });

  it("returns empty object for empty input", () => {
    expect(groupByType([], () => "any")).toEqual({});
  });

  it("handles single group", () => {
    const result = groupByType(
      [
        "a",
        "b",
        "c",
      ],
      () => "same",
    );
    expect(result).toEqual({
      same: [
        "a",
        "b",
        "c",
      ],
    });
  });

  it("handles each key in its own group", () => {
    const result = groupByType(
      [
        "x",
        "y",
      ],
      (k) => k,
    );
    expect(result).toEqual({
      x: [
        "x",
      ],
      y: [
        "y",
      ],
    });
  });
});

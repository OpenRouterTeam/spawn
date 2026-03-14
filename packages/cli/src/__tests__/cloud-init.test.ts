import { describe, expect, it } from "bun:test";
import { getPackagesForTier, NODE_INSTALL_CMD, needsBun, needsNode } from "../shared/cloud-init.js";

describe("getPackagesForTier", () => {
  const MINIMAL_PACKAGES = [
    "curl",
    "unzip",
    "git",
    "ca-certificates",
  ];

  it("returns minimal packages for 'minimal' tier", () => {
    const pkgs = getPackagesForTier("minimal");
    expect(pkgs).toEqual(MINIMAL_PACKAGES);
  });

  it("returns minimal + zsh + build-essential for 'node' tier", () => {
    const pkgs = getPackagesForTier("node");
    for (const p of MINIMAL_PACKAGES) {
      expect(pkgs).toContain(p);
    }
    expect(pkgs).toContain("zsh");
    expect(pkgs).toContain("build-essential");
  });

  it("returns minimal + zsh but NOT build-essential for 'bun' tier", () => {
    const pkgs = getPackagesForTier("bun");
    for (const p of MINIMAL_PACKAGES) {
      expect(pkgs).toContain(p);
    }
    expect(pkgs).toContain("zsh");
    expect(pkgs).not.toContain("build-essential");
  });

  it("returns minimal + zsh + build-essential for 'full' tier", () => {
    const pkgs = getPackagesForTier("full");
    for (const p of MINIMAL_PACKAGES) {
      expect(pkgs).toContain(p);
    }
    expect(pkgs).toContain("zsh");
    expect(pkgs).toContain("build-essential");
  });

  it("defaults to 'full' tier when no argument given", () => {
    expect(getPackagesForTier()).toEqual(getPackagesForTier("full"));
  });
});

describe("needsNode", () => {
  const cases: Array<
    [
      Parameters<typeof needsNode>[0],
      boolean,
    ]
  > = [
    [
      "node",
      true,
    ],
    [
      "full",
      true,
    ],
    [
      "minimal",
      false,
    ],
    [
      "bun",
      false,
    ],
  ];
  for (const [tier, expected] of cases) {
    it(`returns ${expected} for '${tier}' tier`, () => {
      expect(needsNode(tier)).toBe(expected);
    });
  }
  it("defaults to true (full tier)", () => {
    expect(needsNode()).toBe(true);
  });
});

describe("needsBun", () => {
  const cases: Array<
    [
      Parameters<typeof needsBun>[0],
      boolean,
    ]
  > = [
    [
      "bun",
      true,
    ],
    [
      "full",
      true,
    ],
    [
      "minimal",
      false,
    ],
    [
      "node",
      false,
    ],
  ];
  for (const [tier, expected] of cases) {
    it(`returns ${expected} for '${tier}' tier`, () => {
      expect(needsBun(tier)).toBe(expected);
    });
  }
  it("defaults to true (full tier)", () => {
    expect(needsBun()).toBe(true);
  });
});

describe("NODE_INSTALL_CMD", () => {
  it("is a curl-based install command targeting Node 22", () => {
    expect(NODE_INSTALL_CMD).toContain("curl");
    expect(NODE_INSTALL_CMD).toContain("22");
  });
});

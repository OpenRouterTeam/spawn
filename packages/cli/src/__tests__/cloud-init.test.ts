import { describe, expect, it } from "bun:test";
import { getPackagesForTier, needsBun, needsNode, shouldSkipCloudInit } from "../shared/cloud-init.js";

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

describe("shouldSkipCloudInit", () => {
  it("returns true when useDocker is true", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: true,
      }),
    ).toBe(true);
  });

  it("returns true when snapshotId is a non-null string", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: false,
        snapshotId: "snap-123",
      }),
    ).toBe(true);
  });

  it("returns true when skipCloudInit is true", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: false,
        skipCloudInit: true,
      }),
    ).toBe(true);
  });

  it("returns false when all flags are off", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: false,
      }),
    ).toBe(false);
  });

  it("returns false when snapshotId is null", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: false,
        snapshotId: null,
      }),
    ).toBe(false);
  });

  it("returns false when snapshotId is undefined", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: false,
        snapshotId: undefined,
      }),
    ).toBe(false);
  });

  it("returns false when skipCloudInit is false", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: false,
        skipCloudInit: false,
      }),
    ).toBe(false);
  });

  it("returns true when multiple flags are set", () => {
    expect(
      shouldSkipCloudInit({
        useDocker: true,
        snapshotId: "snap-1",
        skipCloudInit: true,
      }),
    ).toBe(true);
  });
});

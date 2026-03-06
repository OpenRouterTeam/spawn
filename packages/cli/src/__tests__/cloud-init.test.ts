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
  it("returns true for 'node' tier", () => {
    expect(needsNode("node")).toBe(true);
  });

  it("returns true for 'full' tier", () => {
    expect(needsNode("full")).toBe(true);
  });

  it("returns false for 'minimal' tier", () => {
    expect(needsNode("minimal")).toBe(false);
  });

  it("returns false for 'bun' tier", () => {
    expect(needsNode("bun")).toBe(false);
  });

  it("defaults to true (full tier)", () => {
    expect(needsNode()).toBe(true);
  });
});

describe("needsBun", () => {
  it("returns true for 'bun' tier", () => {
    expect(needsBun("bun")).toBe(true);
  });

  it("returns true for 'full' tier", () => {
    expect(needsBun("full")).toBe(true);
  });

  it("returns false for 'minimal' tier", () => {
    expect(needsBun("minimal")).toBe(false);
  });

  it("returns false for 'node' tier", () => {
    expect(needsBun("node")).toBe(false);
  });

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

// Unit tests for shared/install-id.ts — persistent UUID generation and read.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { _resetInstallIdCache, getInstallId } from "../shared/install-id.js";
import { getInstallIdPath } from "../shared/paths.js";

describe("getInstallId", () => {
  beforeEach(() => {
    _resetInstallIdCache();
    const path = getInstallIdPath();
    if (existsSync(path)) {
      rmSync(path);
    }
  });

  afterEach(() => {
    _resetInstallIdCache();
  });

  it("creates a UUID on first call and persists it", () => {
    const id = getInstallId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(existsSync(getInstallIdPath())).toBe(true);
    expect(readFileSync(getInstallIdPath(), "utf8").trim()).toBe(id);
  });

  it("returns the same value on subsequent calls (in-memory cache)", () => {
    const a = getInstallId();
    const b = getInstallId();
    expect(a).toBe(b);
  });

  it("reads from disk on a fresh module state", () => {
    const a = getInstallId();
    _resetInstallIdCache();
    const b = getInstallId();
    expect(a).toBe(b);
  });

  it("regenerates if the persisted file is malformed", () => {
    writeFileSync(getInstallIdPath(), "not-a-uuid");
    _resetInstallIdCache();
    const id = getInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe("not-a-uuid");
  });
});

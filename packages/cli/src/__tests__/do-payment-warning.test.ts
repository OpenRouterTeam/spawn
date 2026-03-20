/**
 * do-payment-warning.test.ts
 *
 * Verifies that ensureDoToken() shows a proactive payment method reminder to
 * first-time DigitalOcean users who have no saved config and no env token.
 *
 * Uses spyOn on the real ui module to avoid mock.module contamination.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ui from "../shared/ui";
import { mockClackPrompts } from "./test-helpers";

// Mock @clack/prompts (required for DO module)
mockClackPrompts();

const { ensureDoToken } = await import("../digitalocean/digitalocean");

describe("ensureDoToken — payment method warning for first-time users", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let stderrSpy: ReturnType<typeof spyOn>;
  let loadApiTokenSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Save and clear DO_API_TOKEN
    savedEnv["DO_API_TOKEN"] = process.env.DO_API_TOKEN;
    delete process.env.DO_API_TOKEN;

    // Fail OAuth connectivity check → tryDoOAuth returns null immediately
    globalThis.fetch = mock(() => Promise.reject(new Error("Network unreachable")));

    // Suppress stderr noise
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    // Control ui functions via spyOn
    loadApiTokenSpy = spyOn(ui, "loadApiToken").mockReturnValue(null);
    promptSpy = spyOn(ui, "prompt").mockImplementation(async () => "");
    warnSpy = spyOn(ui, "logWarn");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    stderrSpy.mockRestore();
    loadApiTokenSpy.mockRestore();
    promptSpy.mockRestore();
    warnSpy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("shows payment method warning for first-time users (no saved token, no env var)", async () => {
    await expect(ensureDoToken()).rejects.toThrow("User chose to exit");

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(true);
    expect(warnMessages.some((msg: string) => msg.includes("cloud.digitalocean.com/account/billing"))).toBe(true);
  });

  it("does NOT show payment warning when a saved token exists (returning user)", async () => {
    loadApiTokenSpy.mockImplementation((cloud: string) => (cloud === "digitalocean" ? "dop_v1_invalid" : null));

    await expect(ensureDoToken()).rejects.toThrow();

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
  });

  it("does NOT show payment warning when DO_API_TOKEN env var is set", async () => {
    process.env.DO_API_TOKEN = "dop_v1_invalid_env_token";

    await expect(ensureDoToken()).rejects.toThrow();

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
  });

  it("billing URL in warning points to the DigitalOcean billing page", async () => {
    await expect(ensureDoToken()).rejects.toThrow("User chose to exit");

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const billingWarning = warnMessages.find((msg: string) => msg.includes("billing"));
    expect(billingWarning).toBeDefined();
    expect(billingWarning).toContain("https://cloud.digitalocean.com/account/billing");
  });
});

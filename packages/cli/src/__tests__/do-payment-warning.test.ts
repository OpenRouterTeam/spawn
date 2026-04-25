/**
 * do-payment-warning.test.ts
 *
 * Verifies that ensureDoToken() does not show a preemptive payment-method banner
 * before OAuth (billing guidance is shown when resolving the payment_required
 * readiness step via handleBillingError).
 *
 * Uses spyOn on the real ui module to avoid mock.module contamination.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ui from "../shared/ui";
import { mockClackPrompts } from "./test-helpers";

// Mock @clack/prompts (required for DO module)
mockClackPrompts();

const { ensureDoToken } = await import("../digitalocean/digitalocean");

describe("ensureDoToken — no preemptive payment banner before OAuth", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let stderrSpy: ReturnType<typeof spyOn>;
  let loadApiTokenSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Save and clear all accepted DigitalOcean token env vars
    for (const v of [
      "DIGITALOCEAN_ACCESS_TOKEN",
      "DIGITALOCEAN_API_TOKEN",
      "DO_API_TOKEN",
    ]) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }

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

  it("does not show payment method warning for first-time users (no saved token, no env var)", async () => {
    await expect(ensureDoToken()).rejects.toThrow("User chose to exit");

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
    expect(warnMessages.some((msg: string) => msg.includes("cloud.digitalocean.com/account/billing"))).toBe(false);
  });

  it("does NOT show payment warning when a saved token exists (returning user)", async () => {
    loadApiTokenSpy.mockImplementation((cloud: string) => (cloud === "digitalocean" ? "dop_v1_invalid" : null));

    await expect(ensureDoToken()).rejects.toThrow();

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
  });

  it("does NOT show payment warning when DIGITALOCEAN_ACCESS_TOKEN env var is set", async () => {
    process.env.DIGITALOCEAN_ACCESS_TOKEN = "dop_v1_invalid_env_token";

    await expect(ensureDoToken()).rejects.toThrow();

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
  });

  it("does NOT show payment warning when DIGITALOCEAN_API_TOKEN env var is set", async () => {
    process.env.DIGITALOCEAN_API_TOKEN = "dop_v1_invalid_env_token";

    await expect(ensureDoToken()).rejects.toThrow();

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
  });

  it("does NOT show payment warning when legacy DO_API_TOKEN env var is set", async () => {
    process.env.DO_API_TOKEN = "dop_v1_invalid_env_token";

    await expect(ensureDoToken()).rejects.toThrow();

    const warnMessages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnMessages.some((msg: string) => msg.includes("payment method"))).toBe(false);
  });
});

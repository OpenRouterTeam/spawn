/**
 * do-payment-warning.test.ts
 *
 * Verifies that ensureDoToken() shows a proactive payment method reminder to
 * first-time DigitalOcean users who have no saved config and no env token.
 *
 * Design note: we spread the real ../shared/ui implementations so other tests
 * that run in the same worker (e.g. ui-utils.test.ts, billing-guidance.test.ts)
 * still get real validation functions. We only override what we need to control.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// ── Import the real ui module so we can spread its implementations ────────────
// This prevents contaminating ui-utils.test.ts which tests real validation logic.

import * as realUI from "../shared/ui";

// ── Controlled overrides ──────────────────────────────────────────────────────

const mockLoadApiToken = mock((_cloud: string): string | null => null);
const warnMessages: string[] = [];
const mockLogWarn = mock((msg: string) => {
  warnMessages.push(msg);
});
const mockPrompt = mock(() => Promise.resolve(""));
const mockLogStep = mock(() => {});
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});

// Spread real implementations so other test files still get working functions.
// Only override the handful of functions we need to control for this test.
mock.module("../shared/ui", () => ({
  ...realUI,
  loadApiToken: mockLoadApiToken,
  logWarn: mockLogWarn,
  prompt: mockPrompt,
  logStep: mockLogStep,
  logError: mockLogError,
  logInfo: mockLogInfo,
  logStepDone: mock(() => {}),
  logStepInline: mock(() => {}),
  openBrowser: mock(() => {}),
}));

// ── Import unit under test ────────────────────────────────────────────────────

const { ensureDoToken } = await import("../digitalocean/digitalocean");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ensureDoToken — payment method warning for first-time users", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockLogWarn.mockClear();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockPrompt.mockClear();
    mockLoadApiToken.mockClear();
    warnMessages.length = 0;

    // Save and clear DO_API_TOKEN
    savedEnv["DO_API_TOKEN"] = process.env.DO_API_TOKEN;
    delete process.env.DO_API_TOKEN;

    // Fail OAuth connectivity check → tryDoOAuth returns null immediately
    globalThis.fetch = mock(() => Promise.reject(new Error("Network unreachable")));

    // Suppress stderr noise
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    stderrSpy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("shows payment method warning for first-time users (no saved token, no env var)", async () => {
    mockLoadApiToken.mockImplementation(() => null);
    // Empty prompt responses → manual entry fails × 3 → throws
    mockPrompt.mockImplementation(() => Promise.resolve(""));

    await expect(ensureDoToken()).rejects.toThrow("DigitalOcean authentication failed");

    expect(warnMessages.some((msg) => msg.includes("payment method"))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes("cloud.digitalocean.com/account/billing"))).toBe(true);
  });

  it("does NOT show payment warning when a saved token exists (returning user)", async () => {
    // Saved token exists but is invalid (fetch rejects so testDoToken fails)
    mockLoadApiToken.mockImplementation((cloud) => (cloud === "digitalocean" ? "dop_v1_invalid" : null));
    mockPrompt.mockImplementation(() => Promise.resolve(""));

    await expect(ensureDoToken()).rejects.toThrow();

    expect(warnMessages.some((msg) => msg.includes("payment method"))).toBe(false);
  });

  it("does NOT show payment warning when DO_API_TOKEN env var is set", async () => {
    process.env.DO_API_TOKEN = "dop_v1_invalid_env_token";
    mockLoadApiToken.mockImplementation(() => null);
    mockPrompt.mockImplementation(() => Promise.resolve(""));

    await expect(ensureDoToken()).rejects.toThrow();

    expect(warnMessages.some((msg) => msg.includes("payment method"))).toBe(false);
  });

  it("billing URL in warning points to the DigitalOcean billing page", async () => {
    mockLoadApiToken.mockImplementation(() => null);
    mockPrompt.mockImplementation(() => Promise.resolve(""));

    await expect(ensureDoToken()).rejects.toThrow("DigitalOcean authentication failed");

    const billingWarning = warnMessages.find((msg) => msg.includes("billing"));
    expect(billingWarning).toBeDefined();
    expect(billingWarning).toContain("https://cloud.digitalocean.com/account/billing");
  });
});

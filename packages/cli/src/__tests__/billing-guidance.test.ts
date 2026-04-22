import type { BillingGuidanceDeps } from "../shared/billing-guidance";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { awsBilling } from "../aws/billing";
import { DIGITALOCEAN_BILLING_ADD_PAYMENT_URL, digitaloceanBilling } from "../digitalocean/billing";
import { gcpBilling } from "../gcp/billing";
import { hetznerBilling } from "../hetzner/billing";
import { handleBillingError, isBillingError, showNonBillingError } from "../shared/billing-guidance";

// ── Mock deps (injected via DI, not mock.module) ──────────────────────────

const mockOpenBrowser = mock(() => {});
const mockPrompt = mock(() => Promise.resolve(""));

function createMockDeps(): BillingGuidanceDeps {
  return {
    logInfo: mock(() => {}),
    logStep: mock(() => {}),
    logWarn: mock(() => {}),
    openBrowser: mockOpenBrowser,
    prompt: mockPrompt,
  };
}

describe("isBillingError", () => {
  describe("hetzner", () => {
    it("matches insufficient_funds", () => {
      expect(isBillingError(hetznerBilling, "insufficient funds")).toBe(true);
      expect(isBillingError(hetznerBilling, "insufficient_funds")).toBe(true);
    });

    it("matches payment method required", () => {
      expect(isBillingError(hetznerBilling, "payment method required")).toBe(true);
    });

    it("matches account locked/blocked", () => {
      expect(isBillingError(hetznerBilling, "account is locked")).toBe(true);
      expect(isBillingError(hetznerBilling, "account blocked")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError(hetznerBilling, "server limit reached")).toBe(false);
      expect(isBillingError(hetznerBilling, "server type unavailable")).toBe(false);
    });
  });

  describe("digitalocean", () => {
    it("matches billing-related errors", () => {
      expect(isBillingError(digitaloceanBilling, "insufficient funds")).toBe(true);
      expect(isBillingError(digitaloceanBilling, "payment required")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError(digitaloceanBilling, "droplet limit reached")).toBe(false);
      expect(isBillingError(digitaloceanBilling, "region unavailable")).toBe(false);
    });

    it("matches billing error embedded in doApi thrown error message (regression #2395)", () => {
      // doApi throws: `DigitalOcean API error ${status} for ${method} ${endpoint}: ${body}`
      // The response body contains the billing message — isBillingError must detect it.
      const apiErr =
        'DigitalOcean API error 403 for POST /droplets: {"id":"forbidden","message":"A payment on file is required to create resources."}';
      expect(isBillingError(digitaloceanBilling, apiErr)).toBe(true);
    });

    it("returns false for non-billing 403 in doApi error format", () => {
      const apiErr =
        'DigitalOcean API error 403 for POST /droplets: {"id":"forbidden","message":"Droplet limit exceeded for this account."}';
      expect(isBillingError(digitaloceanBilling, apiErr)).toBe(false);
    });
  });

  describe("aws", () => {
    it("matches activation/billing errors", () => {
      expect(isBillingError(awsBilling, "account not activated")).toBe(true);
      expect(isBillingError(awsBilling, "subscription required")).toBe(true);
      expect(isBillingError(awsBilling, "not been enabled")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError(awsBilling, "instance limit reached")).toBe(false);
      expect(isBillingError(awsBilling, "bundle unavailable")).toBe(false);
    });
  });

  describe("gcp", () => {
    it("matches BILLING_DISABLED", () => {
      expect(isBillingError(gcpBilling, "BILLING_DISABLED")).toBe(true);
    });

    it("matches billing not enabled", () => {
      expect(isBillingError(gcpBilling, "billing is not enabled")).toBe(true);
      expect(isBillingError(gcpBilling, "billing disabled")).toBe(true);
    });

    it("matches billing account errors", () => {
      expect(isBillingError(gcpBilling, "no billing account linked")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError(gcpBilling, "quota exceeded")).toBe(false);
      expect(isBillingError(gcpBilling, "machine type unavailable")).toBe(false);
    });
  });

  describe("empty config", () => {
    it("returns false for config with no error patterns", () => {
      const emptyConfig = {
        billingUrl: "",
        setupSteps: [],
        errorPatterns: [],
      };
      expect(isBillingError(emptyConfig, "billing error")).toBe(false);
    });
  });
});

describe("handleBillingError", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    mockOpenBrowser.mockClear();
    mockPrompt.mockClear();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("opens billing URL and returns true when user presses Enter", async () => {
    mockPrompt.mockImplementation(() => Promise.resolve(""));
    const deps = createMockDeps();
    const result = await handleBillingError(hetznerBilling, deps);
    expect(result).toBe(true);
    expect(deps.openBrowser).toHaveBeenCalledWith("https://console.hetzner.cloud/");
  });

  it("returns false when prompt throws (Ctrl+C)", async () => {
    mockPrompt.mockImplementation(() => Promise.reject(new Error("cancelled")));
    const result = await handleBillingError(digitaloceanBilling, createMockDeps());
    expect(result).toBe(false);
  });

  it("opens DigitalOcean add-payment billing URL (readiness payment_required step)", async () => {
    mockPrompt.mockImplementation(() => Promise.resolve(""));
    const deps = createMockDeps();
    const result = await handleBillingError(digitaloceanBilling, deps);
    expect(result).toBe(true);
    expect(deps.openBrowser).toHaveBeenCalledWith(DIGITALOCEAN_BILLING_ADD_PAYMENT_URL);
  });

  it("works for config without billing URL", async () => {
    mockPrompt.mockImplementation(() => Promise.resolve(""));
    const deps = createMockDeps();
    const emptyConfig = {
      billingUrl: "",
      setupSteps: [],
      errorPatterns: [],
    };
    const result = await handleBillingError(emptyConfig, deps);
    expect(result).toBe(true);
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });
});

describe("showNonBillingError", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("does not throw", () => {
    const deps = createMockDeps();
    expect(() => {
      showNonBillingError(
        hetznerBilling,
        [
          "Server limit reached for your account",
        ],
        deps,
      );
    }).not.toThrow();
  });
});

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// Mock the ui module before importing billing-guidance
const mockOpenBrowser = mock(() => {});
const mockPrompt = mock(() => Promise.resolve(""));

mock.module("../shared/ui", () => ({
  logError: mock(() => {}),
  logInfo: mock(() => {}),
  logStep: mock(() => {}),
  logWarn: mock(() => {}),
  openBrowser: mockOpenBrowser,
  prompt: mockPrompt,
}));

const { getBillingUrl, getSetupSteps, handleBillingError, isBillingError, showNonBillingError } = await import(
  "../shared/billing-guidance"
);

describe("isBillingError", () => {
  describe("hetzner", () => {
    it("matches insufficient_funds", () => {
      expect(isBillingError("hetzner", "insufficient funds")).toBe(true);
      expect(isBillingError("hetzner", "insufficient_funds")).toBe(true);
    });

    it("matches payment method required", () => {
      expect(isBillingError("hetzner", "payment method required")).toBe(true);
    });

    it("matches account locked/blocked", () => {
      expect(isBillingError("hetzner", "account is locked")).toBe(true);
      expect(isBillingError("hetzner", "account blocked")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError("hetzner", "server limit reached")).toBe(false);
      expect(isBillingError("hetzner", "server type unavailable")).toBe(false);
    });
  });

  describe("digitalocean", () => {
    it("matches billing-related errors", () => {
      expect(isBillingError("digitalocean", "insufficient funds")).toBe(true);
      expect(isBillingError("digitalocean", "payment required")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError("digitalocean", "droplet limit reached")).toBe(false);
      expect(isBillingError("digitalocean", "region unavailable")).toBe(false);
    });
  });

  describe("aws", () => {
    it("matches activation/billing errors", () => {
      expect(isBillingError("aws", "account not activated")).toBe(true);
      expect(isBillingError("aws", "subscription required")).toBe(true);
      expect(isBillingError("aws", "not been enabled")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError("aws", "instance limit reached")).toBe(false);
      expect(isBillingError("aws", "bundle unavailable")).toBe(false);
    });
  });

  describe("gcp", () => {
    it("matches BILLING_DISABLED", () => {
      expect(isBillingError("gcp", "BILLING_DISABLED")).toBe(true);
    });

    it("matches billing not enabled", () => {
      expect(isBillingError("gcp", "billing is not enabled")).toBe(true);
      expect(isBillingError("gcp", "billing disabled")).toBe(true);
    });

    it("matches billing account errors", () => {
      expect(isBillingError("gcp", "no billing account linked")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError("gcp", "quota exceeded")).toBe(false);
      expect(isBillingError("gcp", "machine type unavailable")).toBe(false);
    });
  });

  describe("daytona", () => {
    it("matches billing/plan errors", () => {
      expect(isBillingError("daytona", "quota exceeded")).toBe(true);
      expect(isBillingError("daytona", "plan limit reached")).toBe(true);
    });

    it("returns false for non-billing errors", () => {
      expect(isBillingError("daytona", "sandbox creation failed")).toBe(false);
      expect(isBillingError("daytona", "internal server error")).toBe(false);
    });
  });

  describe("unknown cloud", () => {
    it("returns false for unknown clouds", () => {
      expect(isBillingError("unknown", "billing error")).toBe(false);
    });
  });
});

describe("getBillingUrl", () => {
  it("returns correct URLs for known clouds", () => {
    expect(getBillingUrl("hetzner")).toBe("https://console.hetzner.cloud/");
    expect(getBillingUrl("digitalocean")).toBe("https://cloud.digitalocean.com/account/billing");
    expect(getBillingUrl("aws")).toBe("https://lightsail.aws.amazon.com/");
    expect(getBillingUrl("gcp")).toBe("https://console.cloud.google.com/billing");
    expect(getBillingUrl("daytona")).toBe("https://app.daytona.io/dashboard");
  });

  it("returns undefined for unknown clouds", () => {
    expect(getBillingUrl("unknown")).toBeUndefined();
  });
});

describe("getSetupSteps", () => {
  it("returns steps for known clouds", () => {
    const steps = getSetupSteps("hetzner");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]).toContain("Hetzner");
  });

  it("returns empty array for unknown clouds", () => {
    expect(getSetupSteps("unknown")).toEqual([]);
  });
});

describe("handleBillingError", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    mockOpenBrowser.mockClear();
    mockPrompt.mockClear();
  });

  it("opens billing URL and returns true when user presses Enter", async () => {
    mockPrompt.mockImplementation(() => Promise.resolve(""));
    const result = await handleBillingError("hetzner");
    expect(result).toBe(true);
    expect(mockOpenBrowser).toHaveBeenCalledWith("https://console.hetzner.cloud/");
    stderrSpy.mockRestore();
  });

  it("returns false when prompt throws (Ctrl+C)", async () => {
    mockPrompt.mockImplementation(() => Promise.reject(new Error("cancelled")));
    const result = await handleBillingError("digitalocean");
    expect(result).toBe(false);
    stderrSpy.mockRestore();
  });

  it("works for clouds without billing URL", async () => {
    mockPrompt.mockImplementation(() => Promise.resolve(""));
    const result = await handleBillingError("unknown");
    expect(result).toBe(true);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});

describe("showNonBillingError", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("does not throw", () => {
    expect(() => {
      showNonBillingError("hetzner", [
        "Server limit reached for your account",
      ]);
    }).not.toThrow();
    stderrSpy.mockRestore();
  });
});

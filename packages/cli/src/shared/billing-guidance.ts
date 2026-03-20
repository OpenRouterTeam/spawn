// shared/billing-guidance.ts — Billing error detection, guidance, and browser-based retry flow

import { asyncTryCatch, unwrapOr } from "./result.js";
import { logInfo, logStep, logWarn, openBrowser, prompt } from "./ui";

// ─── BillingConfig interface ────────────────────────────────────────────────

export interface BillingConfig {
  billingUrl: string;
  setupSteps: string[];
  errorPatterns: RegExp[];
}

/** Check if an error message matches known billing error patterns for a cloud. */
export function isBillingError(config: BillingConfig, errorMsg: string): boolean {
  if (!config.errorPatterns || config.errorPatterns.length === 0) {
    return false;
  }
  return config.errorPatterns.some((p) => p.test(errorMsg));
}

/** Dependencies for billing-guidance functions (injectable for testing). */
export interface BillingGuidanceDeps {
  logInfo: typeof logInfo;
  logStep: typeof logStep;
  logWarn: typeof logWarn;
  openBrowser: typeof openBrowser;
  prompt: typeof prompt;
}

const defaultDeps: BillingGuidanceDeps = {
  logInfo,
  logStep,
  logWarn,
  openBrowser,
  prompt,
};

/**
 * Show billing guidance, open the billing page, and prompt user to retry.
 * Returns true if user wants to retry, false otherwise.
 */
export async function handleBillingError(
  config: BillingConfig,
  deps: BillingGuidanceDeps = defaultDeps,
): Promise<boolean> {
  const billingUrl = config.billingUrl;
  const steps = config.setupSteps;

  process.stderr.write("\n");
  deps.logWarn("Your account needs a payment method to create servers.");

  if (steps.length > 0) {
    process.stderr.write("\n");
    for (const step of steps) {
      deps.logStep(`  ${step}`);
    }
  }

  if (billingUrl) {
    process.stderr.write("\n");
    deps.logStep("Opening your billing page...");
    deps.openBrowser(billingUrl);
  }

  process.stderr.write("\n");
  return unwrapOr(
    await asyncTryCatch(async () => {
      await deps.prompt("Press Enter after adding a payment method to retry (or Ctrl+C to exit)");
      return true;
    }),
    false,
  );
}

/**
 * Show non-billing error guidance with cloud-specific causes and dashboard link.
 */
export function showNonBillingError(
  config: BillingConfig,
  causes: string[],
  deps: Pick<BillingGuidanceDeps, "logInfo" | "logWarn"> = defaultDeps,
): void {
  if (causes.length > 0) {
    deps.logWarn("Possible causes:");
    for (const cause of causes) {
      deps.logWarn(`  - ${cause}`);
    }
  }
  if (config.billingUrl) {
    deps.logInfo(`Dashboard: ${config.billingUrl}`);
  }
}

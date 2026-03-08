// shared/billing-guidance.ts — Billing error detection, guidance, and browser-based retry flow

import { logInfo, logStep, logWarn, openBrowser, prompt } from "./ui";

// ─── Billing URLs per cloud ─────────────────────────────────────────────────

const BILLING_URLS: Record<string, string> = {
  hetzner: "https://console.hetzner.cloud/",
  digitalocean: "https://cloud.digitalocean.com/account/billing",
  aws: "https://lightsail.aws.amazon.com/",
  gcp: "https://console.cloud.google.com/billing",
};

// ─── Setup steps per cloud ──────────────────────────────────────────────────

const SETUP_STEPS: Record<string, string[]> = {
  hetzner: [
    "1. Open the Hetzner Cloud Console",
    "2. Go to Billing → Payment Methods",
    "3. Add a credit card or PayPal account",
    "4. Return here and press Enter to retry",
  ],
  digitalocean: [
    "1. Open DigitalOcean Billing Settings",
    "2. Add a credit card or PayPal account",
    "3. Verify your email address if prompted",
    "4. Return here and press Enter to retry",
  ],
  aws: [
    "1. Open the AWS Lightsail console",
    "2. Complete account activation if prompted",
    "3. Add a payment method in AWS Billing",
    "4. Return here and press Enter to retry",
  ],
  gcp: [
    "1. Open the Google Cloud Billing page",
    "2. Link a billing account to your project",
    "3. Enable the Compute Engine API",
    "4. Return here and press Enter to retry",
  ],
};

// ─── Error patterns per cloud ───────────────────────────────────────────────

const ERROR_PATTERNS: Record<string, RegExp[]> = {
  hetzner: [
    /insufficient[_ ]funds/i,
    /payment[_ ]method[_ ]required/i,
    /account[_ ](?:is[_ ])?(?:locked|blocked|suspended)/i,
    /billing/i,
  ],
  digitalocean: [
    /insufficient[_ ]funds/i,
    /payment[_ ]method[_ ]required/i,
    /account[_ ](?:is[_ ])?(?:locked|blocked|suspended)/i,
    /billing/i,
    /payment/i,
  ],
  aws: [
    /billing[_ ]?disabled/i,
    /not[_ ](?:been[_ ])?(?:activated|enabled)/i,
    /payment[_ ]method[_ ]required/i,
    /account[_ ](?:is[_ ])?(?:suspended|closed)/i,
    /subscription[_ ]required/i,
  ],
  gcp: [
    /billing[_ ]?(?:is[_ ])?(?:not[_ ])?(?:enabled|disabled)/i,
    /billing[_ ]account/i,
    /BILLING_DISABLED/,
    /project.*has.*no.*billing/i,
    /account[_ ](?:is[_ ])?(?:suspended|closed)/i,
  ],
};

/** Check if an error message matches known billing error patterns for a cloud. */
export function isBillingError(cloud: string, errorMsg: string): boolean {
  const patterns = ERROR_PATTERNS[cloud];
  if (!patterns) {
    return false;
  }
  return patterns.some((p) => p.test(errorMsg));
}

/**
 * Show billing guidance, open the billing page, and prompt user to retry.
 * Returns true if user wants to retry, false otherwise.
 */
export async function handleBillingError(cloud: string): Promise<boolean> {
  const billingUrl = BILLING_URLS[cloud];
  const steps = SETUP_STEPS[cloud] || [];

  process.stderr.write("\n");
  logWarn("Your account needs a payment method to create servers.");

  if (steps.length > 0) {
    process.stderr.write("\n");
    for (const step of steps) {
      logStep(`  ${step}`);
    }
  }

  if (billingUrl) {
    process.stderr.write("\n");
    logStep("Opening your billing page...");
    openBrowser(billingUrl);
  }

  process.stderr.write("\n");
  try {
    await prompt("Press Enter after adding a payment method to retry (or Ctrl+C to exit)");
    return true;
  } catch {
    return false;
  }
}

/**
 * Show non-billing error guidance with cloud-specific causes and dashboard link.
 */
export function showNonBillingError(cloud: string, causes: string[]): void {
  if (causes.length > 0) {
    logWarn("Possible causes:");
    for (const cause of causes) {
      logWarn(`  - ${cause}`);
    }
  }
  const billingUrl = BILLING_URLS[cloud];
  if (billingUrl) {
    logInfo(`Dashboard: ${billingUrl}`);
  }
}

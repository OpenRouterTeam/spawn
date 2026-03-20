import type { BillingConfig } from "../shared/billing-guidance.js";

export const gcpBilling: BillingConfig = {
  billingUrl: "https://console.cloud.google.com/billing",
  setupSteps: [
    "1. Open the Google Cloud Billing page",
    "2. Link a billing account to your project",
    "3. Enable the Compute Engine API",
    "4. Return here and press Enter to retry",
  ],
  errorPatterns: [
    /billing[_ ]?(?:is[_ ])?(?:not[_ ])?(?:enabled|disabled)/i,
    /billing[_ ]account/i,
    /BILLING_DISABLED/,
    /project.*has.*no.*billing/i,
    /account[_ ](?:is[_ ])?(?:suspended|closed)/i,
  ],
};

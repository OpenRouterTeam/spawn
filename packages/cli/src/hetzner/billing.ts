import type { BillingConfig } from "../shared/billing-guidance.js";

export const hetznerBilling: BillingConfig = {
  billingUrl: "https://console.hetzner.cloud/",
  setupSteps: [
    "1. Open the Hetzner Cloud Console",
    "2. Go to Billing → Payment Methods",
    "3. Add a credit card or PayPal account",
    "4. Return here and press Enter to retry",
  ],
  errorPatterns: [
    /insufficient[_ ]funds/i,
    /payment[_ ]method[_ ]required/i,
    /account[_ ](?:is[_ ])?(?:locked|blocked|suspended)/i,
    /billing/i,
  ],
};

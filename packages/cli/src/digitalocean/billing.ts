import type { BillingConfig } from "../shared/billing-guidance";

export const digitaloceanBilling: BillingConfig = {
  billingUrl: "https://cloud.digitalocean.com/account/billing",
  setupSteps: [
    "1. Open DigitalOcean Billing Settings",
    "2. Add a credit card or PayPal account",
    "3. Verify your email address if prompted",
    "4. Return here and press Enter to retry",
  ],
  errorPatterns: [
    /insufficient[_ ]funds/i,
    /payment[_ ]method[_ ]required/i,
    /account[_ ](?:is[_ ])?(?:locked|blocked|suspended)/i,
    /billing/i,
    /payment/i,
  ],
};

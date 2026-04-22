import type { BillingConfig } from "../shared/billing-guidance.js";

/** Opens add-payment modal and skips billing questionnaire (Spawn / OpenRouter context). */
export const DIGITALOCEAN_BILLING_ADD_PAYMENT_URL =
  "https://cloud.digitalocean.com/account/billing?defer-onboarding-for=or&open-add-payment-method=true";

export const digitaloceanBilling: BillingConfig = {
  billingUrl: DIGITALOCEAN_BILLING_ADD_PAYMENT_URL,
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

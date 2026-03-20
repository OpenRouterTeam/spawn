import type { BillingConfig } from "../shared/billing-guidance";

export const awsBilling: BillingConfig = {
  billingUrl: "https://lightsail.aws.amazon.com/",
  setupSteps: [
    "1. Open the AWS Lightsail console",
    "2. Complete account activation if prompted",
    "3. Add a payment method in AWS Billing",
    "4. Return here and press Enter to retry",
  ],
  errorPatterns: [
    /billing[_ ]?disabled/i,
    /not[_ ](?:been[_ ])?(?:activated|enabled)/i,
    /payment[_ ]method[_ ]required/i,
    /account[_ ](?:is[_ ])?(?:suspended|closed)/i,
    /subscription[_ ]required/i,
  ],
};

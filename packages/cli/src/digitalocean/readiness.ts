// digitalocean/readiness.ts — Pre-flight READY/BLOCKED evaluation + guided CLI gate

import * as p from "@clack/prompts";
import { handleBillingError } from "../shared/billing-guidance.js";
import { getOrPromptApiKey, loadSavedOpenRouterKey, verifyOpenRouterApiKey } from "../shared/oauth.js";
import { logError, logInfo, logStep, openBrowser, prompt } from "../shared/ui.js";
import { DIGITALOCEAN_BILLING_ADD_PAYMENT_URL, digitaloceanBilling } from "./billing.js";
import {
  areSshKeysRegisteredOnDigitalOcean,
  ensureDoToken,
  ensureSshKey,
  fetchDoAccountSnapshot,
  getDropletCount,
} from "./digitalocean.js";
import { renderReadinessChecklist } from "./readiness-checklist.js";

const DO_PROFILE_URL = "https://cloud.digitalocean.com/account/profile";
const DO_DROPLETS_URL = "https://cloud.digitalocean.com/droplets";

/** Ordered blocker codes returned by {@link evaluateDigitalOceanReadiness}. */
export type ReadinessBlockerCode =
  | "do_auth"
  | "email_unverified"
  | "payment_required"
  | "ssh_missing"
  | "openrouter_missing"
  | "droplet_limit";

export interface ReadinessState {
  status: "READY" | "BLOCKED";
  blockers: ReadinessBlockerCode[];
}

/** Resolution order: fix billing before SSH registration — DO often rejects key upload until payment is set up. */
const BLOCKER_ORDER: ReadinessBlockerCode[] = [
  "do_auth",
  "email_unverified",
  "payment_required",
  "ssh_missing",
  "openrouter_missing",
  "droplet_limit",
];

export function sortBlockers(codes: ReadinessBlockerCode[]): ReadinessBlockerCode[] {
  const uniq = [
    ...new Set(codes),
  ];
  return uniq.sort((a, b) => BLOCKER_ORDER.indexOf(a) - BLOCKER_ORDER.indexOf(b));
}

async function hasValidOpenRouterKey(): Promise<boolean> {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey && (await verifyOpenRouterApiKey(envKey))) {
    return true;
  }
  const saved = loadSavedOpenRouterKey();
  if (saved && (await verifyOpenRouterApiKey(saved))) {
    return true;
  }
  return false;
}

/**
 * Evaluate DigitalOcean + OpenRouter readiness using `GET /v2/account` only (no billing APIs).
 */
export async function evaluateDigitalOceanReadiness(_agentName: string): Promise<ReadinessState> {
  void _agentName;
  const blockers: ReadinessBlockerCode[] = [];

  const snapshot = await fetchDoAccountSnapshot();
  if (!snapshot) {
    return {
      status: "BLOCKED",
      blockers: sortBlockers([
        "do_auth",
      ]),
    };
  }

  const dropletLimit = snapshot.droplet_limit;
  if (dropletLimit > 0) {
    const count = await getDropletCount();
    if (count !== null && count >= dropletLimit) {
      blockers.push("droplet_limit");
    }
  }

  if (snapshot.email_verified === false) {
    blockers.push("email_unverified");
  }

  // `locked` = billing suspended; `warning` = account needs attention (often payment verification before first resource)
  if (snapshot.status === "locked" || snapshot.status === "warning") {
    blockers.push("payment_required");
  }

  if (!(await areSshKeysRegisteredOnDigitalOcean())) {
    blockers.push("ssh_missing");
  }

  if (!(await hasValidOpenRouterKey())) {
    blockers.push("openrouter_missing");
  }

  if (blockers.length === 0) {
    return {
      status: "READY",
      blockers: [],
    };
  }

  return {
    status: "BLOCKED",
    blockers: sortBlockers(blockers),
  };
}

async function resolveFirstBlocker(first: ReadinessBlockerCode, agentName: string): Promise<void> {
  switch (first) {
    case "do_auth": {
      logStep("Connect your DigitalOcean account...");
      await ensureDoToken();
      break;
    }
    case "droplet_limit": {
      logStep("Droplet limit reached. Delete a droplet in the control panel or raise your limit, then continue.");
      openBrowser(DO_DROPLETS_URL);
      await prompt("Press Enter after freeing capacity to re-check...");
      break;
    }
    case "email_unverified": {
      logStep("Verify your DigitalOcean email to continue.");
      openBrowser(DO_PROFILE_URL);
      await prompt("Press Enter after verifying your email to re-check...");
      break;
    }
    case "payment_required": {
      logStep("Your DigitalOcean account needs billing attention.");
      await handleBillingError(digitaloceanBilling);
      break;
    }
    case "ssh_missing": {
      logStep("Registering SSH keys with DigitalOcean...");
      await ensureSshKey();
      logInfo("SSH keys updated.");
      break;
    }
    case "openrouter_missing": {
      logStep("Connect OpenRouter to continue.");
      await getOrPromptApiKey(agentName, "digitalocean");
      break;
    }
  }
}

/**
 * Interactive loop until READY or process exit (non-interactive).
 * Ensures SSH keys are registered and OpenRouter key is available before returning.
 */
export async function runDigitalOceanReadinessGate(opts: { agentName: string }): Promise<void> {
  const { agentName } = opts;
  let previousTopBlocker: ReadinessBlockerCode | undefined;
  let sameTopBlockerRepeats = 0;

  for (;;) {
    const state = await evaluateDigitalOceanReadiness(agentName);

    const jsonReadiness =
      process.env.SPAWN_NON_INTERACTIVE === "1" &&
      (process.argv.includes("--json-readiness") || process.env.SPAWN_JSON_READINESS === "1");
    if (!jsonReadiness) {
      renderReadinessChecklist(state);
    }

    if (state.status === "READY") {
      break;
    }

    if (process.env.SPAWN_NON_INTERACTIVE === "1") {
      if (jsonReadiness) {
        console.log(JSON.stringify(state));
      } else {
        logError(`DigitalOcean readiness blocked: ${state.blockers.join(", ")}`);
        logInfo(`Billing: ${DIGITALOCEAN_BILLING_ADD_PAYMENT_URL}`);
      }
      process.exit(1);
    }

    const first = state.blockers[0];
    if (!first) {
      break;
    }

    if (first === previousTopBlocker) {
      sameTopBlockerRepeats++;
    } else {
      sameTopBlockerRepeats = 0;
    }
    previousTopBlocker = first;

    if (sameTopBlockerRepeats >= 2) {
      logError(
        "Readiness is still blocked after several attempts. " +
          "If DigitalOcean rejected SSH key upload, add a payment method first or register your public key in Account → Security.",
      );
      logInfo(`Billing: ${DIGITALOCEAN_BILLING_ADD_PAYMENT_URL}`);
      await prompt("Press Enter after you've addressed this to re-check...");
      sameTopBlockerRepeats = 0;
    }

    if (first !== "do_auth") {
      p.log.warn(`Blocked: ${first.replace(/_/g, " ")}`);
    }
    await resolveFirstBlocker(first, agentName);
  }

  await ensureSshKey();
  if (!process.env.OPENROUTER_API_KEY) {
    const saved = loadSavedOpenRouterKey();
    if (saved && (await verifyOpenRouterApiKey(saved))) {
      process.env.OPENROUTER_API_KEY = saved;
    }
  }
  await getOrPromptApiKey(agentName, "digitalocean");
}

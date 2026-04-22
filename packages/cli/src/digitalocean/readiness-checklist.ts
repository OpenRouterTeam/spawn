// digitalocean/readiness-checklist.ts — Terminal checklist UI for DO readiness (matches onboarding UX plan)

import type { ReadinessBlockerCode, ReadinessState } from "./readiness.js";

import pc from "picocolors";

/** Display order: DO → email → SSH → payment → OpenRouter → capacity. */
export const READINESS_CHECKLIST_ROWS: {
  code: ReadinessBlockerCode;
  label: string;
}[] = [
  {
    code: "do_auth",
    label: "DigitalOcean connected",
  },
  {
    code: "email_unverified",
    label: "Email verified",
  },
  {
    code: "ssh_missing",
    label: "SSH key ready",
  },
  {
    code: "payment_required",
    label: "Payment method added",
  },
  {
    code: "openrouter_missing",
    label: "OpenRouter connected",
  },
  {
    code: "droplet_limit",
    label: "Droplet capacity",
  },
];

export type ChecklistLineStatus = "ready" | "blocked" | "pending";

/** Pure mapping for tests and rendering. */
export function checklistLineStatus(code: ReadinessBlockerCode, state: ReadinessState): ChecklistLineStatus {
  if (state.status === "READY") {
    return "ready";
  }
  if (state.blockers.includes("do_auth") && code !== "do_auth") {
    return "pending";
  }
  return state.blockers.includes(code) ? "blocked" : "ready";
}

function statusSubline(status: ChecklistLineStatus): string {
  switch (status) {
    case "ready":
      return pc.dim(pc.green("READY"));
    case "blocked":
      return pc.dim(pc.yellow("BLOCKED"));
    case "pending":
      return pc.dim("Not checked yet");
  }
}

function rowBullet(status: ChecklistLineStatus): string {
  switch (status) {
    case "ready":
      return pc.green("●");
    case "blocked":
      return pc.yellow("●");
    case "pending":
      return pc.dim("○");
  }
}

/** Print the readiness checklist to stderr (interactive UX). */
export function renderReadinessChecklist(state: ReadinessState): void {
  const allReady = state.status === "READY";
  const title = allReady ? pc.green("Readiness check complete") : pc.yellow("Readiness check");
  const subtitle = allReady ? pc.green("All checks passed") : pc.dim("Some requirements still need attention");

  process.stderr.write("\n");
  process.stderr.write(`${title}\n`);
  process.stderr.write(`${subtitle}\n`);
  process.stderr.write("\n");
  process.stderr.write(`${pc.dim("  READINESS")}\n`);
  process.stderr.write("\n");

  for (const { code, label } of READINESS_CHECKLIST_ROWS) {
    const ls = checklistLineStatus(code, state);
    const bullet = rowBullet(ls);
    const titleText = ls === "pending" ? pc.dim(label) : pc.bold(label);
    process.stderr.write(`  ${bullet}  ${titleText}\n`);
    process.stderr.write(`      ${statusSubline(ls)}\n`);
    process.stderr.write("\n");
  }
}

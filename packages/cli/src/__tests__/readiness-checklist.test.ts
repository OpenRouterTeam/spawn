import type { ReadinessState } from "../digitalocean/readiness";

import { describe, expect, test } from "bun:test";
import { checklistLineStatus, READINESS_CHECKLIST_ROWS } from "../digitalocean/readiness-checklist";

describe("checklistLineStatus", () => {
  test("all ready when status READY", () => {
    const state: ReadinessState = {
      status: "READY",
      blockers: [],
    };
    expect(checklistLineStatus("do_auth", state)).toBe("ready");
    expect(checklistLineStatus("droplet_limit", state)).toBe("ready");
    expect(checklistLineStatus("email_unverified", state)).toBe("ready");
    expect(checklistLineStatus("ssh_missing", state)).toBe("ready");
    expect(checklistLineStatus("payment_required", state)).toBe("ready");
    expect(checklistLineStatus("openrouter_missing", state)).toBe("ready");
  });

  test("do_auth blocks only auth row; other rows pending", () => {
    const state: ReadinessState = {
      status: "BLOCKED",
      blockers: [
        "do_auth",
      ],
    };
    expect(checklistLineStatus("do_auth", state)).toBe("blocked");
    expect(checklistLineStatus("email_unverified", state)).toBe("pending");
    expect(checklistLineStatus("ssh_missing", state)).toBe("pending");
    expect(checklistLineStatus("payment_required", state)).toBe("pending");
    expect(checklistLineStatus("openrouter_missing", state)).toBe("pending");
    expect(checklistLineStatus("droplet_limit", state)).toBe("pending");
  });

  test("multiple blockers without do_auth", () => {
    const state: ReadinessState = {
      status: "BLOCKED",
      blockers: [
        "email_unverified",
        "payment_required",
      ],
    };
    expect(checklistLineStatus("do_auth", state)).toBe("ready");
    expect(checklistLineStatus("email_unverified", state)).toBe("blocked");
    expect(checklistLineStatus("payment_required", state)).toBe("blocked");
    expect(checklistLineStatus("ssh_missing", state)).toBe("ready");
  });

  test("openrouter_missing is blocked while other rows remain ready", () => {
    const state: ReadinessState = {
      status: "BLOCKED",
      blockers: [
        "openrouter_missing",
      ],
    };
    expect(checklistLineStatus("do_auth", state)).toBe("ready");
    expect(checklistLineStatus("ssh_missing", state)).toBe("ready");
    expect(checklistLineStatus("openrouter_missing", state)).toBe("blocked");
    expect(checklistLineStatus("droplet_limit", state)).toBe("ready");
  });

  test("droplet_limit blocked with all other rows ready", () => {
    const state: ReadinessState = {
      status: "BLOCKED",
      blockers: [
        "droplet_limit",
      ],
    };
    expect(checklistLineStatus("droplet_limit", state)).toBe("blocked");
    expect(checklistLineStatus("do_auth", state)).toBe("ready");
    expect(checklistLineStatus("payment_required", state)).toBe("ready");
  });

  test("all blockers active except do_auth", () => {
    const state: ReadinessState = {
      status: "BLOCKED",
      blockers: [
        "email_unverified",
        "payment_required",
        "ssh_missing",
        "openrouter_missing",
        "droplet_limit",
      ],
    };
    expect(checklistLineStatus("do_auth", state)).toBe("ready");
    expect(checklistLineStatus("email_unverified", state)).toBe("blocked");
    expect(checklistLineStatus("payment_required", state)).toBe("blocked");
    expect(checklistLineStatus("ssh_missing", state)).toBe("blocked");
    expect(checklistLineStatus("openrouter_missing", state)).toBe("blocked");
    expect(checklistLineStatus("droplet_limit", state)).toBe("blocked");
  });
});

describe("READINESS_CHECKLIST_ROWS", () => {
  test("contains all 6 blocker codes", () => {
    const codes = READINESS_CHECKLIST_ROWS.map((r) => r.code);
    expect(codes).toContain("do_auth");
    expect(codes).toContain("email_unverified");
    expect(codes).toContain("ssh_missing");
    expect(codes).toContain("payment_required");
    expect(codes).toContain("openrouter_missing");
    expect(codes).toContain("droplet_limit");
    expect(codes.length).toBe(6);
  });

  test("every row has a non-empty label", () => {
    for (const row of READINESS_CHECKLIST_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
});

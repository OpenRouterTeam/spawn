import type { ReadinessState } from "../digitalocean/readiness";

import { describe, expect, test } from "bun:test";
import { checklistLineStatus } from "../digitalocean/readiness-checklist";

describe("checklistLineStatus", () => {
  test("all ready when status READY", () => {
    const state: ReadinessState = {
      status: "READY",
      blockers: [],
    };
    expect(checklistLineStatus("do_auth", state)).toBe("ready");
    expect(checklistLineStatus("droplet_limit", state)).toBe("ready");
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
});

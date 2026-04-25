import { describe, expect, test } from "bun:test";
import { sortBlockers } from "../digitalocean/readiness";

describe("sortBlockers", () => {
  test("payment_required resolves before ssh_missing", () => {
    expect(
      sortBlockers([
        "ssh_missing",
        "payment_required",
      ]),
    ).toEqual([
      "payment_required",
      "ssh_missing",
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(sortBlockers([])).toEqual([]);
  });

  test("deduplicates blocker codes", () => {
    expect(
      sortBlockers([
        "ssh_missing",
        "ssh_missing",
        "do_auth",
      ]),
    ).toEqual([
      "do_auth",
      "ssh_missing",
    ]);
  });

  test("preserves canonical order for all blocker types", () => {
    expect(
      sortBlockers([
        "droplet_limit",
        "openrouter_missing",
        "ssh_missing",
        "payment_required",
        "email_unverified",
        "do_auth",
      ]),
    ).toEqual([
      "do_auth",
      "email_unverified",
      "payment_required",
      "ssh_missing",
      "openrouter_missing",
      "droplet_limit",
    ]);
  });

  test("single blocker returns as-is", () => {
    expect(
      sortBlockers([
        "do_auth",
      ]),
    ).toEqual([
      "do_auth",
    ]);
  });
});

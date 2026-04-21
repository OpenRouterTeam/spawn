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
});

import { describe, expect, it } from "bun:test";
import { killWithTimeout } from "../shared/ssh";

describe("killWithTimeout", () => {
  it("sends SIGKILL after grace period if process ignores SIGTERM", async () => {
    const signals: (number | undefined)[] = [];
    const proc = {
      kill(signal?: number) {
        signals.push(signal);
      },
    };

    killWithTimeout(proc, 100);
    await new Promise((r) => setTimeout(r, 200));

    expect(signals).toEqual([
      undefined,
      9,
    ]);
  });

  it("does not throw if process is already dead when SIGKILL fires", async () => {
    let callCount = 0;
    const proc = {
      kill(signal?: number) {
        callCount++;
        if (callCount > 1) {
          throw new Error("No such process");
        }
      },
    };

    killWithTimeout(proc, 50);
    await new Promise((r) => setTimeout(r, 150));

    // Should not throw — the error is caught internally
    expect(callCount).toBe(2);
  });

  it("does not send SIGKILL if initial SIGTERM throws", async () => {
    const signals: (number | undefined)[] = [];
    const proc = {
      kill(_signal?: number) {
        throw new Error("No such process");
      },
    };

    killWithTimeout(proc, 50);
    await new Promise((r) => setTimeout(r, 150));

    // No signals recorded because the first kill() threw
    expect(signals).toEqual([]);
  });
});

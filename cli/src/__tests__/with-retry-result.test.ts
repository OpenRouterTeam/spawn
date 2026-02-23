import { describe, it, expect, mock, spyOn } from "bun:test";

// Suppress log output during tests
spyOn(process.stderr, "write").mockImplementation(() => true);

const { withRetry, Ok, Err } = await import("../shared/ui.js");
const { wrapSshCall } = await import("../shared/agent-setup.js");

// ── Result constructors ──────────────────────────────────────────────

describe("Result constructors", () => {
  it("Ok creates a success result", () => {
    const r = Ok(42);
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("Ok works with void", () => {
    const r = Ok(undefined);
    expect(r.ok).toBe(true);
  });

  it("Err creates a failure result", () => {
    const r = Err(new Error("boom"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe("boom");
    }
  });
});

// ── withRetry with Result monad ──────────────────────────────────────

describe("withRetry", () => {
  it("returns value on first Ok", async () => {
    const fn = mock(() => Promise.resolve(Ok("hello")));
    const result = await withRetry("test", fn, 3, 0);
    expect(result).toBe("hello");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on Err then succeeds", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) {
        return Err(new Error("transient"));
      }
      return Ok("recovered");
    });
    const result = await withRetry("test", fn, 3, 0);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after max Err attempts", async () => {
    const fn = mock(() => Promise.resolve(Err(new Error("always fails"))));
    await expect(withRetry("test", fn, 3, 0)).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry when fn throws (non-retryable)", async () => {
    const fn = mock(() => {
      throw new Error("fatal");
    });
    await expect(withRetry("test", fn, 3, 0)).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry async throw (non-retryable)", async () => {
    const fn = mock(async () => {
      throw new Error("async fatal");
    });
    await expect(withRetry("test", fn, 3, 0)).rejects.toThrow("async fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries Err then stops on throw", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls === 1) {
        return Err(new Error("transient"));
      }
      throw new Error("fatal on second try");
    });
    await expect(withRetry("test", fn, 5, 0)).rejects.toThrow("fatal on second try");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("works with maxAttempts = 1 (no retries)", async () => {
    const fn = mock(() => Promise.resolve(Err(new Error("single shot"))));
    await expect(withRetry("test", fn, 1, 0)).rejects.toThrow("single shot");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns correct typed value", async () => {
    const fn = async () => Ok({ name: "test", count: 42 });
    const result = await withRetry("test", fn, 1, 0);
    expect(result).toEqual({ name: "test", count: 42 });
  });
});

// ── wrapSshCall ──────────────────────────────────────────────────────

describe("wrapSshCall", () => {
  it("returns Ok on success", async () => {
    const result = await wrapSshCall(Promise.resolve());
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("returns Err for transient SSH error (retryable)", async () => {
    const result = await wrapSshCall(Promise.reject(new Error("connection reset")));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("connection reset");
    }
  });

  it("returns Err for connection refused (retryable)", async () => {
    const result = await wrapSshCall(Promise.reject(new Error("connection refused")));
    expect(result.ok).toBe(false);
  });

  it("throws on timeout (non-retryable)", async () => {
    await expect(wrapSshCall(Promise.reject(new Error("operation timed out")))).rejects.toThrow("timed out");
  });

  it("throws on timeout variant (non-retryable)", async () => {
    await expect(wrapSshCall(Promise.reject(new Error("SSH timeout reached")))).rejects.toThrow("timeout");
  });

  it("wraps non-Error rejects into Error for Err", async () => {
    const result = await wrapSshCall(Promise.reject("string error"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("string error");
    }
  });
});

// ── Integration: wrapSshCall + withRetry ─────────────────────────────

describe("wrapSshCall + withRetry integration", () => {
  it("retries transient SSH errors then succeeds", async () => {
    let calls = 0;
    const mockOp = () => {
      calls++;
      if (calls < 2) {
        return Promise.reject(new Error("connection reset"));
      }
      return Promise.resolve();
    };
    const result = await withRetry("ssh op", () => wrapSshCall(mockOp()), 3, 0);
    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("does NOT retry timeout errors", async () => {
    let calls = 0;
    const mockOp = () => {
      calls++;
      return Promise.reject(new Error("operation timed out"));
    };
    await expect(withRetry("ssh op", () => wrapSshCall(mockOp()), 3, 0)).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });

  it("exhausts retries on persistent connection errors", async () => {
    let calls = 0;
    const mockOp = () => {
      calls++;
      return Promise.reject(new Error("connection refused"));
    };
    await expect(withRetry("ssh op", () => wrapSshCall(mockOp()), 3, 0)).rejects.toThrow("connection refused");
    expect(calls).toBe(3);
  });
});

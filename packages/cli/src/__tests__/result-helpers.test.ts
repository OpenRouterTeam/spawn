import { describe, expect, it } from "bun:test";
import {
  asyncTryCatch,
  asyncTryCatchIf,
  Err,
  isFileError,
  isNetworkError,
  isOperationalError,
  mapResult,
  Ok,
  tryCatch,
  tryCatchIf,
  unwrapOr,
} from "../shared/result";

// ── Helper: create an Error with a `code` property (like Node.js errno errors) ──

function errnoError(message: string, code: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, "code", {
    value: code,
  });
  return err;
}

// ── tryCatch ────────────────────────────────────────────────────────────────────

describe("tryCatch", () => {
  it("returns Ok on success", () => {
    const result = tryCatch(() => 42);
    expect(result).toMatchObject({
      ok: true,
      data: 42,
    });
  });

  it("returns Err on thrown Error", () => {
    const result = tryCatch(() => {
      throw new Error("boom");
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "boom",
      },
    });
  });

  it("wraps non-Error throws in Error", () => {
    const result = tryCatch(() => {
      throw "string error";
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "string error",
      },
    });
  });
});

// ── asyncTryCatch ───────────────────────────────────────────────────────────────

describe("asyncTryCatch", () => {
  it("returns Ok on resolved promise", async () => {
    const result = await asyncTryCatch(async () => "hello");
    expect(result).toMatchObject({
      ok: true,
      data: "hello",
    });
  });

  it("returns Err on rejected promise", async () => {
    const result = await asyncTryCatch(async () => {
      throw new Error("async boom");
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "async boom",
      },
    });
  });

  it("returns Err on sync throw inside async fn", async () => {
    const result = await asyncTryCatch(() => Promise.reject(new Error("rejected")));
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "rejected",
      },
    });
  });
});

// ── tryCatchIf ──────────────────────────────────────────────────────────────────

describe("tryCatchIf", () => {
  it("returns Ok on success", () => {
    const result = tryCatchIf(isFileError, () => 42);
    expect(result).toMatchObject({
      ok: true,
      data: 42,
    });
  });

  it("returns Err when guard matches", () => {
    const result = tryCatchIf(isFileError, () => {
      throw errnoError("file not found", "ENOENT");
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "file not found",
      },
    });
  });

  it("re-throws when guard does NOT match", () => {
    expect(() => {
      tryCatchIf(isFileError, () => {
        throw new TypeError("cannot read property of null");
      });
    }).toThrow(TypeError);
  });

  it("re-throws RangeError (programming bug)", () => {
    expect(() => {
      tryCatchIf(isFileError, () => {
        throw new RangeError("index out of range");
      });
    }).toThrow(RangeError);
  });
});

// ── asyncTryCatchIf ─────────────────────────────────────────────────────────────

describe("asyncTryCatchIf", () => {
  it("returns Ok on success", async () => {
    const result = await asyncTryCatchIf(isNetworkError, async () => "ok");
    expect(result).toMatchObject({
      ok: true,
      data: "ok",
    });
  });

  it("returns Err when guard matches", async () => {
    const result = await asyncTryCatchIf(isNetworkError, async () => {
      throw errnoError("connection refused", "ECONNREFUSED");
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "connection refused",
      },
    });
  });

  it("re-throws when guard does NOT match", async () => {
    await expect(
      asyncTryCatchIf(isNetworkError, async () => {
        throw new TypeError("null dereference");
      }),
    ).rejects.toThrow(TypeError);
  });
});

// ── unwrapOr ────────────────────────────────────────────────────────────────────

describe("unwrapOr", () => {
  it("returns data on Ok", () => {
    expect(unwrapOr(Ok(42), 0)).toBe(42);
  });

  it("returns fallback on Err", () => {
    expect(unwrapOr(Err(new Error("fail")), 0)).toBe(0);
  });

  it("returns null fallback on Err", () => {
    const result: string | null = unwrapOr(Err(new Error("fail")), null);
    expect(result).toBeNull();
  });
});

// ── mapResult ───────────────────────────────────────────────────────────────────

describe("mapResult", () => {
  it("transforms Ok value", () => {
    const result = mapResult(Ok(5), (n) => n * 2);
    expect(result).toMatchObject({
      ok: true,
      data: 10,
    });
  });

  it("passes Err through unchanged", () => {
    const err = new Error("fail");
    const result = mapResult(Err<number>(err), (n) => n * 2);
    expect(result).toMatchObject({
      ok: false,
      error: err,
    });
  });
});

// ── isFileError ─────────────────────────────────────────────────────────────────

describe("isFileError", () => {
  it("returns true for ENOENT", () => {
    expect(isFileError(errnoError("no such file", "ENOENT"))).toBe(true);
  });

  it("returns true for EACCES", () => {
    expect(isFileError(errnoError("permission denied", "EACCES"))).toBe(true);
  });

  it("returns true for EISDIR", () => {
    expect(isFileError(errnoError("is a directory", "EISDIR"))).toBe(true);
  });

  it("returns true for ENOSPC", () => {
    expect(isFileError(errnoError("no space left", "ENOSPC"))).toBe(true);
  });

  it("returns false for TypeError", () => {
    expect(isFileError(new TypeError("cannot read"))).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isFileError(new Error("something"))).toBe(false);
  });

  it("returns false for network error code", () => {
    expect(isFileError(errnoError("conn refused", "ECONNREFUSED"))).toBe(false);
  });
});

// ── isNetworkError ──────────────────────────────────────────────────────────────

describe("isNetworkError", () => {
  it("returns true for ECONNREFUSED", () => {
    expect(isNetworkError(errnoError("conn refused", "ECONNREFUSED"))).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(isNetworkError(errnoError("conn reset", "ECONNRESET"))).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    expect(isNetworkError(errnoError("timed out", "ETIMEDOUT"))).toBe(true);
  });

  it("returns true for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isNetworkError(err)).toBe(true);
  });

  it("returns true for TimeoutError", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(isNetworkError(err)).toBe(true);
  });

  it('returns true for "fetch failed" message', () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
  });

  it('returns true for "network error" message', () => {
    expect(isNetworkError(new Error("network error"))).toBe(true);
  });

  it("returns true for TypeError with fetch message", () => {
    expect(isNetworkError(new TypeError("fetch failed: connection refused"))).toBe(true);
  });

  it("returns false for TypeError without network message", () => {
    expect(isNetworkError(new TypeError("cannot read property of null"))).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isNetworkError(new Error("something else"))).toBe(false);
  });

  it("returns false for file error code", () => {
    expect(isNetworkError(errnoError("no such file", "ENOENT"))).toBe(false);
  });
});

// ── isOperationalError ──────────────────────────────────────────────────────────

describe("isOperationalError", () => {
  it("returns true for file errors", () => {
    expect(isOperationalError(errnoError("no such file", "ENOENT"))).toBe(true);
  });

  it("returns true for network errors", () => {
    expect(isOperationalError(errnoError("conn refused", "ECONNREFUSED"))).toBe(true);
  });

  it("returns false for TypeError", () => {
    expect(isOperationalError(new TypeError("bug"))).toBe(false);
  });

  it("returns false for RangeError", () => {
    expect(isOperationalError(new RangeError("out of range"))).toBe(false);
  });
});

// ── Bug propagation integration test ────────────────────────────────────────────

describe("bug propagation", () => {
  it("TypeError from null dereference is NOT caught by tryCatchIf(isFileError)", () => {
    expect(() => {
      tryCatchIf(isFileError, () => {
        // Simulate a programming bug — accessing a property on null throws TypeError
        const obj: Record<string, unknown> | null = null;
        return obj!.foo;
      });
    }).toThrow(TypeError);
  });

  it("SyntaxError is NOT caught by tryCatchIf(isFileError)", () => {
    expect(() => {
      tryCatchIf(isFileError, () => {
        JSON.parse("not valid json {{{");
      });
    }).toThrow(SyntaxError);
  });

  it("RangeError is NOT caught by tryCatchIf(isNetworkError)", () => {
    expect(() => {
      tryCatchIf(isNetworkError, () => {
        throw new RangeError("maximum call stack size exceeded");
      });
    }).toThrow(RangeError);
  });
});

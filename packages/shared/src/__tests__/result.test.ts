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
} from "../result";

describe("Ok", () => {
  it("creates an Ok result", () => {
    expect(Ok(42)).toEqual({
      ok: true,
      data: 42,
    });
    expect(Ok("hello")).toEqual({
      ok: true,
      data: "hello",
    });
    expect(Ok(null)).toEqual({
      ok: true,
      data: null,
    });
  });
});

describe("Err", () => {
  it("creates an Err result", () => {
    const error = new Error("fail");
    const result = Err(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });
});

describe("tryCatch", () => {
  it("returns Ok for successful functions", () => {
    const result = tryCatch(() => 42);
    expect(result).toEqual({
      ok: true,
      data: 42,
    });
  });

  it("returns Err for thrown Error instances", () => {
    const result = tryCatch(() => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("boom");
    }
  });

  it("wraps non-Error throws into Error", () => {
    const result = tryCatch(() => {
      throw "string error";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("string error");
    }
  });
});

describe("asyncTryCatch", () => {
  it("returns Ok for successful async functions", async () => {
    const result = await asyncTryCatch(async () => 42);
    expect(result).toEqual({
      ok: true,
      data: 42,
    });
  });

  it("returns Err for rejected promises", async () => {
    const result = await asyncTryCatch(async () => {
      throw new Error("async boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("async boom");
    }
  });

  it("wraps non-Error throws into Error", async () => {
    const result = await asyncTryCatch(async () => {
      throw 404;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("404");
    }
  });
});

describe("tryCatchIf", () => {
  it("returns Ok for successful functions", () => {
    const result = tryCatchIf(
      () => true,
      () => 42,
    );
    expect(result).toEqual({
      ok: true,
      data: 42,
    });
  });

  it("catches errors matching the guard", () => {
    const guard = (err: Error) => err.message === "expected";
    const result = tryCatchIf(guard, () => {
      throw new Error("expected");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("expected");
    }
  });

  it("re-throws errors not matching the guard", () => {
    const guard = (err: Error) => err.message === "expected";
    expect(() =>
      tryCatchIf(guard, () => {
        throw new Error("unexpected");
      }),
    ).toThrow("unexpected");
  });

  it("re-throws non-Error values as normalized Error instances", () => {
    const guard = () => false;
    // Wrap in tryCatch to capture the re-thrown value without raw try/catch
    const result = tryCatch(() =>
      tryCatchIf(guard, () => {
        throw "raw string error";
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("raw string error");
    }
  });
});

describe("asyncTryCatchIf", () => {
  it("returns Ok for successful async functions", async () => {
    const result = await asyncTryCatchIf(
      () => true,
      async () => 42,
    );
    expect(result).toEqual({
      ok: true,
      data: 42,
    });
  });

  it("catches errors matching the guard", async () => {
    const guard = (err: Error) => err.message === "expected";
    const result = await asyncTryCatchIf(guard, async () => {
      throw new Error("expected");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("expected");
    }
  });

  it("re-throws errors not matching the guard", async () => {
    const guard = (err: Error) => err.message === "expected";
    expect(
      asyncTryCatchIf(guard, async () => {
        throw new Error("unexpected");
      }),
    ).rejects.toThrow("unexpected");
  });

  it("re-throws non-Error values as normalized Error instances", async () => {
    const guard = () => false;
    const result = await asyncTryCatch(() =>
      asyncTryCatchIf(guard, async () => {
        throw 404;
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("404");
    }
  });
});

describe("unwrapOr", () => {
  it("returns data for Ok results", () => {
    expect(unwrapOr(Ok(42), 0)).toBe(42);
    expect(unwrapOr(Ok("hello"), "fallback")).toBe("hello");
  });

  it("returns fallback for Err results", () => {
    expect(unwrapOr(Err(new Error("fail")), 0)).toBe(0);
    expect(unwrapOr(Err(new Error("fail")), "fallback")).toBe("fallback");
  });
});

describe("mapResult", () => {
  it("transforms Ok data", () => {
    const result = mapResult(Ok(2), (n) => n * 3);
    expect(result).toEqual({
      ok: true,
      data: 6,
    });
  });

  it("passes Err through unchanged", () => {
    const error = new Error("fail");
    const result = mapResult(Err<number>(error), (n) => n * 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });
});

describe("isFileError", () => {
  it("returns true for file error codes", () => {
    for (const code of [
      "ENOENT",
      "EACCES",
      "EISDIR",
      "ENOSPC",
      "EPERM",
      "ENOTDIR",
    ]) {
      const err = Object.assign(new Error("fail"), {
        code,
      });
      expect(isFileError(err)).toBe(true);
    }
  });

  it("returns false for non-file error codes", () => {
    const err = Object.assign(new Error("fail"), {
      code: "ECONNREFUSED",
    });
    expect(isFileError(err)).toBe(false);
  });

  it("returns false for errors without code", () => {
    expect(isFileError(new Error("fail"))).toBe(false);
  });
});

describe("isNetworkError", () => {
  it("returns true for network error codes", () => {
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
      "EAI_AGAIN",
    ]) {
      const err = Object.assign(new Error("fail"), {
        code,
      });
      expect(isNetworkError(err)).toBe(true);
    }
  });

  it("returns true for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isNetworkError(err)).toBe(true);
  });

  it("returns true for TimeoutError", () => {
    const err = new Error("timeout");
    err.name = "TimeoutError";
    expect(isNetworkError(err)).toBe(true);
  });

  it("returns true for TypeError with fetch/network/socket message", () => {
    const err = new TypeError("fetch failed to connect");
    expect(isNetworkError(err)).toBe(true);

    const err2 = new TypeError("network connection lost");
    expect(isNetworkError(err2)).toBe(true);

    const err3 = new TypeError("socket hang up");
    expect(isNetworkError(err3)).toBe(true);
  });

  it("returns true for errors with fetch failed message", () => {
    const err = new Error("fetch failed");
    expect(isNetworkError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isNetworkError(new Error("something else"))).toBe(false);
    expect(isNetworkError(new TypeError("Cannot read property"))).toBe(false);
  });
});

describe("isOperationalError", () => {
  it("returns true for file errors", () => {
    const err = Object.assign(new Error("fail"), {
      code: "ENOENT",
    });
    expect(isOperationalError(err)).toBe(true);
  });

  it("returns true for network errors", () => {
    const err = Object.assign(new Error("fail"), {
      code: "ECONNREFUSED",
    });
    expect(isOperationalError(err)).toBe(true);
  });

  it("returns false for non-operational errors", () => {
    expect(isOperationalError(new Error("random"))).toBe(false);
  });
});

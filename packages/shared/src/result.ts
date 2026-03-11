// shared/result.ts — Lightweight Result monad for retry-aware error handling.
// biome-ignore-all lint/plugin: this file implements tryCatch/asyncTryCatch and error predicates that require raw try/catch, typeof, and `as`
//
// Returning Err() signals a retryable failure; throwing signals a non-retryable one.
// Used with withRetry() so callers decide at the point of failure whether an error
// is retryable (return Err) or fatal (throw), instead of relying on brittle
// error-message pattern matching after the fact.

export type Result<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: Error;
    };
export const Ok = <T>(data: T): Result<T> => ({
  ok: true,
  data,
});
export const Err = <T>(error: Error): Result<T> => ({
  ok: false,
  error,
});

/** Wrap a synchronous function call into a Result — no try/catch at the call site. */
export function tryCatch<T>(fn: () => T): Result<T> {
  try {
    return Ok(fn());
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Wrap an async function call into a Result — no try/catch at the call site. */
export async function asyncTryCatch<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return Ok(await fn());
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Guarded sync try/catch — catches ONLY errors where `guard` returns true.
 * Non-matching errors (programming bugs like TypeError) are re-thrown immediately.
 */
export function tryCatchIf<T>(guard: (err: Error) => boolean, fn: () => T): Result<T> {
  try {
    return Ok(fn());
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (guard(err)) {
      return Err(err);
    }
    throw e;
  }
}

/**
 * Guarded async try/catch — catches ONLY errors where `guard` returns true.
 * Non-matching errors (programming bugs like TypeError) are re-thrown immediately.
 */
export async function asyncTryCatchIf<T>(guard: (err: Error) => boolean, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return Ok(await fn());
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (guard(err)) {
      return Err(err);
    }
    throw e;
  }
}

/** Extract the value from a Result, returning `fallback` on Err. */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.data : fallback;
}

/** Transform the Ok value of a Result, passing Err through unchanged. */
export function mapResult<T, U>(result: Result<T>, fn: (data: T) => U): Result<U> {
  return result.ok ? Ok(fn(result.data)) : result;
}

// ── Error predicates ──────────────────────────────────────────────────────────

const FILE_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EISDIR",
  "ENOSPC",
  "EPERM",
  "ENOTDIR",
]);

/** Returns true for filesystem I/O errors (ENOENT, EACCES, EISDIR, ENOSPC, EPERM, ENOTDIR). */
export function isFileError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && FILE_ERROR_CODES.has(code);
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
]);

/** Returns true for network/fetch errors (connection refused, reset, timeout, DNS, AbortError, "fetch failed"). */
export function isNetworkError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  if (err.name === "AbortError" || err.name === "TimeoutError") {
    return true;
  }
  // Bun throws TypeError on fetch failures; also match common error message patterns
  if (err.name === "TypeError" && /fetch|network|socket/i.test(err.message)) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset")
  );
}

/** Returns true for operational errors (file I/O + network) — safe broad default for non-fatal catches. */
export function isOperationalError(err: Error): boolean {
  return isFileError(err) || isNetworkError(err);
}

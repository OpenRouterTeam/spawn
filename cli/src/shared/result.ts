// shared/result.ts — Lightweight Result monad for retry-aware error handling.
//
// Returning Err() signals a retryable failure; throwing signals a non-retryable one.
// Used with withRetry() so callers decide at the point of failure whether an error
// is retryable (return Err) or fatal (throw), instead of relying on brittle
// error-message pattern matching after the fact.

export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
export const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const Err = <T>(error: Error): Result<T> => ({ ok: false, error });

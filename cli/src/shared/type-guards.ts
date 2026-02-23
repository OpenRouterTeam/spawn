// shared/type-guards.ts — Runtime type guards (replaces unsafe `as` casts on non-API values)

export function isString(val: unknown): val is string {
  return typeof val === "string";
}

export function isNumber(val: unknown): val is number {
  return typeof val === "number";
}

export function hasStatus(err: unknown): err is { status: number } {
  return err !== null && typeof err === "object" && "status" in err && typeof err.status === "number";
}

export function hasMessage(err: unknown): err is { message: string } {
  return err !== null && typeof err === "object" && "message" in err && typeof err.message === "string";
}

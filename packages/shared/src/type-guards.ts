// shared/type-guards.ts — Runtime type guards (replaces unsafe `as` casts on non-API values)

export function isString(val: unknown): val is string {
  return typeof val === "string";
}

export function isNumber(val: unknown): val is number {
  return typeof val === "number";
}

export function hasStatus(err: unknown): err is {
  status: number;
} {
  return err !== null && typeof err === "object" && "status" in err && typeof err.status === "number";
}

export function hasMessage(err: unknown): err is {
  message: string;
} {
  return err !== null && typeof err === "object" && "message" in err && typeof err.message === "string";
}

/**
 * Safely narrow an unknown value to a Record<string, unknown> or return null.
 */
export function toRecord(val: unknown): Record<string, unknown> | null {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    return val satisfies Record<string, unknown>;
  }
  return null;
}

/**
 * Safely narrow an unknown value to an array of Record<string, unknown>.
 * Filters out non-object items.
 */
export function toObjectArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

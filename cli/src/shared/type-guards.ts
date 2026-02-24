// shared/type-guards.ts — Runtime type guards (replaces unsafe `as` casts on non-API values)

export function isString(val: unknown): val is string {
  // biome-ignore lint/plugin: this IS the type guard definition
  return typeof val === "string";
}

export function isNumber(val: unknown): val is number {
  // biome-ignore lint/plugin: this IS the type guard definition
  return typeof val === "number";
}

export function hasStatus(err: unknown): err is {
  status: number;
} {
  // biome-ignore lint/plugin: composite guard uses typeof internally
  return err !== null && typeof err === "object" && "status" in err && typeof err.status === "number";
}

export function hasMessage(err: unknown): err is {
  message: string;
} {
  // biome-ignore lint/plugin: composite guard uses typeof internally
  return err !== null && typeof err === "object" && "message" in err && typeof err.message === "string";
}

/** Narrow an unknown value to a Record<string, unknown> if it's a non-array object, or null. */
export function toRecord(val: unknown): Record<string, unknown> | null {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(Object.entries(val));
  }
  return null;
}

/** Filter an array to only Record<string, unknown> entries. */
export function toObjectArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) {
    return [];
  }
  return val.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

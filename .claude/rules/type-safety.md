# Type Safety

## No `as` Type Assertions

**`as` type assertions are banned in all TypeScript code (production AND tests).** This is enforced by a GritQL biome plugin (`packages/cli/no-type-assertion.grit`).

### Exemptions
- `as const` — allowed (compile-time only, no runtime risk)
- That's it. `as unknown` is also banned.

## Always Use Valibot — NEVER Manual Typeguards

**This is mandatory.** When validating `unknown` data (JSON responses, stdin payloads, parsed config, external input), ALWAYS use a valibot schema. NEVER write manual chains of `typeof`, `in`, or null checks.

**The only exception** is single-primitive narrowing (`typeof val === "string"`). Anything deeper MUST use valibot.

### For API responses / parsed JSON — use valibot schema validation:
```typescript
import * as v from "valibot";
import { parseJsonWith } from "../shared/parse";

// Declare schemas at module top level, not inside functions
const UserSchema = v.object({ id: v.number(), name: v.string() });

// Returns typed data or null — no `as` needed
const user = parseJsonWith(responseText, UserSchema);
```

### For loose JSON objects (many optional fields):
```typescript
const LooseObject = v.record(v.string(), v.unknown());
function parseJson(text: string): Record<string, unknown> | null {
  return parseJsonWith(text, LooseObject);
}
```

### For narrowing `unknown` values:
```typescript
// Prefer valibot for structured data (objects, nested fields, arrays of objects):
const UserSchema = v.object({ id: v.number(), name: v.string() });
const user = v.safeParse(UserSchema, data);

// Simple type guards are OK ONLY for single primitives:
typeof val === "string" ? val : ""
typeof val === "number" ? val : 0
Array.isArray(val) ? val : []
```

### NEVER write manual multi-level typeguards:
```typescript
// WRONG — manual multi-level typeguard:
if (input !== null && typeof input === "object" && "tool_input" in input &&
    input.tool_input !== null && typeof input.tool_input === "object" &&
    "file_path" in input.tool_input && typeof input.tool_input.file_path === "string") { ... }

// RIGHT — valibot schema:
const Schema = v.object({ tool_input: v.object({ file_path: v.string() }) });
const result = v.safeParse(Schema, input);
if (result.success) { result.output.tool_input.file_path; }
```

### Share schemas across files
If multiple modules validate the same shape, extract the schema to a shared file and import it. Do not duplicate schema definitions.

Shared schema locations:
- `.claude/scripts/schemas.ts` — hook stdin payload schemas
- `packages/shared/src/parse.ts` — `parseJsonWith(text, schema)` and `parseJsonRaw(text)`

### For test mocks — use proper Response objects instead of `as any`:
```typescript
// WRONG: global.fetch = mock(() => Promise.resolve({ ok: true, json: async () => data }) as any);
// RIGHT:
global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(data))));
// For errors:
global.fetch = mock(() => Promise.resolve(new Response("Error", { status: 500 })));
```

### For type literals — use `satisfies` or typed variables:
```typescript
// WRONG: const config = { ... } as AgentConfig;
// RIGHT: const config: AgentConfig = { ... };
// OR:    const config = { ... } satisfies AgentConfig;
```

### Shared utilities
- `packages/shared/src/parse.ts` — `parseJsonWith(text, schema)` and `parseJsonRaw(text)`
- `packages/shared/src/type-guards.ts` — `isString`, `isNumber`, `hasStatus`, `hasMessage`

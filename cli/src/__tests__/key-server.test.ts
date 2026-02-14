import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Tests for key-server logic (.claude/skills/setup-agent-team/key-server.ts).
 *
 * The key server handles automated API key provisioning via signed one-time
 * links. It contains security-critical logic that has zero test coverage:
 * - HMAC signing/verification for signed URLs
 * - Timing-safe Bearer auth
 * - API key validation (blocking injection chars, control chars, length)
 * - Provider name validation (preventing path traversal)
 * - Rate limiting logic
 * - Data store cleanup (batch expiry, fulfilled cleanup)
 * - HTML escaping for XSS prevention
 * - UUID validation
 *
 * These tests replicate the core logic functions from key-server.ts and
 * validate them comprehensively. This pattern matches the existing codebase
 * convention (e.g., trigger-server.test.ts) where pure functions are
 * reimplemented to enable isolated testing.
 *
 * Agent: test-engineer
 */

// ── Replicated logic from key-server.ts ──────────────────────────────────────

/** Exact replica of validKeyVal from key-server.ts (lines 303-310) */
function validKeyVal(v: string): boolean {
  if (v.length === 0 || v.length > 4096) return false;
  // Block control characters (U+0000-U+001F, U+007F-U+009F)
  if (/[\x00-\x1f\x7f-\x9f]/.test(v)) return false;
  // Block shell metacharacters
  if (/[;&'"<>|$`\\(){}]/.test(v)) return false;
  return true;
}

/** Exact replica of SAFE_PROVIDER_RE from key-server.ts (line 172) */
const SAFE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Exact replica of UUID_RE from key-server.ts (lines 321-322) */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exact replica of signHmac from key-server.ts (lines 149-153) */
function signHmac(id: string, exp: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${id}:${exp}`)
    .digest("hex");
}

/** Exact replica of verifyHmac from key-server.ts (lines 155-161) */
function verifyHmac(id: string, sig: string, exp: string, secret: string): boolean {
  const e = parseInt(exp);
  if (isNaN(e) || e <= Date.now()) return false;
  const expected = signHmac(id, e, secret);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** Exact replica of isAuthed from key-server.ts (lines 164-169) */
function isAuthed(req: { authorization: string }, secret: string): boolean {
  const given = req.authorization;
  const expected = `Bearer ${secret}`;
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Exact replica of rateCheck from key-server.ts (lines 100-115) */
function rateCheck(
  key: string,
  map: Map<string, { count: number; resetAt: number }>,
  max: number,
  windowMs: number
): number | null {
  const now = Date.now();
  const e = map.get(key);
  if (!e || e.resetAt < now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (e.count >= max) return Math.ceil((e.resetAt - now) / 1000);
  e.count++;
  return null;
}

/** Exact replica of esc from key-server.ts (lines 246-252) */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Exact replica of cleanup from key-server.ts (lines 130-146) */
interface ProviderRequest {
  provider: string;
  providerName: string;
  envVars: { name: string }[];
  helpUrl: string;
  status: "pending" | "fulfilled";
}

interface KeyBatch {
  batchId: string;
  providers: ProviderRequest[];
  emailedAt: number;
  expiresAt: number;
}

interface DataStore {
  batches: KeyBatch[];
}

function cleanup(d: DataStore): void {
  const now = Date.now();
  const week = 7 * 86400_000;
  d.batches = d.batches.filter((b) => {
    if (
      b.providers.every((p) => p.status === "fulfilled") &&
      now - b.emailedAt > week
    )
      return false;
    if (
      b.expiresAt < now &&
      b.providers.every((p) => p.status === "pending")
    )
      return false;
    return true;
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ── validKeyVal (API key validation) ─────────────────────────────────────────

describe("validKeyVal - API key value validation", () => {
  it("should accept a simple alphanumeric key", () => {
    expect(validKeyVal("sk-abc123def456")).toBe(true);
  });

  it("should accept keys with hyphens and underscores", () => {
    expect(validKeyVal("sk_live_abc-123-def")).toBe(true);
  });

  it("should accept keys with dots", () => {
    expect(validKeyVal("key.value.test")).toBe(true);
  });

  it("should accept keys with colons", () => {
    expect(validKeyVal("project:key:value")).toBe(true);
  });

  it("should accept keys with equals and plus (base64-like)", () => {
    expect(validKeyVal("abc123+def/ghi=")).toBe(true);
  });

  it("should reject empty string", () => {
    expect(validKeyVal("")).toBe(false);
  });

  it("should reject strings exceeding 4096 bytes", () => {
    expect(validKeyVal("a".repeat(4097))).toBe(false);
  });

  it("should accept string at exactly 4096 bytes", () => {
    expect(validKeyVal("a".repeat(4096))).toBe(true);
  });

  it("should accept single character", () => {
    expect(validKeyVal("a")).toBe(true);
  });

  // Control character tests
  it("should reject null byte (U+0000)", () => {
    expect(validKeyVal("key\x00value")).toBe(false);
  });

  it("should reject tab (U+0009)", () => {
    expect(validKeyVal("key\tvalue")).toBe(false);
  });

  it("should reject newline (U+000A)", () => {
    expect(validKeyVal("key\nvalue")).toBe(false);
  });

  it("should reject carriage return (U+000D)", () => {
    expect(validKeyVal("key\rvalue")).toBe(false);
  });

  it("should reject escape (U+001B)", () => {
    expect(validKeyVal("key\x1bvalue")).toBe(false);
  });

  it("should reject U+001F (last C0 control char)", () => {
    expect(validKeyVal("key\x1fvalue")).toBe(false);
  });

  it("should reject DEL (U+007F)", () => {
    expect(validKeyVal("key\x7fvalue")).toBe(false);
  });

  it("should reject U+0080 (first C1 control char)", () => {
    expect(validKeyVal("key\x80value")).toBe(false);
  });

  it("should reject U+009F (last C1 control char)", () => {
    expect(validKeyVal("key\x9fvalue")).toBe(false);
  });

  it("should accept U+00A0 (non-breaking space, first non-control after C1)", () => {
    expect(validKeyVal("key\xa0value")).toBe(true);
  });

  // Shell metacharacter tests
  it("should reject semicolon", () => {
    expect(validKeyVal("key;rm -rf /")).toBe(false);
  });

  it("should reject ampersand", () => {
    expect(validKeyVal("key&command")).toBe(false);
  });

  it("should reject single quote", () => {
    expect(validKeyVal("key'value")).toBe(false);
  });

  it("should reject double quote", () => {
    expect(validKeyVal('key"value')).toBe(false);
  });

  it("should reject less-than", () => {
    expect(validKeyVal("key<file")).toBe(false);
  });

  it("should reject greater-than", () => {
    expect(validKeyVal("key>file")).toBe(false);
  });

  it("should reject pipe", () => {
    expect(validKeyVal("key|cat")).toBe(false);
  });

  it("should reject dollar sign", () => {
    expect(validKeyVal("key$HOME")).toBe(false);
  });

  it("should reject backtick", () => {
    expect(validKeyVal("key`whoami`")).toBe(false);
  });

  it("should reject backslash", () => {
    expect(validKeyVal("key\\value")).toBe(false);
  });

  it("should reject open parenthesis", () => {
    expect(validKeyVal("key(value")).toBe(false);
  });

  it("should reject close parenthesis", () => {
    expect(validKeyVal("key)value")).toBe(false);
  });

  it("should reject open brace", () => {
    expect(validKeyVal("key{value")).toBe(false);
  });

  it("should reject close brace", () => {
    expect(validKeyVal("key}value")).toBe(false);
  });

  // Real-world key formats
  it("should accept OpenAI-style key", () => {
    expect(validKeyVal("sk-proj-abcdefghijklmnop123456789012")).toBe(true);
  });

  it("should accept DO-style key with hex", () => {
    expect(validKeyVal("dop_v1_abc123def456abc123def456abc123def456abc123def456")).toBe(true);
  });

  it("should accept Hetzner-style key", () => {
    expect(validKeyVal("abcDEF123456789xyzXYZ")).toBe(true);
  });

  it("should accept keys with spaces (some providers use them)", () => {
    expect(validKeyVal("some key with spaces")).toBe(true);
  });

  it("should accept keys with at-sign", () => {
    expect(validKeyVal("user@provider")).toBe(true);
  });

  it("should accept keys with hash (not a shell metachar in values)", () => {
    expect(validKeyVal("key#tag")).toBe(true);
  });
});

// ── SAFE_PROVIDER_RE (path traversal prevention) ─────────────────────────────

describe("SAFE_PROVIDER_RE - provider name validation", () => {
  it("should accept simple lowercase name", () => {
    expect(SAFE_PROVIDER_RE.test("hetzner")).toBe(true);
  });

  it("should accept name with digits", () => {
    expect(SAFE_PROVIDER_RE.test("cloud123")).toBe(true);
  });

  it("should accept name with hyphens", () => {
    expect(SAFE_PROVIDER_RE.test("aws-lightsail")).toBe(true);
  });

  it("should accept name with underscores", () => {
    expect(SAFE_PROVIDER_RE.test("my_cloud")).toBe(true);
  });

  it("should accept name with dots", () => {
    expect(SAFE_PROVIDER_RE.test("cloud.provider")).toBe(true);
  });

  it("should accept single character", () => {
    expect(SAFE_PROVIDER_RE.test("a")).toBe(true);
  });

  it("should accept name at 64 characters (max length)", () => {
    expect(SAFE_PROVIDER_RE.test("a" + "b".repeat(63))).toBe(true);
  });

  it("should reject name exceeding 64 characters", () => {
    expect(SAFE_PROVIDER_RE.test("a" + "b".repeat(64))).toBe(false);
  });

  it("should reject empty string", () => {
    expect(SAFE_PROVIDER_RE.test("")).toBe(false);
  });

  it("should reject uppercase letters", () => {
    expect(SAFE_PROVIDER_RE.test("Hetzner")).toBe(false);
  });

  it("should reject starting with hyphen", () => {
    expect(SAFE_PROVIDER_RE.test("-cloud")).toBe(false);
  });

  it("should reject starting with dot", () => {
    expect(SAFE_PROVIDER_RE.test(".cloud")).toBe(false);
  });

  it("should reject starting with underscore", () => {
    expect(SAFE_PROVIDER_RE.test("_cloud")).toBe(false);
  });

  it("should reject path traversal: ../etc", () => {
    expect(SAFE_PROVIDER_RE.test("../etc")).toBe(false);
  });

  it("should reject path traversal: ../../etc/important", () => {
    expect(SAFE_PROVIDER_RE.test("../../etc/important")).toBe(false);
  });

  it("should reject forward slash", () => {
    expect(SAFE_PROVIDER_RE.test("cloud/sub")).toBe(false);
  });

  it("should reject spaces", () => {
    expect(SAFE_PROVIDER_RE.test("my cloud")).toBe(false);
  });

  it("should reject special characters", () => {
    expect(SAFE_PROVIDER_RE.test("cloud!")).toBe(false);
    expect(SAFE_PROVIDER_RE.test("cloud@")).toBe(false);
    expect(SAFE_PROVIDER_RE.test("cloud$")).toBe(false);
  });

  it("should reject null bytes in name", () => {
    expect(SAFE_PROVIDER_RE.test("cloud\x00")).toBe(false);
  });

  it("should reject newlines", () => {
    expect(SAFE_PROVIDER_RE.test("cloud\n")).toBe(false);
  });

  // Must start with alphanumeric
  it("should accept starting with digit", () => {
    expect(SAFE_PROVIDER_RE.test("1cloud")).toBe(true);
  });

  it("should accept digit-only name", () => {
    expect(SAFE_PROVIDER_RE.test("123")).toBe(true);
  });
});

// ── UUID_RE (batch ID validation) ────────────────────────────────────────────

describe("UUID_RE - batch ID validation", () => {
  it("should accept valid UUID v4", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("should accept all-zero UUID", () => {
    expect(UUID_RE.test("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("should accept all-f UUID", () => {
    expect(UUID_RE.test("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
  });

  it("should reject uppercase hex", () => {
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(false);
  });

  it("should reject missing hyphens", () => {
    expect(UUID_RE.test("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  it("should reject wrong hyphen positions", () => {
    expect(UUID_RE.test("550e840-0e29b-41d4-a716-4466554400000")).toBe(false);
  });

  it("should reject too short", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716")).toBe(false);
  });

  it("should reject empty string", () => {
    expect(UUID_RE.test("")).toBe(false);
  });

  it("should reject provider name (not a UUID)", () => {
    expect(UUID_RE.test("hetzner")).toBe(false);
  });

  it("should reject path traversal attempt", () => {
    expect(UUID_RE.test("../../../etc/passwd")).toBe(false);
  });

  it("should reject UUID with trailing characters", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000x")).toBe(false);
  });

  it("should reject UUID with leading characters", () => {
    expect(UUID_RE.test("x550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });
});

// ── HMAC signing and verification ────────────────────────────────────────────

describe("signHmac - HMAC signature generation", () => {
  const SECRET = "test-hmac-secret-key";

  it("should produce a hex string", () => {
    const sig = signHmac("batch-id", Date.now() + 86400_000, SECRET);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("should produce a 64-character sha256 hex digest", () => {
    const sig = signHmac("batch-id", 1700000000000, SECRET);
    expect(sig.length).toBe(64);
  });

  it("should produce deterministic output for same inputs", () => {
    const sig1 = signHmac("id-1", 1700000000000, SECRET);
    const sig2 = signHmac("id-1", 1700000000000, SECRET);
    expect(sig1).toBe(sig2);
  });

  it("should produce different output for different IDs", () => {
    const sig1 = signHmac("id-1", 1700000000000, SECRET);
    const sig2 = signHmac("id-2", 1700000000000, SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it("should produce different output for different expiry times", () => {
    const sig1 = signHmac("id-1", 1700000000000, SECRET);
    const sig2 = signHmac("id-1", 1700000001000, SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it("should produce different output for different secrets", () => {
    const sig1 = signHmac("id-1", 1700000000000, "secret-a");
    const sig2 = signHmac("id-1", 1700000000000, "secret-b");
    expect(sig1).not.toBe(sig2);
  });

  it("should sign the format 'id:exp'", () => {
    // Verify the signing format matches what verifyHmac expects
    const id = "test-batch";
    const exp = 1700000000000;
    const manual = createHmac("sha256", SECRET)
      .update(`${id}:${exp}`)
      .digest("hex");
    expect(signHmac(id, exp, SECRET)).toBe(manual);
  });
});

describe("verifyHmac - HMAC signature verification", () => {
  const SECRET = "test-hmac-secret-key";

  it("should verify a valid signature with future expiry", () => {
    const id = "batch-123";
    const exp = Date.now() + 86400_000; // 24h in future
    const sig = signHmac(id, exp, SECRET);
    expect(verifyHmac(id, sig, String(exp), SECRET)).toBe(true);
  });

  it("should reject expired signature", () => {
    const id = "batch-123";
    const exp = Date.now() - 1000; // 1s in past
    const sig = signHmac(id, exp, SECRET);
    expect(verifyHmac(id, sig, String(exp), SECRET)).toBe(false);
  });

  it("should reject signature at exactly current time", () => {
    const id = "batch-123";
    const exp = Date.now(); // right now — check is e <= Date.now()
    const sig = signHmac(id, exp, SECRET);
    // The check is `e <= Date.now()` so this should fail
    expect(verifyHmac(id, sig, String(exp), SECRET)).toBe(false);
  });

  it("should reject wrong signature", () => {
    const id = "batch-123";
    const exp = Date.now() + 86400_000;
    expect(verifyHmac(id, "deadbeef".repeat(8), String(exp), SECRET)).toBe(false);
  });

  it("should reject signature for different ID", () => {
    const exp = Date.now() + 86400_000;
    const sig = signHmac("batch-a", exp, SECRET);
    expect(verifyHmac("batch-b", sig, String(exp), SECRET)).toBe(false);
  });

  it("should reject non-numeric expiry", () => {
    expect(verifyHmac("batch-123", "abc", "not-a-number", SECRET)).toBe(false);
  });

  it("should reject empty expiry", () => {
    expect(verifyHmac("batch-123", "abc", "", SECRET)).toBe(false);
  });

  it("should reject signature of wrong length", () => {
    const id = "batch-123";
    const exp = Date.now() + 86400_000;
    // SHA256 hex is 64 chars; provide 63
    expect(verifyHmac(id, "a".repeat(63), String(exp), SECRET)).toBe(false);
  });

  it("should reject signature of correct length but wrong content", () => {
    const id = "batch-123";
    const exp = Date.now() + 86400_000;
    // Right length (64), wrong content
    expect(verifyHmac(id, "0".repeat(64), String(exp), SECRET)).toBe(false);
  });
});

// ── isAuthed (timing-safe Bearer token comparison) ───────────────────────────

describe("isAuthed - key-server timing-safe Bearer auth", () => {
  const SECRET = "key-server-secret-xyz";

  it("should accept correct Bearer token", () => {
    expect(isAuthed({ authorization: `Bearer ${SECRET}` }, SECRET)).toBe(true);
  });

  it("should reject wrong token", () => {
    expect(isAuthed({ authorization: "Bearer wrong-token" }, SECRET)).toBe(false);
  });

  it("should reject empty header", () => {
    expect(isAuthed({ authorization: "" }, SECRET)).toBe(false);
  });

  it("should reject missing Bearer prefix", () => {
    expect(isAuthed({ authorization: SECRET }, SECRET)).toBe(false);
  });

  it("should reject Basic auth scheme", () => {
    expect(isAuthed({ authorization: `Basic ${SECRET}` }, SECRET)).toBe(false);
  });

  it("should reject token with extra trailing space", () => {
    expect(isAuthed({ authorization: `Bearer ${SECRET} ` }, SECRET)).toBe(false);
  });

  it("should reject token that is a prefix of the secret", () => {
    expect(isAuthed({ authorization: "Bearer key-server" }, SECRET)).toBe(false);
  });

  it("should reject token that extends the secret", () => {
    expect(isAuthed({ authorization: `Bearer ${SECRET}extra` }, SECRET)).toBe(false);
  });

  it("should use length check to short-circuit different-length tokens", () => {
    // Different lengths => timingSafeEqual never called (would throw)
    const result = isAuthed({ authorization: "short" }, SECRET);
    expect(result).toBe(false);
  });
});

// ── rateCheck (rate limiting) ────────────────────────────────────────────────

describe("rateCheck - rate limiting logic", () => {
  let rateMap: Map<string, { count: number; resetAt: number }>;

  beforeEach(() => {
    rateMap = new Map();
  });

  it("should allow first request and return null", () => {
    const result = rateCheck("ip-1", rateMap, 5, 60_000);
    expect(result).toBeNull();
  });

  it("should create entry on first request", () => {
    rateCheck("ip-1", rateMap, 5, 60_000);
    expect(rateMap.has("ip-1")).toBe(true);
    expect(rateMap.get("ip-1")!.count).toBe(1);
  });

  it("should allow requests up to the max", () => {
    for (let i = 0; i < 5; i++) {
      const result = rateCheck("ip-1", rateMap, 5, 60_000);
      expect(result).toBeNull();
    }
  });

  it("should block request at max and return retry seconds", () => {
    for (let i = 0; i < 5; i++) {
      rateCheck("ip-1", rateMap, 5, 60_000);
    }
    const result = rateCheck("ip-1", rateMap, 5, 60_000);
    expect(result).toBeGreaterThan(0);
    expect(typeof result).toBe("number");
  });

  it("should return retry seconds as positive integer", () => {
    for (let i = 0; i < 3; i++) {
      rateCheck("ip-1", rateMap, 3, 15 * 60_000);
    }
    const retry = rateCheck("ip-1", rateMap, 3, 15 * 60_000)!;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60); // max 15 minutes in seconds
    expect(Math.ceil(retry)).toBe(retry); // should be an integer (Math.ceil)
  });

  it("should track separate keys independently", () => {
    for (let i = 0; i < 3; i++) {
      rateCheck("ip-1", rateMap, 3, 60_000);
    }
    // ip-1 is now at limit
    expect(rateCheck("ip-1", rateMap, 3, 60_000)).not.toBeNull();
    // ip-2 is fresh
    expect(rateCheck("ip-2", rateMap, 3, 60_000)).toBeNull();
  });

  it("should reset after window expires", () => {
    // Manually set an expired entry
    rateMap.set("ip-1", { count: 10, resetAt: Date.now() - 1000 });
    const result = rateCheck("ip-1", rateMap, 3, 60_000);
    expect(result).toBeNull();
    expect(rateMap.get("ip-1")!.count).toBe(1);
  });

  it("should increment count on subsequent requests", () => {
    rateCheck("ip-1", rateMap, 10, 60_000);
    expect(rateMap.get("ip-1")!.count).toBe(1);
    rateCheck("ip-1", rateMap, 10, 60_000);
    expect(rateMap.get("ip-1")!.count).toBe(2);
    rateCheck("ip-1", rateMap, 10, 60_000);
    expect(rateMap.get("ip-1")!.count).toBe(3);
  });

  it("should handle max=1 (one request per window)", () => {
    expect(rateCheck("ip-1", rateMap, 1, 60_000)).toBeNull();
    expect(rateCheck("ip-1", rateMap, 1, 60_000)).not.toBeNull();
  });
});

// ── esc (HTML escaping for XSS prevention) ───────────────────────────────────

describe("esc - HTML escaping", () => {
  it("should escape ampersand", () => {
    expect(esc("a&b")).toBe("a&amp;b");
  });

  it("should escape less-than", () => {
    expect(esc("a<b")).toBe("a&lt;b");
  });

  it("should escape greater-than", () => {
    expect(esc("a>b")).toBe("a&gt;b");
  });

  it("should escape double quote", () => {
    expect(esc('a"b')).toBe("a&quot;b");
  });

  it("should not escape single quote (not in the function)", () => {
    expect(esc("a'b")).toBe("a'b");
  });

  it("should handle empty string", () => {
    expect(esc("")).toBe("");
  });

  it("should handle string with no special chars", () => {
    expect(esc("hello world")).toBe("hello world");
  });

  it("should escape multiple occurrences", () => {
    expect(esc("a&b&c")).toBe("a&amp;b&amp;c");
  });

  it("should escape all special chars in one string", () => {
    expect(esc('<script>"alert(1)"</script>')).toBe(
      "&lt;script&gt;&quot;alert(1)&quot;&lt;/script&gt;"
    );
  });

  it("should handle XSS attempt: script tag", () => {
    expect(esc("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;"
    );
  });

  it("should handle XSS attempt: event handler", () => {
    expect(esc('onload="alert(1)"')).toBe("onload=&quot;alert(1)&quot;");
  });

  it("should handle URL with ampersands", () => {
    expect(esc("https://example.com?a=1&b=2")).toBe(
      "https://example.com?a=1&amp;b=2"
    );
  });

  it("should escape ampersand before other entities", () => {
    // Ensures & is escaped first so &lt; doesn't become &amp;lt;
    expect(esc("&lt;")).toBe("&amp;lt;");
  });
});

// ── cleanup (data store batch expiry) ────────────────────────────────────────

describe("cleanup - data store batch expiry", () => {
  function makeBatch(overrides: Partial<KeyBatch> & { batchId: string }): KeyBatch {
    return {
      providers: [
        {
          provider: "test",
          providerName: "Test",
          envVars: [{ name: "TEST_KEY" }],
          helpUrl: "https://example.com",
          status: "pending" as const,
        },
      ],
      emailedAt: Date.now(),
      expiresAt: Date.now() + 86400_000,
      ...overrides,
    };
  }

  it("should keep fresh pending batch", () => {
    const d: DataStore = {
      batches: [makeBatch({ batchId: "fresh-pending" })],
    };
    cleanup(d);
    expect(d.batches).toHaveLength(1);
  });

  it("should keep recent fulfilled batch (within 1 week)", () => {
    const d: DataStore = {
      batches: [
        makeBatch({
          batchId: "recent-fulfilled",
          providers: [
            {
              provider: "test",
              providerName: "Test",
              envVars: [{ name: "KEY" }],
              helpUrl: "",
              status: "fulfilled",
            },
          ],
          emailedAt: Date.now() - 3 * 86400_000, // 3 days ago
        }),
      ],
    };
    cleanup(d);
    expect(d.batches).toHaveLength(1);
  });

  it("should remove fulfilled batch older than 1 week", () => {
    const d: DataStore = {
      batches: [
        makeBatch({
          batchId: "old-fulfilled",
          providers: [
            {
              provider: "test",
              providerName: "Test",
              envVars: [{ name: "KEY" }],
              helpUrl: "",
              status: "fulfilled",
            },
          ],
          emailedAt: Date.now() - 8 * 86400_000, // 8 days ago
        }),
      ],
    };
    cleanup(d);
    expect(d.batches).toHaveLength(0);
  });

  it("should remove expired all-pending batch", () => {
    const d: DataStore = {
      batches: [
        makeBatch({
          batchId: "expired-pending",
          expiresAt: Date.now() - 1000, // expired
        }),
      ],
    };
    cleanup(d);
    expect(d.batches).toHaveLength(0);
  });

  it("should keep expired batch with mixed statuses (not all pending)", () => {
    const d: DataStore = {
      batches: [
        makeBatch({
          batchId: "expired-mixed",
          expiresAt: Date.now() - 1000, // expired
          providers: [
            {
              provider: "a",
              providerName: "A",
              envVars: [{ name: "KEY" }],
              helpUrl: "",
              status: "fulfilled",
            },
            {
              provider: "b",
              providerName: "B",
              envVars: [{ name: "KEY" }],
              helpUrl: "",
              status: "pending",
            },
          ],
        }),
      ],
    };
    cleanup(d);
    // Not all pending and not all fulfilled-and-old => keep
    expect(d.batches).toHaveLength(1);
  });

  it("should handle empty batches array", () => {
    const d: DataStore = { batches: [] };
    cleanup(d);
    expect(d.batches).toHaveLength(0);
  });

  it("should handle multiple batches with mixed retention", () => {
    const d: DataStore = {
      batches: [
        makeBatch({ batchId: "keep-1" }), // fresh pending
        makeBatch({
          batchId: "remove-1",
          expiresAt: Date.now() - 1000,
        }), // expired pending
        makeBatch({
          batchId: "remove-2",
          providers: [
            {
              provider: "x",
              providerName: "X",
              envVars: [{ name: "K" }],
              helpUrl: "",
              status: "fulfilled",
            },
          ],
          emailedAt: Date.now() - 10 * 86400_000,
        }), // old fulfilled
        makeBatch({ batchId: "keep-2" }), // fresh pending
      ],
    };
    cleanup(d);
    expect(d.batches).toHaveLength(2);
    expect(d.batches.map((b) => b.batchId)).toEqual(["keep-1", "keep-2"]);
  });

  it("should keep batch that is exactly at the week boundary", () => {
    const week = 7 * 86400_000;
    const d: DataStore = {
      batches: [
        makeBatch({
          batchId: "boundary",
          providers: [
            {
              provider: "x",
              providerName: "X",
              envVars: [{ name: "K" }],
              helpUrl: "",
              status: "fulfilled",
            },
          ],
          emailedAt: Date.now() - week, // exactly at boundary
        }),
      ],
    };
    cleanup(d);
    // now - emailedAt === week, condition is `> week` (strict), so it should be kept
    expect(d.batches).toHaveLength(1);
  });

  it("should remove batch 1ms past the week boundary", () => {
    const week = 7 * 86400_000;
    const d: DataStore = {
      batches: [
        makeBatch({
          batchId: "past-boundary",
          providers: [
            {
              provider: "x",
              providerName: "X",
              envVars: [{ name: "K" }],
              helpUrl: "",
              status: "fulfilled",
            },
          ],
          emailedAt: Date.now() - week - 1, // 1ms past
        }),
      ],
    };
    cleanup(d);
    expect(d.batches).toHaveLength(0);
  });
});

// ── Key submission validation flow ───────────────────────────────────────────

describe("Key submission validation flow", () => {
  it("should require all env vars for a provider to be filled", () => {
    // Simulates the form submission logic from key-server.ts (lines 482-510)
    const provider: ProviderRequest = {
      provider: "hetzner",
      providerName: "Hetzner",
      envVars: [{ name: "HETZNER_TOKEN" }, { name: "HETZNER_SSH_KEY" }],
      helpUrl: "",
      status: "pending",
    };

    // Only 1 of 2 filled => should NOT mark as fulfilled
    const formData = new Map<string, string>();
    formData.set("hetzner__HETZNER_TOKEN", "valid-token-123");
    formData.set("hetzner__HETZNER_SSH_KEY", ""); // empty

    let filled = 0;
    const vals: Record<string, string> = {};
    for (const v of provider.envVars) {
      const val = (formData.get(`${provider.provider}__${v.name}`) ?? "").trim();
      if (val) {
        if (!validKeyVal(val)) throw new Error("invalid");
        vals[v.name] = val;
        filled++;
      }
    }

    expect(filled).toBe(1);
    expect(filled === provider.envVars.length).toBe(false);
  });

  it("should mark as fulfilled when all env vars are filled", () => {
    const provider: ProviderRequest = {
      provider: "hetzner",
      providerName: "Hetzner",
      envVars: [{ name: "HETZNER_TOKEN" }],
      helpUrl: "",
      status: "pending",
    };

    const formData = new Map<string, string>();
    formData.set("hetzner__HETZNER_TOKEN", "valid-token-123");

    let filled = 0;
    for (const v of provider.envVars) {
      const val = (formData.get(`${provider.provider}__${v.name}`) ?? "").trim();
      if (val && validKeyVal(val)) filled++;
    }

    expect(filled).toBe(1);
    expect(filled === provider.envVars.length).toBe(true);
  });

  it("should reject key with shell injection in form submission", () => {
    const val = "token;rm -rf /";
    expect(validKeyVal(val)).toBe(false);
  });

  it("should reject key with command substitution", () => {
    const val = "token$(whoami)";
    expect(validKeyVal(val)).toBe(false);
  });

  it("should reject key with backtick injection", () => {
    const val = "token`id`";
    expect(validKeyVal(val)).toBe(false);
  });

  it("should trim whitespace from form values", () => {
    const rawVal = "  valid-token-123  ";
    const trimmed = rawVal.trim();
    expect(validKeyVal(trimmed)).toBe(true);
  });
});

// ── Route matching for /key/:id ──────────────────────────────────────────────

describe("Route matching for /key/:id", () => {
  const keyPattern = /^\/key\/([^/]+)$/;

  it("should match /key/batch-uuid", () => {
    const match = "/key/550e8400-e29b-41d4-a716-446655440000".match(keyPattern);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("should match /key/provider-name", () => {
    const match = "/key/hetzner".match(keyPattern);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("hetzner");
  });

  it("should not match /key/ (empty id)", () => {
    expect("/key/".match(keyPattern)).toBeNull();
  });

  it("should not match /key (no trailing slash or id)", () => {
    expect("/key".match(keyPattern)).toBeNull();
  });

  it("should not match /key/a/b (nested path)", () => {
    expect("/key/a/b".match(keyPattern)).toBeNull();
  });

  it("should not match /keys/something", () => {
    expect("/keys/something".match(keyPattern)).toBeNull();
  });

  it("should extract the full ID including special chars", () => {
    const match = "/key/abc-123_def.ghi".match(keyPattern);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("abc-123_def.ghi");
  });
});

// ── Security headers ─────────────────────────────────────────────────────────

describe("HTML security headers", () => {
  const HTML_HEADERS: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };

  it("should set Content-Type to text/html with charset", () => {
    expect(HTML_HEADERS["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("should set strict CSP: default-src none", () => {
    expect(HTML_HEADERS["Content-Security-Policy"]).toContain(
      "default-src 'none'"
    );
  });

  it("should allow inline styles in CSP", () => {
    expect(HTML_HEADERS["Content-Security-Policy"]).toContain(
      "style-src 'unsafe-inline'"
    );
  });

  it("should restrict form-action to self in CSP", () => {
    expect(HTML_HEADERS["Content-Security-Policy"]).toContain(
      "form-action 'self'"
    );
  });

  it("should set X-Content-Type-Options: nosniff", () => {
    expect(HTML_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("should set X-Frame-Options: DENY", () => {
    expect(HTML_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  it("should NOT include script-src (no scripts needed)", () => {
    expect(HTML_HEADERS["Content-Security-Policy"]).not.toContain(
      "script-src"
    );
  });
});

// ── Backward compatibility: saveKeys single-var mapping ──────────────────────

describe("saveKeys backward compatibility", () => {
  it("should add api_key and token aliases for single-var providers", () => {
    // Simulates the logic from key-server.ts (lines 290-301)
    function buildSaveData(vars: Record<string, string>): Record<string, string> {
      const data: Record<string, string> = { ...vars };
      if (Object.keys(vars).length === 1) {
        const v = Object.values(vars)[0];
        data.api_key = v;
        data.token = v;
      }
      return data;
    }

    const single = buildSaveData({ HETZNER_TOKEN: "abc123" });
    expect(single.HETZNER_TOKEN).toBe("abc123");
    expect(single.api_key).toBe("abc123");
    expect(single.token).toBe("abc123");
  });

  it("should NOT add aliases for multi-var providers", () => {
    function buildSaveData(vars: Record<string, string>): Record<string, string> {
      const data: Record<string, string> = { ...vars };
      if (Object.keys(vars).length === 1) {
        const v = Object.values(vars)[0];
        data.api_key = v;
        data.token = v;
      }
      return data;
    }

    const multi = buildSaveData({
      ACCESS_KEY: "key1",
      SECRET_KEY: "key2",
    });
    expect(multi.ACCESS_KEY).toBe("key1");
    expect(multi.SECRET_KEY).toBe("key2");
    expect(multi.api_key).toBeUndefined();
    expect(multi.token).toBeUndefined();
  });
});

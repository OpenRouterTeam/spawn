import { describe, expect, it } from "bun:test";
import { generateCodeChallenge, generateCodeVerifier } from "../shared/oauth";

describe("PKCE S256", () => {
  it("generateCodeVerifier returns a 43-char base64url string", () => {
    const verifier = generateCodeVerifier();
    // 32 bytes → 43 base64url chars (no padding)
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generateCodeVerifier produces unique values", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it("generateCodeChallenge produces a valid base64url SHA-256 hash", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    // SHA-256 → 32 bytes → 43 base64url chars
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generateCodeChallenge is deterministic for the same verifier", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const c1 = await generateCodeChallenge(verifier);
    const c2 = await generateCodeChallenge(verifier);
    expect(c1).toBe(c2);
  });

  it("matches the RFC 7636 Appendix B test vector", async () => {
    // RFC 7636 Appendix B test vector:
    // verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // expected challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("challenge differs for different verifiers", async () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    const c1 = await generateCodeChallenge(v1);
    const c2 = await generateCodeChallenge(v2);
    expect(c1).not.toBe(c2);
  });

  it("challenge contains no padding characters", async () => {
    // Run multiple times to increase confidence padding is stripped
    for (let i = 0; i < 10; i++) {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).not.toContain("=");
    }
  });

  it("challenge contains no standard base64 characters (+, /)", async () => {
    for (let i = 0; i < 10; i++) {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).not.toContain("+");
      expect(challenge).not.toContain("/");
    }
  });
});

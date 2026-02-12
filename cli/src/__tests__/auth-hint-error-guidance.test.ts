import { describe, it, expect } from "bun:test";
import {
  getScriptFailureGuidance,
  parseAuthEnvVars,
  getErrorMessage,
  getStatusDescription,
} from "../commands.js";

/**
 * Tests for the auth hint pipeline: how cloud auth configuration flows
 * through parseAuthEnvVars -> getAuthHint -> credentialHint ->
 * getScriptFailureGuidance to produce user-facing error messages.
 *
 * This pipeline is critical because it determines what troubleshooting
 * instructions users see when a spawn script fails. Incorrect or missing
 * hints lead to users not knowing which credentials they need.
 *
 * Coverage gaps addressed:
 * - getScriptFailureGuidance with authHint parameter (all exit codes)
 * - getScriptFailureGuidance without authHint parameter (all exit codes)
 * - credentialHint formatting with single vs. multi-variable auth
 * - credentialHint formatting with no auth (CLI-based auth)
 * - getStatusDescription for 404 and non-404 status codes
 * - getErrorMessage with various error types (duck typing)
 * - Integration: parseAuthEnvVars output fed into getScriptFailureGuidance
 *
 * Agent: test-engineer
 */

// ── Helper: simulates getAuthHint from commands.ts (not exported) ───────────

function getAuthHint(authString: string): string | undefined {
  const authVars = parseAuthEnvVars(authString);
  return authVars.length > 0 ? authVars.join(" + ") : undefined;
}

// ── getScriptFailureGuidance with authHint ──────────────────────────────────

describe("getScriptFailureGuidance with auth hints", () => {
  describe("exit code 1 (generic failure)", () => {
    it("should include cloud auth var when authHint is provided", () => {
      const lines = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("HCLOUD_TOKEN");
      expect(joined).toContain("OPENROUTER_API_KEY");
    });

    it("should show multi-credential hint for clouds with multiple auth vars", () => {
      const lines = getScriptFailureGuidance(1, "upcloud", "UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
      const joined = lines.join("\n");
      expect(joined).toContain("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
      expect(joined).toContain("OPENROUTER_API_KEY");
    });

    it("should show setup instruction when no authHint provided", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn sprite");
      expect(joined).not.toContain("need ");
    });

    it("should include common causes section", () => {
      const lines = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("Common causes:");
      expect(joined).toContain("Cloud provider API error");
    });
  });

  describe("exit code null (unknown exit code)", () => {
    it("should include auth hint in default case", () => {
      const lines = getScriptFailureGuidance(null, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("HCLOUD_TOKEN");
    });

    it("should show setup command when no auth hint", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn sprite");
    });

    it("should mention missing credentials", () => {
      const lines = getScriptFailureGuidance(null, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("Missing");
      expect(joined).toContain("credentials");
    });
  });

  describe("exit code 130 (Ctrl+C interrupt)", () => {
    it("should not include credential hints", () => {
      const lines = getScriptFailureGuidance(130, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("interrupted");
      expect(joined).not.toContain("HCLOUD_TOKEN");
    });

    it("should warn about running servers", () => {
      const lines = getScriptFailureGuidance(130, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("server was already created");
    });
  });

  describe("exit code 137 (killed/OOM)", () => {
    it("should not include credential hints", () => {
      const lines = getScriptFailureGuidance(137, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("killed");
      expect(joined).not.toContain("HCLOUD_TOKEN");
    });

    it("should suggest larger instance", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("RAM");
      expect(joined).toContain("larger instance");
    });
  });

  describe("exit code 255 (SSH failure)", () => {
    it("should not include credential hints", () => {
      const lines = getScriptFailureGuidance(255, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("SSH");
      expect(joined).not.toContain("HCLOUD_TOKEN");
    });

    it("should mention firewall and booting", () => {
      const lines = getScriptFailureGuidance(255, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("Firewall");
      expect(joined).toContain("booting");
    });
  });

  describe("exit code 127 (command not found)", () => {
    it("should mention cloud-specific CLI tools", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("command was not found");
      expect(joined).toContain("spawn hetzner");
    });

    it("should not include auth credential hints", () => {
      const lines = getScriptFailureGuidance(127, "sprite", "SPRITE_TOKEN");
      const joined = lines.join("\n");
      expect(joined).not.toContain("SPRITE_TOKEN");
    });
  });

  describe("exit code 126 (permission denied)", () => {
    it("should mention permission denied", () => {
      const lines = getScriptFailureGuidance(126, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("permission denied");
    });

    it("should suggest reporting if persistent", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("Report");
    });
  });

  describe("exit code 2 (shell syntax error)", () => {
    it("should indicate a bug in the script", () => {
      const lines = getScriptFailureGuidance(2, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("likely a bug");
    });

    it("should suggest reporting", () => {
      const lines = getScriptFailureGuidance(2, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("Report");
    });
  });

  describe("exit code 42 (unusual/unexpected code)", () => {
    it("should use default guidance with auth hint", () => {
      const lines = getScriptFailureGuidance(42, "hetzner", "HCLOUD_TOKEN");
      const joined = lines.join("\n");
      expect(joined).toContain("HCLOUD_TOKEN");
      expect(joined).toContain("Common causes:");
    });

    it("should use default guidance without auth hint", () => {
      const lines = getScriptFailureGuidance(42, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn sprite");
    });
  });
});

// ── Integration: parseAuthEnvVars -> getAuthHint -> getScriptFailureGuidance ─

describe("Auth hint pipeline integration", () => {
  describe("real cloud auth strings", () => {
    it("should produce correct hint for single-var auth (HCLOUD_TOKEN)", () => {
      const hint = getAuthHint("HCLOUD_TOKEN");
      expect(hint).toBe("HCLOUD_TOKEN");
      const lines = getScriptFailureGuidance(1, "hetzner", hint);
      const joined = lines.join("\n");
      expect(joined).toContain("HCLOUD_TOKEN");
      expect(joined).toContain("OPENROUTER_API_KEY");
    });

    it("should produce correct hint for multi-var auth (UPCLOUD_USERNAME + UPCLOUD_PASSWORD)", () => {
      const hint = getAuthHint("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
      expect(hint).toBe("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
      const lines = getScriptFailureGuidance(1, "upcloud", hint);
      const joined = lines.join("\n");
      expect(joined).toContain("UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
    });

    it("should produce correct hint for triple-var auth", () => {
      const hint = getAuthHint("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION");
      expect(hint).toBe("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION");
    });

    it("should produce no hint for CLI-based auth (sprite login)", () => {
      const hint = getAuthHint("sprite login");
      expect(hint).toBeUndefined();
    });

    it("should produce no hint for OAuth auth", () => {
      const hint = getAuthHint("OAuth + browser");
      expect(hint).toBeUndefined();
    });

    it("should produce no hint for 'none' auth", () => {
      const hint = getAuthHint("none");
      expect(hint).toBeUndefined();
    });

    it("should produce no hint for lowercase descriptions", () => {
      const hint = getAuthHint("gcloud auth login");
      expect(hint).toBeUndefined();
    });
  });

  describe("undefined authHint behavior", () => {
    it("should show spawn <cloud> setup hint when authHint is undefined (exit 1)", () => {
      const lines = getScriptFailureGuidance(1, "mycloud", undefined);
      const joined = lines.join("\n");
      expect(joined).toContain("spawn mycloud");
      expect(joined).toContain("setup");
    });

    it("should show spawn <cloud> setup hint when authHint is undefined (null exit)", () => {
      const lines = getScriptFailureGuidance(null, "mycloud", undefined);
      const joined = lines.join("\n");
      expect(joined).toContain("spawn mycloud");
    });
  });

  describe("exit code 1 with different real cloud auth patterns", () => {
    const realCloudAuth: Array<{cloud: string; auth: string; expectedVars: string[]}> = [
      { cloud: "hetzner", auth: "HCLOUD_TOKEN", expectedVars: ["HCLOUD_TOKEN"] },
      { cloud: "digitalocean", auth: "DO_API_TOKEN", expectedVars: ["DO_API_TOKEN"] },
      { cloud: "vultr", auth: "VULTR_API_KEY", expectedVars: ["VULTR_API_KEY"] },
      { cloud: "linode", auth: "LINODE_TOKEN", expectedVars: ["LINODE_TOKEN"] },
      { cloud: "upcloud", auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD", expectedVars: ["UPCLOUD_USERNAME", "UPCLOUD_PASSWORD"] },
    ];

    for (const { cloud, auth, expectedVars } of realCloudAuth) {
      it(`should show correct hint for ${cloud} (${auth})`, () => {
        const hint = getAuthHint(auth);
        expect(hint).toBeDefined();
        const lines = getScriptFailureGuidance(1, cloud, hint);
        const joined = lines.join("\n");
        for (const v of expectedVars) {
          expect(joined).toContain(v);
        }
        expect(joined).toContain("OPENROUTER_API_KEY");
      });
    }
  });
});

// ── getStatusDescription ───────────────────────────────────────────────────

describe("getStatusDescription", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should return 'HTTP NNN' for non-404 codes", () => {
    expect(getStatusDescription(500)).toBe("HTTP 500");
    expect(getStatusDescription(403)).toBe("HTTP 403");
    expect(getStatusDescription(502)).toBe("HTTP 502");
    expect(getStatusDescription(200)).toBe("HTTP 200");
  });

  it("should handle 0 status code", () => {
    expect(getStatusDescription(0)).toBe("HTTP 0");
  });

  it("should handle negative status code", () => {
    expect(getStatusDescription(-1)).toBe("HTTP -1");
  });
});

// ── getErrorMessage (duck typing) ──────────────────────────────────────────

describe("getErrorMessage", () => {
  it("should extract message from Error objects", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("should extract message from plain objects with message property", () => {
    expect(getErrorMessage({ message: "custom error" })).toBe("custom error");
  });

  it("should stringify non-error values", () => {
    expect(getErrorMessage("string error")).toBe("string error");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("should handle objects without message property", () => {
    expect(getErrorMessage({ code: "ENOENT" })).toBe("[object Object]");
  });

  it("should handle objects with empty message", () => {
    expect(getErrorMessage({ message: "" })).toBe("");
  });

  it("should handle objects with numeric message", () => {
    expect(getErrorMessage({ message: 123 })).toBe("123");
  });

  it("should handle boolean values", () => {
    expect(getErrorMessage(true)).toBe("true");
    expect(getErrorMessage(false)).toBe("false");
  });

  it("should handle Error subclasses", () => {
    const err = new TypeError("type mismatch");
    expect(getErrorMessage(err)).toBe("type mismatch");
  });

  it("should handle Error with custom properties", () => {
    const err = new Error("base error");
    (err as any).code = "CUSTOM";
    expect(getErrorMessage(err)).toBe("base error");
  });
});

// ── getScriptFailureGuidance return structure ──────────────────────────────

describe("getScriptFailureGuidance return format", () => {
  it("should always return an array of strings", () => {
    const codes = [null, 0, 1, 2, 42, 126, 127, 130, 137, 255];
    for (const code of codes) {
      const lines = getScriptFailureGuidance(code, "testcloud");
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(typeof line).toBe("string");
      }
    }
  });

  it("should return non-empty lines for all exit codes", () => {
    const codes = [null, 1, 2, 126, 127, 130, 137, 255];
    for (const code of codes) {
      const lines = getScriptFailureGuidance(code, "cloud");
      expect(lines.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("should include the cloud name in exit code 1 and default guidance", () => {
    for (const code of [1, null, 42]) {
      const lines = getScriptFailureGuidance(code, "mycloud");
      const joined = lines.join("\n");
      expect(joined).toContain("mycloud");
    }
  });

  it("should include cloud name in exit code 127 guidance", () => {
    const lines = getScriptFailureGuidance(127, "mycloud");
    const joined = lines.join("\n");
    expect(joined).toContain("mycloud");
  });
});

// ── Credential hint verb differences ────────────────────────────────────────

describe("credential hint verb in different exit codes", () => {
  it("exit code 1 uses 'Missing or invalid' verb", () => {
    const lines = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
    const joined = lines.join("\n");
    expect(joined).toContain("Missing or invalid");
  });

  it("exit code null (default) uses 'Missing' verb", () => {
    const lines = getScriptFailureGuidance(null, "hetzner", "HCLOUD_TOKEN");
    const joined = lines.join("\n");
    expect(joined).toContain("Missing");
  });

  it("exit code 1 without authHint suggests running spawn <cloud>", () => {
    const lines = getScriptFailureGuidance(1, "hetzner");
    const joined = lines.join("\n");
    expect(joined).toContain("spawn hetzner");
    expect(joined).toContain("setup");
  });

  it("exit code null without authHint suggests running spawn <cloud>", () => {
    const lines = getScriptFailureGuidance(null, "hetzner");
    const joined = lines.join("\n");
    expect(joined).toContain("spawn hetzner");
  });
});

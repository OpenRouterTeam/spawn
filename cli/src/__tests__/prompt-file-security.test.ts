import { describe, it, expect } from "bun:test";
import { validatePromptFilePath, validatePromptFileStats } from "../security.js";

describe("validatePromptFilePath", () => {
  it("should accept normal text file paths", () => {
    expect(() => validatePromptFilePath("prompt.txt")).not.toThrow();
    expect(() => validatePromptFilePath("./prompt.txt")).not.toThrow();
    expect(() => validatePromptFilePath("prompts/task.md")).not.toThrow();
    expect(() => validatePromptFilePath("/home/user/prompt.txt")).not.toThrow();
    expect(() => validatePromptFilePath("/tmp/instructions.md")).not.toThrow();
  });

  it("should reject empty paths", () => {
    expect(() => validatePromptFilePath("")).toThrow("Prompt file path is required");
    expect(() => validatePromptFilePath("   ")).toThrow("Prompt file path is required");
  });

  it("should reject SSH private key files", () => {
    expect(() => validatePromptFilePath("/home/user/.ssh/id_rsa")).toThrow("SSH");
    expect(() => validatePromptFilePath("/home/user/.ssh/id_ed25519")).toThrow("SSH");
    expect(() => validatePromptFilePath("~/.ssh/config")).toThrow("SSH directory");
    expect(() => validatePromptFilePath("/root/.ssh/authorized_keys")).toThrow("SSH directory");
  });

  it("should reject AWS credential files", () => {
    expect(() => validatePromptFilePath("/home/user/.aws/credentials")).toThrow("AWS");
    expect(() => validatePromptFilePath("/home/user/.aws/config")).toThrow("AWS");
  });

  it("should reject Google Cloud credential files", () => {
    expect(() => validatePromptFilePath("/home/user/.config/gcloud/application_default_credentials.json")).toThrow("Google Cloud");
  });

  it("should reject Azure credential files", () => {
    expect(() => validatePromptFilePath("/home/user/.azure/accessTokens.json")).toThrow("Azure");
  });

  it("should reject Kubernetes config files", () => {
    expect(() => validatePromptFilePath("/home/user/.kube/config")).toThrow("Kubernetes");
  });

  it("should reject Docker credential files", () => {
    expect(() => validatePromptFilePath("/home/user/.docker/config.json")).toThrow("Docker");
  });

  it("should reject .env files", () => {
    expect(() => validatePromptFilePath(".env")).toThrow("environment file");
    expect(() => validatePromptFilePath(".env.local")).toThrow("environment file");
    expect(() => validatePromptFilePath(".env.production")).toThrow("environment file");
    expect(() => validatePromptFilePath("/app/.env")).toThrow("environment file");
  });

  it("should reject npm credential files", () => {
    expect(() => validatePromptFilePath("/home/user/.npmrc")).toThrow("npm");
  });

  it("should reject netrc files", () => {
    expect(() => validatePromptFilePath("/home/user/.netrc")).toThrow("netrc");
  });

  it("should reject git credential files", () => {
    expect(() => validatePromptFilePath("/home/user/.git-credentials")).toThrow("Git credentials");
  });

  it("should reject /etc/shadow", () => {
    expect(() => validatePromptFilePath("/etc/shadow")).toThrow("password hashes");
  });

  it("should reject /etc/master.passwd", () => {
    expect(() => validatePromptFilePath("/etc/master.passwd")).toThrow("password hashes");
  });

  it("should accept /etc/hosts (non-sensitive system file)", () => {
    expect(() => validatePromptFilePath("/etc/hosts")).not.toThrow();
  });

  it("should accept normal config-directory paths that are not sensitive", () => {
    expect(() => validatePromptFilePath("/home/user/.config/spawn/prompt.txt")).not.toThrow();
  });

  it("should include helpful error message about exfiltration risk", () => {
    try {
      validatePromptFilePath("/home/user/.ssh/id_rsa");
      throw new Error("Expected to throw");
    } catch (e: any) {
      expect(e.message).toContain("sent to the agent");
      expect(e.message).toContain("plain text file");
    }
  });

  it("should reject SSH key files by filename pattern anywhere in path", () => {
    expect(() => validatePromptFilePath("/tmp/id_rsa")).toThrow("SSH key");
    expect(() => validatePromptFilePath("/backup/id_ed25519")).toThrow("SSH key");
    expect(() => validatePromptFilePath("id_ecdsa")).toThrow("SSH key");
    expect(() => validatePromptFilePath("/tmp/id_rsa.pub")).toThrow("SSH key");
  });
});

describe("validatePromptFileStats", () => {
  it("should accept regular files within size limit", () => {
    const stats = { isFile: () => true, size: 100 };
    expect(() => validatePromptFileStats("prompt.txt", stats)).not.toThrow();
  });

  it("should accept files at the 1MB limit", () => {
    const stats = { isFile: () => true, size: 1024 * 1024 };
    expect(() => validatePromptFileStats("prompt.txt", stats)).not.toThrow();
  });

  it("should reject non-regular files", () => {
    const stats = { isFile: () => false, size: 100 };
    expect(() => validatePromptFileStats("/dev/urandom", stats)).toThrow("not a regular file");
  });

  it("should reject files over 1MB", () => {
    const stats = { isFile: () => true, size: 1024 * 1024 + 1 };
    expect(() => validatePromptFileStats("huge.txt", stats)).toThrow("too large");
  });

  it("should reject empty files", () => {
    const stats = { isFile: () => true, size: 0 };
    expect(() => validatePromptFileStats("empty.txt", stats)).toThrow("empty");
  });

  it("should show file size in MB for large files", () => {
    const stats = { isFile: () => true, size: 5 * 1024 * 1024 };
    try {
      validatePromptFileStats("large.bin", stats);
      throw new Error("Expected to throw");
    } catch (e: any) {
      expect(e.message).toContain("5.0MB");
      expect(e.message).toContain("maximum is 1MB");
    }
  });
});

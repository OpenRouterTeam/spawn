/**
 * Security validation utilities for spawn CLI
 * SECURITY-CRITICAL: These functions protect against injection attacks
 */

// Allowlist pattern for agent and cloud identifiers
// Only lowercase alphanumeric, hyphens, and underscores allowed
const IDENTIFIER_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Validates an identifier (agent or cloud name) against security constraints.
 * SECURITY-CRITICAL: Prevents path traversal, command injection, and URL injection.
 *
 * @param identifier - The agent or cloud identifier to validate
 * @param fieldName - Human-readable field name for error messages
 * @throws Error if validation fails
 */
export function validateIdentifier(identifier: string, fieldName: string): void {
  if (!identifier || identifier.trim() === "") {
    throw new Error(`${fieldName} cannot be empty`);
  }

  // Check length constraints (prevent DoS via extremely long identifiers)
  if (identifier.length > 64) {
    throw new Error(`${fieldName} exceeds maximum length of 64 characters`);
  }

  // Allowlist validation: only safe characters
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `${fieldName} "${identifier}" contains invalid characters.\n` +
      `Only lowercase letters, numbers, hyphens, and underscores are allowed.\n` +
      `Run 'spawn agents' or 'spawn clouds' to see valid names.`
    );
  }

  // Prevent path traversal patterns (defense in depth)
  if (identifier.includes("..") || identifier.includes("/") || identifier.includes("\\")) {
    throw new Error(`${fieldName} contains path traversal characters`);
  }
}

/**
 * Validates a bash script for obvious malicious patterns before execution.
 * SECURITY-CRITICAL: Last line of defense before executing remote code.
 *
 * @param script - The script content to validate
 * @throws Error if dangerous patterns are detected
 */
export function validateScriptContent(script: string): void {
  // Ensure script is not empty
  if (!script || script.trim() === "") {
    throw new Error("Script content is empty");
  }

  // Check for obviously malicious patterns
  const dangerousPatterns: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /rm\s+-rf\s+\/(?!\w)/, description: "destructive filesystem operation (rm -rf /)" },
    { pattern: /mkfs\./, description: "filesystem formatting command" },
    { pattern: /dd\s+if=/, description: "raw disk operation" },
    { pattern: /:(){:|:&};:/, description: "fork bomb pattern" },
  ];

  for (const { pattern, description } of dangerousPatterns) {
    if (pattern.test(script)) {
      throw new Error(
        `Script blocked: contains potentially dangerous pattern (${description})`
      );
    }
  }

  // Ensure script starts with shebang
  if (!script.trim().startsWith("#!")) {
    throw new Error("Script must start with a valid shebang (e.g., #!/bin/bash)");
  }
}

/**
 * Validates a prompt string for non-interactive agent execution.
 * SECURITY-CRITICAL: Prevents command injection via prompt parameter.
 *
 * @param prompt - The user-provided prompt to validate
 * @throws Error if validation fails
 */
export function validatePrompt(prompt: string): void {
  if (!prompt || prompt.trim() === "") {
    throw new Error("Prompt cannot be empty");
  }

  // Check length constraints (10KB max to prevent DoS)
  const MAX_PROMPT_LENGTH = 10 * 1024;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }

  // Check for obvious command injection patterns
  // These patterns would break out of the shell quoting used in bash scripts
  const dangerousPatterns: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /\$\(.*\)/, description: "command substitution $()" },
    { pattern: /`[^`]*`/, description: "command substitution backticks" },
    { pattern: /;\s*rm\s+-rf/, description: "command chaining with rm -rf" },
    { pattern: /\|\s*bash/, description: "piping to bash" },
    { pattern: /\|\s*sh/, description: "piping to sh" },
  ];

  for (const { pattern, description } of dangerousPatterns) {
    if (pattern.test(prompt)) {
      throw new Error(
        `Prompt blocked: contains potentially dangerous pattern (${description}).\n` +
        `\n` +
        `If this is a false positive, use --prompt-file instead:\n` +
        `  echo "your prompt" > prompt.txt\n` +
        `  spawn <agent> <cloud> --prompt-file prompt.txt`
      );
    }
  }
}

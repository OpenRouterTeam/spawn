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
    throw new Error(
      "Script must start with a valid shebang (e.g., #!/bin/bash).\n" +
      "This usually means the download returned an error page instead of a script.\n" +
      "Try again, or check your internet connection."
    );
  }
}

// Sensitive path patterns that should never be read as prompt files
// These protect credentials and system files from accidental exfiltration
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  { pattern: /(?:^|\/)\.ssh\//, description: "SSH directory (may contain private keys)" },
  { pattern: /(?:^|\/)\.aws\//, description: "AWS credentials directory" },
  { pattern: /(?:^|\/)\.config\/gcloud\//, description: "Google Cloud credentials" },
  { pattern: /(?:^|\/)\.azure\//, description: "Azure credentials directory" },
  { pattern: /(?:^|\/)\.kube\//, description: "Kubernetes config (may contain tokens)" },
  { pattern: /(?:^|\/)\.docker\/config\.json$/, description: "Docker registry credentials" },
  { pattern: /(?:^|\/)\.npmrc$/, description: "npm credentials" },
  { pattern: /(?:^|\/)\.netrc$/, description: "netrc credentials" },
  { pattern: /(?:^|\/)\.env(?:\.\w+)?$/, description: "environment file (may contain secrets)" },
  { pattern: /(?:^|\/)\.git-credentials$/, description: "Git credentials" },
  { pattern: /^\/etc\/shadow$/, description: "system password hashes" },
  { pattern: /^\/etc\/master\.passwd$/, description: "system password hashes (macOS)" },
  { pattern: /id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/, description: "SSH key file" },
];

// Maximum prompt file size (1MB) to prevent accidental reads of large files
const MAX_PROMPT_FILE_SIZE = 1024 * 1024;

/**
 * Validates a prompt file path for safety before reading.
 * SECURITY-CRITICAL: Prevents reading sensitive files and exfiltrating credentials.
 *
 * @param filePath - The file path to validate
 * @throws Error if the path points to a sensitive file or fails validation
 */
export function validatePromptFilePath(filePath: string): void {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Prompt file path cannot be empty");
  }

  // Normalize the path to resolve .. and symlink-like textual tricks
  const { resolve } = require("path");
  const resolved = resolve(filePath);

  // Check against sensitive path patterns
  for (const { pattern, description } of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new Error(
        `Refusing to read '${filePath}': ${description}.\n` +
        `\n` +
        `Prompt file contents are sent to remote agents and may be logged.\n` +
        `Use a dedicated text file for your prompt instead.`
      );
    }
  }
}

/**
 * Validates prompt file metadata (must be a regular file, within size limit).
 *
 * @param filePath - The file path to check
 * @param statFn - Stat function (injectable for testing)
 * @throws Error if file is not suitable for reading as a prompt
 */
export function validatePromptFileStats(filePath: string, stats: { isFile: () => boolean; size: number }): void {
  if (!stats.isFile()) {
    throw new Error(
      `'${filePath}' is not a regular file.\n` +
      `Provide a path to a text file containing your prompt.`
    );
  }

  if (stats.size > MAX_PROMPT_FILE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Prompt file is too large (${sizeMB}MB). Maximum size is 1MB.\n` +
      `Use a shorter prompt or split it across multiple runs.`
    );
  }

  if (stats.size === 0) {
    throw new Error(
      `Prompt file is empty: ${filePath}\n` +
      `The file exists but contains no text. Add your prompt to the file and try again.`
    );
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
    throw new Error(
      `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters (${prompt.length} given).\n` +
      `For longer prompts, use --prompt-file to read from a file instead.`
    );
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
        `If this is a false positive, try rephrasing to avoid shell-like syntax\n` +
        `(e.g., describe the command instead of writing it literally).`
      );
    }
  }
}

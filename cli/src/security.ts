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
    const listCmd = fieldName.toLowerCase().includes("agent") ? "spawn agents" : "spawn clouds";
    throw new Error(
      `${fieldName} is required but was not provided.\n\n` +
      `Run '${listCmd}' to see all available options.`
    );
  }

  // Check length constraints (prevent DoS via extremely long identifiers)
  if (identifier.length > 64) {
    const listCmd = fieldName.toLowerCase().includes("agent") ? "spawn agents" : "spawn clouds";
    const entityType = fieldName.toLowerCase().includes("agent") ? "agent" : "cloud provider";
    throw new Error(
      `${fieldName} is too long (${identifier.length} characters, maximum is 64).\n\n` +
      `This looks unusual. ${entityType.charAt(0).toUpperCase() + entityType.slice(1)} names are typically short identifiers.\n\n` +
      `Did you accidentally paste something else? Check that you're using the correct ${entityType} name.\n\n` +
      `To see all available ${entityType}s, run: ${listCmd}`
    );
  }

  // Allowlist validation: only safe characters
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    const listCmd = fieldName.toLowerCase().includes("agent") ? "spawn agents" : "spawn clouds";
    const entityType = fieldName.toLowerCase().includes("agent") ? "agent" : "cloud provider";
    throw new Error(
      `Invalid ${fieldName.toLowerCase()}: "${identifier}"\n\n` +
      `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} names can only contain:\n` +
      `  • Lowercase letters (a-z)\n` +
      `  • Numbers (0-9)\n` +
      `  • Hyphens (-) and underscores (_)\n\n` +
      `Examples of valid names:\n` +
      `  • claude\n` +
      `  • github-codespaces\n` +
      `  • e2b\n\n` +
      `To see all available ${entityType}s, run: ${listCmd}`
    );
  }

  // Prevent path traversal patterns (defense in depth)
  if (identifier.includes("..") || identifier.includes("/") || identifier.includes("\\")) {
    const listCmd = fieldName.toLowerCase().includes("agent") ? "spawn agents" : "spawn clouds";
    const entityType = fieldName.toLowerCase().includes("agent") ? "agent" : "cloud provider";
    throw new Error(
      `Invalid ${fieldName.toLowerCase()}: "${identifier}"\n\n` +
      `The name contains path-like characters that aren't allowed:\n` +
      `  • Forward slashes (/)\n` +
      `  • Backslashes (\\)\n` +
      `  • Parent directory references (..)\n\n` +
      `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} names must be simple identifiers without paths.\n\n` +
      `To see all available ${entityType}s, run: ${listCmd}`
    );
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
    throw new Error(
      "The downloaded script is empty.\n\n" +
      "This usually means the server returned an error instead of the script.\n\n" +
      "How to fix:\n" +
      "  1. Check your internet connection\n" +
      "  2. Verify the combination exists: spawn matrix\n" +
      "  3. Wait a moment and try again (the server may be temporarily unavailable)"
    );
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
        `Security check failed: the downloaded script contains a dangerous pattern.\n\n` +
        `Pattern detected: ${description}\n\n` +
        `This is unexpected and may indicate the file was tampered with or corrupted.\n` +
        `Please report this at: https://github.com/OpenRouterTeam/spawn/issues`
      );
    }
  }

  // Ensure script starts with shebang
  if (!script.trim().startsWith("#!")) {
    throw new Error(
      "The downloaded file doesn't appear to be a valid bash script.\n\n" +
      "Common causes:\n" +
      "  • The server returned an error page (404, 500, etc.) instead of the script\n" +
      "  • Network connection was interrupted during download\n" +
      "  • The script file hasn't been published yet (even though it appears in the matrix)\n\n" +
      "How to fix:\n" +
      "  1. Check your internet connection and try again\n" +
      "  2. Run 'spawn matrix' to verify the combination is marked as implemented\n" +
      "  3. Wait a few moments (the script may be deploying) and retry\n" +
      "  4. If the issue persists, report it: https://github.com/OpenRouterTeam/spawn/issues"
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
    throw new Error(
      "Prompt file path is required when using --prompt-file.\n\n" +
      "Example:\n" +
      "  spawn <agent> <cloud> --prompt-file instructions.txt"
    );
  }

  // Normalize the path to resolve .. and symlink-like textual tricks
  const { resolve } = require("path");
  const resolved = resolve(filePath);

  // Check against sensitive path patterns
  for (const { pattern, description } of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new Error(
        `Security check failed: cannot use '${filePath}' as a prompt file.\n\n` +
        `This path points to ${description}.\n` +
        `Prompt contents are sent to the agent and may be logged or stored remotely.\n\n` +
        `For security, use a plain text file instead:\n` +
        `  1. Create a new file: echo "Your instructions here" > prompt.txt\n` +
        `  2. Use it: spawn <agent> <cloud> --prompt-file prompt.txt`
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
      `Cannot read prompt: '${filePath}' is not a regular file.\n\n` +
      `The path points to a directory, device, or other non-file object.\n` +
      `Provide a path to a text file containing your prompt.`
    );
  }

  if (stats.size > MAX_PROMPT_FILE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Prompt file is too large: ${sizeMB}MB (maximum is 1MB).\n\n` +
      `How to fix:\n` +
      `  • Use a shorter, more focused prompt\n` +
      `  • Break the work into multiple smaller tasks\n` +
      `  • Remove unnecessary context or examples`
    );
  }

  if (stats.size === 0) {
    throw new Error(
      `Prompt file is empty: ${filePath}\n\n` +
      `The file exists but contains no text.\n` +
      `Add your instructions to the file and try again.`
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
    throw new Error(
      "Prompt is required but was not provided.\n\n" +
      "Provide a prompt with --prompt:\n" +
      "  spawn <agent> <cloud> --prompt \"Your task here\"\n\n" +
      "Or use a file:\n" +
      "  spawn <agent> <cloud> --prompt-file prompt.txt"
    );
  }

  // Check length constraints (10KB max to prevent DoS)
  const MAX_PROMPT_LENGTH = 10 * 1024;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    const lengthKB = (prompt.length / 1024).toFixed(1);
    throw new Error(
      `Your prompt is too long (${lengthKB}KB, maximum is 10KB).\n\n` +
      `For longer instructions, save them to a file instead:\n\n` +
      `  1. Save your prompt: echo "Your long instructions..." > instructions.txt\n` +
      `  2. Use the file: spawn <agent> <cloud> --prompt-file instructions.txt\n\n` +
      `This also makes it easier to edit and reuse your prompts.`
    );
  }

  // Check for obvious command injection patterns
  // These patterns would break out of the shell quoting used in bash scripts
  const dangerousPatterns: Array<{ pattern: RegExp; description: string; suggestion: string }> = [
    { pattern: /\$\(.*\)/, description: "command substitution $()", suggestion: 'Instead of "Fix $(ls)", try "Fix the output from ls"' },
    { pattern: /`[^`]*`/, description: "backtick command substitution", suggestion: "Describe the command output instead of using backticks" },
    { pattern: /;\s*rm\s+-rf/, description: "dangerous command sequence", suggestion: "Describe what you want the agent to do without using shell syntax" },
    { pattern: /\|\s*bash/, description: "shell piping to bash", suggestion: "Describe the desired outcome instead" },
    { pattern: /\|\s*sh/, description: "shell piping to sh", suggestion: "Describe the desired outcome instead" },
  ];

  for (const { pattern, description, suggestion } of dangerousPatterns) {
    if (pattern.test(prompt)) {
      throw new Error(
        `Your prompt contains shell syntax that can't be safely passed to the agent.\n\n` +
        `Issue: ${description}\n\n` +
        `${suggestion}\n\n` +
        `Important: You don't need to write shell commands in your prompt!\n` +
        `Just describe what you want in plain English, and the agent will write the code for you.\n\n` +
        `Example:\n` +
        `  Instead of: "Fix $(ls -la)"\n` +
        `  Write: "Fix the directory listing issues"`
      );
    }
  }
}

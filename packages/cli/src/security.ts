/**
 * Security validation utilities for spawn CLI
 * SECURITY-CRITICAL: These functions protect against injection attacks
 */

import { resolve } from "node:path";

// Allowlist pattern for agent and cloud identifiers
// Only lowercase alphanumeric, hyphens, and underscores allowed
const IDENTIFIER_PATTERN = /^[a-z0-9_-]+$/;

// IPv4 address pattern (simple validation)
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

// IPv6 address pattern (simplified - catches most valid IPv6 addresses)
const IPV6_PATTERN = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

// Hostname pattern: valid DNS hostnames (e.g., ssh.app.daytona.io)
// Only allows safe characters: lowercase alphanumeric, hyphens, dots
// Must have at least two labels (e.g., "host.domain")
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Unix username pattern: starts with lowercase letter or underscore,
// followed by lowercase letters, digits, underscores, hyphens, optional $ suffix
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]*\$?$/;

// Special connection sentinel values (not actual IPs)
const CONNECTION_SENTINELS = [
  "sprite-console",
  "daytona-sandbox",
  "localhost",
];

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
      `${fieldName} is required but was not provided.\n\n` + `Run '${listCmd}' to see all available options.`,
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
        `To see all available ${entityType}s, run: ${listCmd}`,
    );
  }

  // Allowlist validation: only safe characters
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    const listCmd = fieldName.toLowerCase().includes("agent") ? "spawn agents" : "spawn clouds";
    const entityType = fieldName.toLowerCase().includes("agent") ? "agent" : "cloud provider";
    throw new Error(
      `Invalid ${fieldName.toLowerCase()}: "${identifier}"\n\n` +
        `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} names can only contain:\n` +
        "  • Lowercase letters (a-z)\n" +
        "  • Numbers (0-9)\n" +
        "  • Hyphens (-) and underscores (_)\n\n" +
        "Examples of valid names:\n" +
        "  • claude\n" +
        "  • github-codespaces\n" +
        "  • e2b\n\n" +
        `To see all available ${entityType}s, run: ${listCmd}`,
    );
  }

  // Prevent path traversal patterns (defense in depth)
  if (identifier.includes("..") || identifier.includes("/") || identifier.includes("\\")) {
    const listCmd = fieldName.toLowerCase().includes("agent") ? "spawn agents" : "spawn clouds";
    const entityType = fieldName.toLowerCase().includes("agent") ? "agent" : "cloud provider";
    throw new Error(
      `Invalid ${fieldName.toLowerCase()}: "${identifier}"\n\n` +
        `The name contains path-like characters that aren't allowed:\n` +
        "  • Forward slashes (/)\n" +
        "  • Backslashes (\\)\n" +
        "  • Parent directory references (..)\n\n" +
        `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} names must be simple identifiers without paths.\n\n` +
        `To see all available ${entityType}s, run: ${listCmd}`,
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
        "  3. Wait a moment and try again (the server may be temporarily unavailable)",
    );
  }

  // Check for obviously malicious patterns
  const dangerousPatterns: Array<{
    pattern: RegExp;
    description: string;
  }> = [
    {
      pattern: /rm\s+-rf\s+\/(?!\w)/,
      description: "destructive filesystem operation (rm -rf /)",
    },
    {
      pattern: /mkfs\./,
      description: "filesystem formatting command",
    },
    {
      pattern: /dd\s+if=/,
      description: "raw disk operation",
    },
    {
      pattern: /:(){:|:&};:/,
      description: "fork bomb pattern",
    },
  ];

  for (const { pattern, description } of dangerousPatterns) {
    if (pattern.test(script)) {
      throw new Error(
        "Security check failed: the downloaded script contains a dangerous pattern.\n\n" +
          `Pattern detected: ${description}\n\n` +
          "This is unexpected and may indicate the file was tampered with or corrupted.\n" +
          "Please report this at: https://github.com/OpenRouterTeam/spawn/issues",
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
        "  4. If the issue persists, report it: https://github.com/OpenRouterTeam/spawn/issues",
    );
  }
}

/**
 * Validates a connection IP address or special sentinel value.
 * SECURITY-CRITICAL: Prevents command injection via malicious IP addresses in history.
 *
 * Allows:
 * - Valid IPv4 addresses (e.g., "192.168.1.1")
 * - Valid IPv6 addresses (e.g., "::1", "2001:db8::1")
 * - Valid hostnames (e.g., "ssh.app.daytona.io")
 * - Special sentinel values ("sprite-console", "daytona-sandbox", "localhost")
 *
 * @param ip - The IP address or sentinel to validate
 * @throws Error if validation fails
 */
export function validateConnectionIP(ip: string): void {
  if (!ip || ip.trim() === "") {
    throw new Error("Connection IP is required but was empty");
  }

  // Allow special sentinel values
  if (CONNECTION_SENTINELS.includes(ip)) {
    return;
  }

  // Validate as IPv4 (with octet range check) or IPv6
  const isIPv4 = IPV4_PATTERN.test(ip);
  const isIPv6 = IPV6_PATTERN.test(ip);

  if (isIPv4) {
    // Additional check: ensure each octet is 0-255
    const octets = ip.split(".");
    const validOctets = octets.every((octet) => {
      const num = Number.parseInt(octet, 10);
      return num >= 0 && num <= 255;
    });
    if (!validOctets) {
      throw new Error(
        `Invalid connection IP address: "${ip}"\n\n` +
          "IPv4 addresses must have octets in the range 0-255.\n\n" +
          "Your spawn history file may be corrupted or tampered with.\n" +
          `To fix: run 'spawn list --clear' to reset history`,
      );
    }
    return;
  }

  if (isIPv6) {
    return;
  }

  // Validate as hostname (e.g., ssh.app.daytona.io)
  if (HOSTNAME_PATTERN.test(ip)) {
    return;
  }

  // Neither IPv4, IPv6, nor valid hostname
  throw new Error(
    `Invalid connection IP address: "${ip}"\n\n` +
      `Expected a valid IPv4 or IPv6 address, hostname, or one of: ${CONNECTION_SENTINELS.join(", ")}\n\n` +
      "Your spawn history file may be corrupted or tampered with.\n" +
      `To fix: run 'spawn list --clear' to reset history`,
  );
}

/**
 * Validates a Unix username.
 * SECURITY-CRITICAL: Prevents command injection via malicious usernames in history.
 *
 * Pattern: lowercase letters, digits, underscores, hyphens, optional $ suffix
 * Examples: root, ubuntu, user-123, _system, deploy$
 *
 * @param username - The username to validate
 * @throws Error if validation fails
 */
export function validateUsername(username: string): void {
  if (!username || username.trim() === "") {
    throw new Error("Username is required but was empty");
  }

  if (username.length > 32) {
    throw new Error(
      `Username is too long: "${username}" (${username.length} characters, maximum is 32)\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      `Invalid username: "${username}"\n\n` +
        "Unix usernames must:\n" +
        "  • Start with a lowercase letter or underscore\n" +
        "  • Contain only lowercase letters, digits, underscores, hyphens\n" +
        "  • Optionally end with $ (for system accounts)\n\n" +
        "Examples of valid usernames: root, ubuntu, user-123, _system\n\n" +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }
}

/**
 * Validates a server identifier (server_id or server_name from cloud provider).
 * SECURITY-CRITICAL: Prevents command injection via malicious server IDs in history.
 *
 * Pattern: alphanumeric, hyphens, underscores, dots
 * Examples: hetzner-12345, i-0abcd1234, my-server.example
 *
 * @param id - The server identifier to validate
 * @throws Error if validation fails
 */
export function validateServerIdentifier(id: string): void {
  if (!id || id.trim() === "") {
    throw new Error("Server identifier is required but was empty");
  }

  if (id.length > 128) {
    throw new Error(
      `Server identifier is too long: "${id}" (${id.length} characters, maximum is 128)\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }

  // Prevent path traversal patterns (check BEFORE general pattern validation)
  if (id.includes("..") || id.startsWith("/") || id.startsWith("\\")) {
    throw new Error(
      `Invalid server identifier: "${id}"\n\n` +
        "Server identifiers cannot contain path-like patterns (/, \\, ..)\n\n" +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }

  // Allowlist: alphanumeric, hyphens, underscores, dots
  // Reject shell metacharacters: ; & | $ ( ) ` ' " \ < > space newline
  const serverIdPattern = /^[a-zA-Z0-9_.-]+$/;
  if (!serverIdPattern.test(id)) {
    throw new Error(
      `Invalid server identifier: "${id}"\n\n` +
        "Server identifiers can only contain:\n" +
        "  • Letters and digits (a-z, A-Z, 0-9)\n" +
        "  • Hyphens (-), underscores (_), dots (.)\n\n" +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }
}

/**
 * Validates a metadata value from connection history (e.g., GCP zone, project).
 * SECURITY-CRITICAL: Prevents command injection via tampered history files.
 *
 * Allows lowercase/uppercase alphanumeric, hyphens, underscores, and dots.
 * Blocks shell metacharacters: ; & | $ ( ) ` ' " \ < > space newline
 *
 * @param value - The metadata value to validate
 * @param fieldName - Human-readable field name for error messages
 * @throws Error if validation fails
 */
export function validateMetadataValue(value: string, fieldName: string): void {
  if (!value || value.trim() === "") {
    return; // Empty values are allowed (caller provides defaults)
  }

  if (value.length > 128) {
    throw new Error(
      `${fieldName} is too long: "${value}" (${value.length} characters, maximum is 128)\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }

  const SAFE_METADATA_PATTERN = /^[a-zA-Z0-9_.-]+$/;
  if (!SAFE_METADATA_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}"\n\n` +
        `${fieldName} can only contain letters, digits, hyphens, underscores, and dots.\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `To fix: run 'spawn list --clear' to reset history`,
    );
  }
}

// Sensitive path patterns that should never be read as prompt files
// These protect credentials and system files from accidental exfiltration
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  description: string;
}> = [
  {
    pattern: /(?:^|\/)\.ssh\//,
    description: "SSH directory (may contain private keys)",
  },
  {
    pattern: /(?:^|\/)\.aws\//,
    description: "AWS credentials directory",
  },
  {
    pattern: /(?:^|\/)\.config\/gcloud\//,
    description: "Google Cloud credentials",
  },
  {
    pattern: /(?:^|\/)\.azure\//,
    description: "Azure credentials directory",
  },
  {
    pattern: /(?:^|\/)\.kube\//,
    description: "Kubernetes config (may contain tokens)",
  },
  {
    pattern: /(?:^|\/)\.docker\/config\.json$/,
    description: "Docker registry credentials",
  },
  {
    pattern: /(?:^|\/)\.npmrc$/,
    description: "npm credentials",
  },
  {
    pattern: /(?:^|\/)\.netrc$/,
    description: "netrc credentials",
  },
  {
    pattern: /(?:^|\/)\.env(?:\.\w+)?$/,
    description: "environment file (may contain secrets)",
  },
  {
    pattern: /(?:^|\/)\.git-credentials$/,
    description: "Git credentials",
  },
  {
    pattern: /^\/etc\/shadow$/,
    description: "system password hashes",
  },
  {
    pattern: /^\/etc\/master\.passwd$/,
    description: "system password hashes (macOS)",
  },
  {
    pattern: /id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/,
    description: "SSH key file",
  },
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
        "  spawn <agent> <cloud> --prompt-file instructions.txt",
    );
  }

  // Normalize the path to resolve .. and symlink-like textual tricks
  const resolved = resolve(filePath);

  // Check against sensitive path patterns
  for (const { pattern, description } of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new Error(
        `Security check failed: cannot use '${filePath}' as a prompt file.\n\n` +
          `This path points to ${description}.\n` +
          "Prompt contents are sent to the agent and may be logged or stored remotely.\n\n" +
          "For security, use a plain text file instead:\n" +
          `  1. Create a new file: echo "Your instructions here" > prompt.txt\n` +
          "  2. Use it: spawn <agent> <cloud> --prompt-file prompt.txt",
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
export function validatePromptFileStats(
  filePath: string,
  stats: {
    isFile: () => boolean;
    size: number;
  },
): void {
  if (!stats.isFile()) {
    throw new Error(
      `Cannot read prompt: '${filePath}' is not a regular file.\n\n` +
        "The path points to a directory, device, or other non-file object.\n" +
        "Provide a path to a text file containing your prompt.",
    );
  }

  if (stats.size > MAX_PROMPT_FILE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Prompt file is too large: ${sizeMB}MB (maximum is 1MB).\n\n` +
        "How to fix:\n" +
        "  • Use a shorter, more focused prompt\n" +
        "  • Break the work into multiple smaller tasks\n" +
        "  • Remove unnecessary context or examples",
    );
  }

  if (stats.size === 0) {
    throw new Error(
      `Prompt file is empty: ${filePath}\n\n` +
        "The file exists but contains no text.\n" +
        "Add your instructions to the file and try again.",
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
        '  spawn <agent> <cloud> --prompt "Your task here"\n\n' +
        "Or use a file:\n" +
        "  spawn <agent> <cloud> --prompt-file prompt.txt",
    );
  }

  // Check length constraints (10KB max to prevent DoS)
  const MAX_PROMPT_LENGTH = 10 * 1024;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    const lengthKB = (prompt.length / 1024).toFixed(1);
    throw new Error(
      `Your prompt is too long (${lengthKB}KB, maximum is 10KB).\n\n` +
        "For longer instructions, save them to a file instead:\n\n" +
        `  1. Save your prompt: echo "Your long instructions..." > instructions.txt\n` +
        "  2. Use the file: spawn <agent> <cloud> --prompt-file instructions.txt\n\n" +
        "This also makes it easier to edit and reuse your prompts.",
    );
  }

  // Check for obvious command injection patterns
  // These patterns would break out of the shell quoting used in bash scripts
  const dangerousPatterns: Array<{
    pattern: RegExp;
    description: string;
    suggestion: string;
  }> = [
    {
      pattern: /\$\(.*\)/,
      description: "command substitution $()",
      suggestion: 'Instead of "Fix $(ls)", try "Fix the output from ls"',
    },
    {
      pattern: /`[^`]*`/,
      description: "backtick command substitution",
      suggestion: "Describe the command output instead of using backticks",
    },
    {
      pattern: /;\s*rm\s+-rf/,
      description: "dangerous command sequence",
      suggestion: "Describe what you want the agent to do without using shell syntax",
    },
    {
      pattern: /\|\s*bash/,
      description: "shell piping to bash",
      suggestion: "Describe the desired outcome instead",
    },
    {
      pattern: /\|\s*sh/,
      description: "shell piping to sh",
      suggestion: "Describe the desired outcome instead",
    },
    {
      pattern: /\$\{[^}]*\}/,
      description: "bash variable expansion",
      suggestion: "Describe the value you need instead of using shell variables",
    },
    // Match && and || only when they appear to be shell command chaining
    // Pattern: look for common shell commands after && or ||
    // This avoids false positives on programming expressions like "a > b && c < d" or "value || default"
    {
      pattern:
        /&&\s+(ls|rm|cp|mv|mkdir|cat|grep|find|echo|curl|wget|git|npm|yarn|bun|cd|chmod|chown|sudo|kill|pkill|systemctl|service|apt|yum|brew|docker|kubectl|terraform|ansible|python|node|go|java|ruby|php|perl|bash|sh|zsh|fish|powershell|cmd|exit|return)\b/i,
      description: "command chaining with &&",
      suggestion: "Describe your tasks separately instead of chaining commands",
    },
    {
      pattern:
        /\|\|\s+(ls|rm|cp|mv|mkdir|cat|grep|find|echo|curl|wget|git|npm|yarn|bun|cd|chmod|chown|sudo|kill|pkill|systemctl|service|apt|yum|brew|docker|kubectl|terraform|ansible|python|node|go|java|ruby|php|perl|bash|sh|zsh|fish|powershell|cmd|exit|return)\b/i,
      description: "command chaining with ||",
      suggestion: "Describe error handling in plain language",
    },
    // Match redirection only when followed by filesystem paths (/, ~, or word chars at line boundaries)
    // This avoids false positives on mathematical comparisons like "x > 5"
    {
      pattern: />\s*[/~]/,
      description: "file redirection",
      suggestion: "Ask the agent to save output instead of using redirection syntax",
    },
    {
      pattern: />\s*\w+\.\w+/,
      description: "file redirection",
      suggestion: "Ask the agent to save output instead of using redirection syntax",
    },
    {
      pattern: /<\s*[/~]/,
      description: "file input redirection",
      suggestion: "Describe the input source in plain language",
    },
    {
      pattern: /<\s*\w+\.\w+/,
      description: "file input redirection",
      suggestion: "Describe the input source in plain language",
    },
    {
      pattern: /&\s*$/,
      description: "background execution",
      suggestion: "Describe the desired behavior instead",
    },
    // Stderr/fd redirections: 2>, 2>&1, 1>&2
    {
      pattern: /\d+>\s*&?\d*/,
      description: "stderr/fd redirection",
      suggestion: "Describe the output handling in plain language instead",
    },
    // Heredoc syntax: << EOF or <<- EOF
    {
      pattern: /<<-?\s*'?\w+'?/,
      description: "heredoc",
      suggestion: "Describe the multi-line input in plain language instead",
    },
    // Process substitution: <(cmd) or >(cmd)
    {
      pattern: /<\s*\(|>\s*\(/,
      description: "process substitution",
      suggestion: "Describe the command output in plain language instead",
    },
    // Redirection to paths with slashes: > foo/bar, > dir/output
    {
      pattern: />\s*\w+\/[\w/]*/,
      description: "file redirection to path",
      suggestion: "Ask the agent to save output instead of using redirection syntax",
    },
    // Redirection to simple filenames without extensions (3+ chars to avoid math like "> 5")
    {
      pattern: />>?\s*[a-zA-Z_]\w{2,}/,
      description: "file redirection to path",
      suggestion: "Ask the agent to save output instead of using redirection syntax",
    },
  ];

  for (const { pattern, description, suggestion } of dangerousPatterns) {
    if (pattern.test(prompt)) {
      throw new Error(
        `Your prompt contains shell syntax that can't be safely passed to the agent.\n\n` +
          `Issue: ${description}\n\n` +
          `${suggestion}\n\n` +
          `Important: You don't need to write shell commands in your prompt!\n` +
          "Just describe what you want in plain English, and the agent will write the code for you.\n\n" +
          "Example:\n" +
          `  Instead of: "Fix $(ls -la)"\n` +
          `  Write: "Fix the directory listing issues"`,
      );
    }
  }

  // Generic check for suspicious operator combinations
  // Exclude comparison expressions (like "a > b && c < d") by checking for comparison context
  // Pattern matches doubled operators but not when used in comparison expressions
  const hasDoubledOperators = /[;&|<>]\s*[;&|<>]/.test(prompt);
  const looksLikeComparison = /\w\s*[<>!=]=?\s*\w\s*&&\s*\w\s*[<>!=]=?\s*\w/.test(prompt);

  if (hasDoubledOperators && !looksLikeComparison) {
    throw new Error(
      "Your prompt contains shell operators that could be unsafe.\n\n" +
        "Please describe what you want in plain English without shell syntax.\n\n" +
        "Example:\n" +
        `  Instead of: "Build a web server && deploy it"\n` +
        `  Write: "Build a web server and deploy it"`,
    );
  }
}

// Side-effect module: must be imported BEFORE @clack/prompts
// to influence its unicode detection (which runs at import time).
//
// @clack/prompts checks: process.env.TERM !== "linux" on non-Windows.
// Setting TERM=linux forces ASCII fallback symbols (>, *, |, etc.)

const shouldForceAscii = (): boolean => {
  // Explicit user override to enable Unicode
  if (process.env.SPAWN_UNICODE === "1") {
    return false;
  }

  // Explicit user override to force ASCII
  if (process.env.SPAWN_NO_UNICODE === "1" || process.env.SPAWN_ASCII === "1") {
    return true;
  }

  // Already detected as needing ASCII by clack's own logic
  if (process.env.TERM === "linux") {
    return false; // clack will handle this
  }

  // Dumb terminals and serial consoles lack unicode support
  if (process.env.TERM === "dumb" || !process.env.TERM) {
    return true;
  }

  // Check if we're in a cloud/remote environment that might not render unicode well
  // Common patterns: SSH sessions, cloud shells, container terminals
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
    return true; // SSH sessions often have unicode rendering issues
  }

  // Default to ASCII for safety - users can opt-in with SPAWN_UNICODE=1
  return true;
};

if (shouldForceAscii()) {
  process.env.TERM = "linux";
}

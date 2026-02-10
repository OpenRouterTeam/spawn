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

  // Dumb terminals and serial consoles lack unicode support
  if (process.env.TERM === "dumb" || !process.env.TERM) {
    return true;
  }

  // SSH sessions often have encoding mismatches between client/server
  // This is the most common source of Unicode rendering issues
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
    return true;
  }

  // Default to Unicode for local terminals (macOS Terminal, iTerm2, modern Linux terminals)
  // These have excellent Unicode support and proper fonts installed
  return false;
};

if (shouldForceAscii()) {
  process.env.TERM = "linux";
}

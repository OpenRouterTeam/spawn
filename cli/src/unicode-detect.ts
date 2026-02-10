// Side-effect module: must be imported BEFORE @clack/prompts
// to influence its unicode detection (which runs at import time).
//
// @clack/prompts checks: process.env.TERM !== "linux" on non-Windows.
// Setting TERM=linux forces ASCII fallback symbols (>, *, |, etc.)

const shouldForceAscii = (): boolean => {
  // Explicit user override
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

  return false;
};

if (shouldForceAscii()) {
  process.env.TERM = "linux";
}

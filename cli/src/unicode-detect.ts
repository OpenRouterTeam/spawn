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

const forceAscii = shouldForceAscii();

// Debug logging (only if SPAWN_DEBUG is set)
if (process.env.SPAWN_DEBUG === "1") {
  console.error("[unicode-detect] TERM:", process.env.TERM);
  console.error("[unicode-detect] SSH_CONNECTION:", process.env.SSH_CONNECTION);
  console.error("[unicode-detect] SSH_CLIENT:", process.env.SSH_CLIENT);
  console.error("[unicode-detect] SSH_TTY:", process.env.SSH_TTY);
  console.error("[unicode-detect] Force ASCII:", forceAscii);
}

if (forceAscii) {
  process.env.TERM = "linux";
} else {
  // Ensure LANG includes UTF-8
  if (!process.env.LANG || !process.env.LANG.includes("UTF-8")) {
    process.env.LANG = "en_US.UTF-8";
  }

  // Monkey-patch stdout.write to explicitly encode strings as UTF-8 Buffer.
  // This fixes mojibake (â instead of ◆) seen in some Bun + terminal combos
  // where process.stdout.write(string) doesn't use UTF-8 by default.
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = function (
    chunk: any,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void
  ): boolean {
    if (typeof chunk === "string") {
      const encoding =
        typeof encodingOrCb === "string" ? encodingOrCb : "utf8";
      return originalStdoutWrite(Buffer.from(chunk, encoding), cb ?? (typeof encodingOrCb === "function" ? encodingOrCb : undefined));
    }
    return originalStdoutWrite(chunk, encodingOrCb as any, cb);
  };
}

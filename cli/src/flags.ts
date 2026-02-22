/** CLI flag definitions and utilities — single source of truth for flag validation */

export const KNOWN_FLAGS = new Set([
  "--help", "-h",
  "--version", "-v", "-V",
  "--prompt", "-p", "--prompt-file", "-f",
  "--dry-run", "-n",
  "--debug",
  "--headless",
  "--output",
  "--name",
  "--default",
  "-a", "-c", "--agent", "--cloud",
  "--clear",
]);

/** Return the first unknown flag in args, or null if all are known/positional */
export function findUnknownFlag(args: string[]): string | null {
  for (const arg of args) {
    if (
      (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg))) &&
      !KNOWN_FLAGS.has(arg)
    ) {
      return arg;
    }
  }
  return null;
}

/** Expand --flag=value into --flag value so all flag parsing works uniformly */
export function expandEqualsFlags(args: string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      result.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      result.push(arg);
    }
  }
  return result;
}

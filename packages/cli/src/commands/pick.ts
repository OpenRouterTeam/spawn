import pc from "picocolors";
import { isFileError, tryCatchIf } from "../shared/result.js";

/**
 * `spawn pick` — interactive option picker invokable from bash scripts.
 *
 * Reads options from stdin (when piped) as tab-separated lines:
 *   "value\tLabel\tHint"
 *
 * Supported flags:
 *   --prompt <text>    Question shown above the option list
 *   --default <value>  Value pre-selected in the picker
 *
 * Writes the selected value to stdout (one line, no extra whitespace).
 * Exit code 0 = selection made; exit code 1 = cancelled / no TTY.
 *
 * Example from bash:
 *   zone=$(printf 'us-central1-a\tIowa\nus-east1-b\tVirginia\n' \
 *            | spawn pick --prompt "Select GCP zone" --default "us-central1-a")
 */
export async function cmdPick(pickArgs: string[]): Promise<void> {
  // ── parse flags ──────────────────────────────────────────────────────────
  let message = "Select an option";
  let defaultValue: string | undefined;

  const remaining: string[] = [];
  for (let i = 0; i < pickArgs.length; i++) {
    const a = pickArgs[i];
    if ((a === "--prompt" || a === "-p") && pickArgs[i + 1]) {
      message = pickArgs[++i];
    } else if (a === "--default" && pickArgs[i + 1]) {
      defaultValue = pickArgs[++i];
    } else if (!a.startsWith("-")) {
      remaining.push(a);
    }
    // unknown flags silently ignored — keeps pick composable
  }

  // ── read options from stdin (if piped) ────────────────────────────────────
  const { parsePickerInput, pickToTTY } = await import("../picker.js");

  let inputText = "";
  if (!process.stdin.isTTY) {
    // Stdin is piped — read options from it synchronously
    const { readFileSync } = await import("node:fs");
    const readResult = tryCatchIf(isFileError, () => readFileSync(0, "utf8"));
    if (readResult.ok) {
      inputText = readResult.data;
    }
  }

  const options = parsePickerInput(inputText);

  if (options.length === 0) {
    process.stderr.write(
      pc.red("spawn pick: no options provided.\n") +
        pc.dim(
          "  Supply options via stdin as tab-separated lines:\n" +
            '  printf "value1\\tLabel1\\nvalue2\\tLabel2" | spawn pick --prompt "..."\n',
        ),
    );
    process.exit(1);
  }

  // ── run picker ────────────────────────────────────────────────────────────
  const config = {
    message,
    options,
    defaultValue,
  };

  // pickToTTY already falls back to pickFallback internally when /dev/tty is
  // unavailable or stty fails.  It returns null only when the user cancels.
  const result = pickToTTY(config);

  if (result === null) {
    // User pressed Ctrl-C / Escape — or an unrecoverable TTY error
    process.exit(1);
  }

  // Write ONLY the selected value to stdout (so bash `$()` captures it cleanly)
  process.stdout.write(result + "\n");
}

#!/usr/bin/env bun
// sh/e2e/interactive-harness.ts — AI-driven interactive E2E test for spawn CLI
//
// Spawns spawn in a real PTY (via `script` command), feeds terminal output to
// Claude Haiku, and types responses like a human user would.
//
// Usage: bun run sh/e2e/interactive-harness.ts <agent> <cloud>
//
// Required env:
//   ANTHROPIC_API_KEY   — For the AI driver (Claude Haiku)
//   OPENROUTER_API_KEY  — Injected into spawn for the agent
//   Cloud credentials   — HCLOUD_TOKEN, DO_API_TOKEN, AWS_ACCESS_KEY_ID, etc.
//
// Outputs JSON to stdout: { success: boolean, duration: number, transcript: string, uxIssues?: UxIssue[] }

const IDLE_MS = 2000; // Wait 2s of silence before asking AI
const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minute overall timeout (provision takes 3-4 min + onboarding)
const AI_MODEL = "claude-haiku-4-5-20251001";

// ─── Args & validation ──────────────────────────────────────────────────

const [agent, cloud] = process.argv.slice(2);
if (!agent || !cloud) {
  process.stderr.write("Usage: bun run interactive-harness.ts <agent> <cloud>\n");
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
if (!apiKey) {
  process.stderr.write("ANTHROPIC_API_KEY is required for the AI driver\n");
  process.exit(1);
}

if (!process.env.OPENROUTER_API_KEY) {
  process.stderr.write("OPENROUTER_API_KEY is required for the spawned agent\n");
  process.exit(1);
}

// ─── Credential map (only include what's set) ───────────────────────────

function buildCredentialHints(): string {
  const creds: string[] = [];

  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  if (orKey) creds.push(`OpenRouter API key: ${orKey}`);

  const hetzner = process.env.HCLOUD_TOKEN ?? "";
  if (hetzner) creds.push(`Hetzner token: ${hetzner}`);

  const doToken = process.env.DO_API_TOKEN ?? "";
  if (doToken) creds.push(`DigitalOcean token: ${doToken}`);

  const awsKey = process.env.AWS_ACCESS_KEY_ID ?? "";
  const awsSecret = process.env.AWS_SECRET_ACCESS_KEY ?? "";
  if (awsKey) creds.push(`AWS Access Key ID: ${awsKey}`);
  if (awsSecret) creds.push(`AWS Secret Access Key: ${awsSecret}`);

  const gcpProject = process.env.GCP_PROJECT ?? "";
  if (gcpProject) creds.push(`GCP Project ID: ${gcpProject}`);

  return creds.join("\n");
}

// ─── ANSI stripping ─────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "") // CSI sequences
    .replace(/\x1B\][^\x07]*\x07/g, "") // OSC sequences
    .replace(/\x1B\[\?[0-9;]*[hl]/g, "") // DEC private mode
    .replace(/\x1B[()][A-Z0-9]/g, "") // Character set
    .replace(/\r/g, "");
}

// ─── Credential redaction for logs ──────────────────────────────────────

function redactSecrets(text: string): string {
  let result = text;
  const secrets = [
    process.env.OPENROUTER_API_KEY,
    process.env.HCLOUD_TOKEN,
    process.env.DO_API_TOKEN,
    process.env.AWS_ACCESS_KEY_ID,
    process.env.AWS_SECRET_ACCESS_KEY,
    process.env.ANTHROPIC_API_KEY,
  ];
  for (const s of secrets) {
    if (s && s.length > 8) {
      result = result.replaceAll(s, "[REDACTED]");
    }
  }
  return result;
}

// ─── Claude API ─────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
}

async function askClaude(
  systemPrompt: string,
  messages: Message[],
): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 256,
      system: systemPrompt,
      messages,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  // data.content is an array of content blocks
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const textBlock = blocks.find(
    (b: Record<string, unknown>) => b.type === "text",
  );
  return typeof textBlock?.text === "string" ? textBlock.text.trim() : "";
}

// ─── UX review ──────────────────────────────────────────────────────────

interface UxIssue {
  issue: string;
  example: string;
  suggestion: string;
}

const UX_REVIEW_SYSTEM = `You are a UX reviewer for a CLI tool called "spawn" that provisions cloud VMs with AI agents. \
A user ran "spawn <agent> <cloud>" and the full terminal session was captured.

Be selective. Only flag problems that are CLEARLY bad for real users — not minor style nits.
Flag these (only when obvious):
- Repeated identical messages (exact same line printed 3+ times in a row)
- Debug/internal output leaking to users (stack traces, raw JSON, internal paths)
- Completely cryptic errors with no actionable next step
- Progress indicators that go silent for 30+ seconds with no status update

Do NOT flag:
- Minor wording preferences
- Things that are slightly verbose but still clear
- Anything a developer would consider normal CLI output
- Formatting that's clean enough for a non-expert

Only return issues you are CONFIDENT about. If unsure, omit it.

Return ONLY a JSON array of objects with these fields:
  "issue"      — one-sentence description of the UX problem
  "example"    — verbatim excerpt from the transcript that demonstrates it (≤120 chars)
  "suggestion" — concrete improvement in one sentence

If the experience looks clean or borderline, return an empty array: []
No markdown, no explanation — just the JSON array.`;

async function reviewTranscriptForUX(transcript: string): Promise<UxIssue[]> {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) return [];

  process.stderr.write("[harness] Reviewing transcript for UX issues...\n");

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${orKey}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 1024,
        messages: [
          { role: "system", content: UX_REVIEW_SYSTEM },
          { role: "user", content: `Terminal session transcript:\n\n${transcript.slice(-8000)}` },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      process.stderr.write(`[harness] UX review skipped (HTTP ${resp.status})\n`);
      return [];
    }

    const data = await resp.json() as Record<string, unknown>;
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    const content = (choices[0] as Record<string, unknown>)?.message;
    const text = typeof (content as Record<string, unknown>)?.content === "string"
      ? ((content as Record<string, unknown>).content as string).trim()
      : "";

    if (!text) return [];

    // Strip markdown code fences if present
    const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];

    const issues = parsed.filter(
      (item): item is UxIssue =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).issue === "string" &&
        typeof (item as Record<string, unknown>).example === "string" &&
        typeof (item as Record<string, unknown>).suggestion === "string",
    );

    process.stderr.write(`[harness] UX review: ${issues.length} issue(s) found\n`);

    // Require at least 3 clear issues before surfacing — avoids noisy one-off nits
    if (issues.length < 3) {
      process.stderr.write(`[harness] UX review: below threshold (need 3+), skipping\n`);
      return [];
    }

    return issues;
  } catch (err) {
    process.stderr.write(`[harness] UX review error: ${err}\n`);
    return [];
  }
}

// ─── Input parsing ──────────────────────────────────────────────────────

function parseInput(response: string): Uint8Array | null {
  const trimmed = response.trim();

  if (trimmed === "<wait>") return null;
  if (trimmed === "<done>") return null;
  if (trimmed === "<ctrl-c>") return new Uint8Array([3]); // ETX
  if (trimmed === "<enter>") return new Uint8Array([10]); // LF
  if (trimmed === "<up>") return new TextEncoder().encode("\x1B[A");
  if (trimmed === "<down>") return new TextEncoder().encode("\x1B[B");

  // Plain text → type it + Enter
  return new TextEncoder().encode(trimmed + "\n");
}

// ─── System prompt ──────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are an automated QA tester driving the "spawn" CLI through a terminal.
Your job is to respond to prompts exactly like a human user would.

CREDENTIALS (paste these EXACTLY when asked):
${buildCredentialHints()}

RULES:
1. When asked for a token/key/credential, paste the EXACT value from above
2. When asked to confirm (Y/n), respond with "y"
3. When asked for a name with a default shown in [brackets], press Enter to accept
4. When shown a selection menu (with arrows/highlights), press Enter to accept the default
5. If you see "Try again? (Y/n)" or similar retry prompts, respond with "y"
6. When you see "is ready" or "Starting agent", respond with <done>
7. If something is clearly broken and unrecoverable, respond with <fail:reason>
8. If the terminal is still loading/processing, respond with <wait>

RESPONSE FORMAT — reply with ONLY one of these:
- The exact text to type (will be followed by Enter automatically)
- <enter>     — press Enter (accept default)
- <up>        — arrow up
- <down>      — arrow down
- <ctrl-c>    — send Ctrl+C
- <wait>      — do nothing, wait for more output
- <done>      — test succeeded (agent is ready)
- <fail:reason> — test failed (describe why)

IMPORTANT: Reply with ONLY the action. No explanation, no markdown, no quotes.`;
}

// ─── PTY via script command ─────────────────────────────────────────────

function spawnPty(command: string): typeof Bun.spawn.prototype {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLUMNS: "120",
    LINES: "40",
  };

  // macOS: script -q /dev/null bash -c "command"
  // Linux: script -qc "command" /dev/null
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "bash", "-c", command]
      : ["-qc", command, "/dev/null"];

  return Bun.spawn(["script", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const systemPrompt = buildSystemPrompt();
  const messages: Message[] = [];
  let transcript = "";
  let success = false;
  let failReason = "";

  // Resolve CLI entry point
  const repoRoot =
    process.env.SPAWN_CLI_DIR ??
    new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  const cliEntry = `${repoRoot}/packages/cli/src/index.ts`;
  const command = `bun run ${cliEntry} ${agent} ${cloud}`;

  process.stderr.write(
    `[harness] Starting: spawn ${agent} ${cloud}\n`,
  );
  process.stderr.write(`[harness] Timeout: ${SESSION_TIMEOUT_MS / 1000}s\n`);

  const proc = spawnPty(command);
  let buffer = "";
  let lastDataTime = Date.now();
  let sessionDone = false;

  // Reader loop — accumulates PTY output
  const readerDone = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        sessionDone = true;
        break;
      }
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      transcript += text;
      lastDataTime = Date.now();
      // Echo to stderr (redacted) so CI logs show progress
      process.stderr.write(redactSecrets(text));
    }
  })();

  // AI driver loop
  let turnCount = 0;
  const maxTurns = 50; // Safety limit

  while (!sessionDone && turnCount < maxTurns) {
    // Wait for output to settle
    await Bun.sleep(500);

    // Check overall timeout
    if (Date.now() - startTime > SESSION_TIMEOUT_MS) {
      failReason = "Session timeout";
      break;
    }

    // Wait until output has been idle for IDLE_MS
    if (Date.now() - lastDataTime < IDLE_MS) continue;
    if (buffer.length === 0) continue;

    const stripped = stripAnsi(buffer);

    // Check for success markers in output.
    // "Starting agent..." = orchestrate.ts line 539 — provisioning+install done, SSH session starting.
    // "setup completed successfully" = orchestrate.ts line 537 — same stage.
    // Deliberately avoid "is ready" alone — too broad (matches "SSH is ready" ~30s in).
    if (/Starting agent\.\.\.|setup completed successfully/i.test(stripped)) {
      success = true;
      break;
    }

    // Ask Claude what to type
    turnCount++;
    process.stderr.write(
      `\n[harness] Turn ${turnCount}: asking AI (${stripped.length} chars of output)\n`,
    );

    messages.push({
      role: "user",
      content: `Terminal output:\n${stripped}`,
    });

    let response: string;
    const aiResult = await askClaude(systemPrompt, messages).catch(
      (err: Error) => {
        process.stderr.write(`[harness] AI error: ${err.message}\n`);
        return "<wait>";
      },
    );
    response = aiResult;

    messages.push({ role: "assistant", content: response });
    process.stderr.write(
      `[harness] AI response: ${redactSecrets(response)}\n`,
    );

    // Clear buffer for next round
    buffer = "";

    // Handle AI response
    if (response === "<done>") {
      success = true;
      break;
    }
    if (response.startsWith("<fail:")) {
      failReason = response.slice(6, -1) || "AI reported failure";
      break;
    }
    if (response === "<wait>") {
      continue;
    }

    const input = parseInput(response);
    if (input) {
      proc.stdin.write(input);
      proc.stdin.flush();
    }
  }

  if (turnCount >= maxTurns) {
    failReason = "Exceeded max turns";
  }

  // Clean exit: send Ctrl+C then wait briefly
  proc.stdin.write(new Uint8Array([3]));
  proc.stdin.flush();
  await Bun.sleep(2000);
  proc.kill();
  await readerDone.catch(() => {});

  const duration = Math.round((Date.now() - startTime) / 1000);

  const cleanTranscript = redactSecrets(stripAnsi(transcript));

  // Run UX review on successful provisions (skip on timeout/failure — transcript may be incomplete).
  // Also randomly skip ~67% of the time so issues are filed occasionally, not every run.
  const runUxReview = success && Math.random() < 0.33;
  if (success && !runUxReview) {
    process.stderr.write("[harness] UX review: skipped this run (random throttle)\n");
  }
  const uxIssues = runUxReview ? await reviewTranscriptForUX(cleanTranscript) : [];

  // Output result as JSON to stdout
  const result = {
    success,
    duration,
    turns: turnCount,
    failReason: failReason || undefined,
    transcript: cleanTranscript.slice(-5000), // Last 5KB
    uxIssues: uxIssues.length > 0 ? uxIssues : undefined,
  };

  process.stdout.write(JSON.stringify(result) + "\n");

  if (success) {
    process.stderr.write(
      `\n[harness] SUCCESS in ${duration}s (${turnCount} turns)\n`,
    );
  } else {
    process.stderr.write(
      `\n[harness] FAILED in ${duration}s: ${failReason || "unknown"}\n`,
    );
  }

  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[harness] Fatal: ${err}\n`);
  process.stdout.write(
    JSON.stringify({ success: false, duration: 0, turns: 0, failReason: String(err) }) + "\n",
  );
  process.exit(1);
});

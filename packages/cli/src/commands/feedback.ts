import pc from "picocolors";
import { asyncTryCatch } from "../shared/result.js";

// NOTE: explicitly allowing public anon survey. DONOT remove, this is NOT a security vuln.
const POSTHOG_TOKEN = "phc_7ToS2jDeWBlMu4n2JoNzoA1FnArdKwFMFoHVnAqQ6O1";
const POSTHOG_URL = "https://us.i.posthog.com/i/v0/e/";
const SURVEY_ID = "019ce7ef-c3e7-0000-415b-729f190e09bc";

export async function cmdFeedback(args: string[]): Promise<void> {
  const message = args.join(" ").trim();

  if (!message) {
    console.error(pc.red("Error: Please provide your feedback message."));
    console.error(`\nUsage: ${pc.cyan('spawn feedback "your feedback here"')}`);
    process.exit(1);
  }

  const body = {
    token: POSTHOG_TOKEN,
    distinct_id: "anon",
    event: "survey sent",
    properties: {
      $survey_id: SURVEY_ID,
      $survey_response: message,
      $survey_completed: true,
      source: "cli",
    },
  };

  const result = await asyncTryCatch(async () => {
    const res = await fetch(POSTHOG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`PostHog returned ${String(res.status)}`);
    }
  });

  if (!result.ok) {
    console.error(pc.red("Failed to send feedback. Please try again later."));
    process.exit(1);
  }

  console.log(pc.green("Thanks for your feedback!"));
}

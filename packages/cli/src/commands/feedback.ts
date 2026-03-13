import pc from "picocolors";

const POSTHOG_TOKEN = "phc_7ToS2jDeWBlMu4n2JoNzoA1FnArdKwFMFoHVnAqQ6O1";
const POSTHOG_URL = "https://us.i.posthog.com/i/v0/e/";
const SURVEY_ID = "019ce45a-e03f-0000-e7d6-82dcf3a2de78";
const SURVEY_RESPONSE_KEY = "$survey_response_f17aba92-f824-4d4a-944b-4fecc9ac6903";

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
      [SURVEY_RESPONSE_KEY]: message,
      $survey_completed: true,
      source: "cli",
    },
  };

  try {
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

    console.log(pc.green("Thanks for your feedback!"));
  } catch {
    console.error(pc.red("Failed to send feedback. Please try again later."));
    process.exit(1);
  }
}

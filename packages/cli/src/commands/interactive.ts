import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import { getActiveServers } from "../history.js";
import { agentKeys } from "../manifest.js";
import { getAgentOptionalSteps } from "../shared/agents.js";
import { hasSavedOpenRouterKey } from "../shared/oauth.js";
import { asyncTryCatch, tryCatch, unwrapOr } from "../shared/result.js";
import { maybeShowStarPrompt } from "../shared/star-prompt.js";
import { captureEvent, setTelemetryContext } from "../shared/telemetry.js";
import { validateModelId } from "../shared/ui.js";
import { cmdLink } from "./link.js";
import { activeServerPicker } from "./list.js";
import { execScript, showDryRunPreview } from "./run.js";
import {
  buildAgentPickerHints,
  findClosestKeyByNameOrKey,
  getAuthHint,
  getImplementedClouds,
  handleCancel,
  loadManifestWithSpinner,
  mapToSelectOptions,
  preflightCredentialCheck,
  prioritizeCloudsByCredentials,
  resolveAgentKey,
  VERSION,
} from "./shared.js";

// Prompt user to select an agent with arrow-key navigation
async function selectAgent(manifest: Manifest): Promise<string> {
  const agents = agentKeys(manifest);
  const agentHints = buildAgentPickerHints(manifest);
  const agentChoice = await p.select({
    message: "Select an agent",
    options: mapToSelectOptions(agents, manifest.agents, agentHints),
    initialValue: agents.includes("openclaw") ? "openclaw" : agents[0],
  });
  if (p.isCancel(agentChoice)) {
    handleCancel();
  }
  return agentChoice;
}

// Validate that agent has available clouds and return sorted cloud list with priority hints
function getAndValidateCloudChoices(
  manifest: Manifest,
  agent: string,
): {
  clouds: string[];
  hintOverrides: Record<string, string>;
  credCount: number;
} {
  const clouds = getImplementedClouds(manifest, agent);

  if (clouds.length === 0) {
    p.log.error(`No clouds available for ${manifest.agents[agent].name}`);
    p.log.info("This agent has no implemented cloud providers yet.");
    p.log.info(`Run ${pc.cyan("spawn matrix")} to see the full availability matrix.`);
    process.exit(1);
  }

  const featuredCloud = manifest.agents[agent]?.featured_cloud;
  const { sortedClouds, hintOverrides, credCount, cliCount } = prioritizeCloudsByCredentials(
    clouds,
    manifest,
    featuredCloud,
  );
  if (credCount > 0) {
    p.log.info(`${credCount} cloud${credCount > 1 ? "s" : ""} with credentials detected (shown first)`);
  }
  if (cliCount > 0) {
    p.log.info(`${cliCount} cloud${cliCount > 1 ? "s" : ""} with CLI installed`);
  }

  return {
    clouds: sortedClouds,
    hintOverrides,
    credCount,
  };
}

// Prompt user to select a cloud with arrow-key navigation.
// When --beta sandbox is active and "local" is in the list, injects a
// "Local Machine (Sandboxed)" option right after "Local Machine".
async function selectCloud(
  manifest: Manifest,
  cloudList: string[],
  hintOverrides: Record<string, string>,
): Promise<string> {
  const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
  const sandboxEnabled = betaFeatures.includes("sandbox");

  const options = mapToSelectOptions(cloudList, manifest.clouds, hintOverrides);

  // Inject sandbox option next to "local" when --beta sandbox is set
  if (sandboxEnabled && cloudList.includes("local")) {
    const localIdx = options.findIndex((o) => o.value === "local");
    if (localIdx !== -1) {
      options[localIdx].hint = "No isolation — runs on your machine";
      options.splice(localIdx + 1, 0, {
        value: "local-sandbox",
        label: "Local Machine (Sandboxed)",
        hint: "Runs in a Docker container",
      });
    }
  }

  // Add "Link Existing Server" option at the bottom for BYOS workflow
  options.push({
    value: "link-existing",
    label: "Link Existing Server",
    hint: "bring your own server via IP address",
  });

  const cloudChoice = await p.select({
    message: "Select a cloud",
    options,
    initialValue: cloudList[0],
  });
  if (p.isCancel(cloudChoice)) {
    handleCancel();
  }

  // Map synthetic "local-sandbox" back to "local" and ensure sandbox beta is set
  if (cloudChoice === "local-sandbox") {
    const existing = process.env.SPAWN_BETA ?? "";
    if (!existing.split(",").includes("sandbox")) {
      process.env.SPAWN_BETA = existing ? `${existing},sandbox` : "sandbox";
    }
    return "local";
  }

  return cloudChoice;
}

// Prompt user to enter a display name for the spawn instance.
// Any string is allowed (spaces, uppercase, etc.) — the shell scripts
// derive a kebab-case slug for the actual cloud resource name.
async function promptSpawnName(): Promise<string | undefined> {
  // If SPAWN_NAME is set (e.g. via --name flag), use it without prompting
  if (process.env.SPAWN_NAME) {
    return process.env.SPAWN_NAME;
  }

  const suffix = Math.random().toString(36).slice(2, 6);
  const defaultName = `spawn-${suffix}`;
  const spawnName = await p.text({
    message: "Name your spawn",
    placeholder: defaultName,
    defaultValue: defaultName,
    validate: (value) => {
      if (!value) {
        return undefined;
      }
      if (value.length > 128) {
        return "Name must be 128 characters or less";
      }
      return undefined;
    },
  });
  if (p.isCancel(spawnName)) {
    handleCancel();
  }
  return spawnName || undefined;
}

/** Check whether the local host has a GitHub token (env or `gh auth`). */
function hasLocalGithubToken(): boolean {
  if (process.env.GITHUB_TOKEN) {
    return true;
  }
  return unwrapOr(
    tryCatch(
      () =>
        Bun.spawnSync(
          [
            "gh",
            "auth",
            "token",
          ],
          {
            stdio: [
              "ignore",
              "pipe",
              "ignore",
            ],
          },
        ).exitCode === 0,
    ),
    false,
  );
}

/**
 * Show a multiselect prompt for optional post-provision setup steps.
 * Returns a Set of enabled step values, or undefined if there are no steps.
 * On cancel, returns all steps enabled (safe default).
 */
async function promptSetupOptions(agentName: string): Promise<Set<string> | undefined> {
  const steps = getAgentOptionalSteps(agentName);

  // Filter GitHub option if no local token detected
  // Filter reuse-api-key option if no saved key exists
  const filteredSteps = steps
    .filter((s) => s.value !== "github" || hasLocalGithubToken())
    .filter((s) => s.value !== "reuse-api-key" || hasSavedOpenRouterKey());

  if (filteredSteps.length === 0) {
    return undefined;
  }

  const defaultOnValues = filteredSteps.filter((s) => s.defaultOn).map((s) => s.value);

  const selected = await p.multiselect({
    message: "Setup options (↑/↓ navigate, space=toggle, a=all, enter=confirm)",
    options: filteredSteps.map((s) => ({
      value: s.value,
      label: s.label,
      hint: s.hint,
    })),
    initialValues: defaultOnValues.length > 0 ? defaultOnValues : undefined,
    required: false,
  });

  if (p.isCancel(selected)) {
    return new Set<string>();
  }

  const stepSet = new Set(selected);

  // If user selected "Custom model", prompt for the model ID and set MODEL_ID env
  if (stepSet.has("custom-model")) {
    stepSet.delete("custom-model");
    const modelId = await p.text({
      message: "Model ID",
      placeholder: "provider/model-name",
      validate: (val) => {
        if (!val?.trim()) {
          return "Model ID is required";
        }
        if (!validateModelId(val.trim())) {
          return "Invalid format — use provider/model";
        }
        return undefined;
      },
    });
    if (!p.isCancel(modelId) && modelId.trim()) {
      process.env.MODEL_ID = modelId.trim();
    }
  }

  return stepSet;
}

/** Show the skills picker if --beta skills is active and the agent has skills available. */
async function maybePromptSkills(manifest: Manifest, agentName: string): Promise<void> {
  if (process.env.SPAWN_SELECTED_SKILLS) {
    return;
  }
  const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",").filter(Boolean);
  if (!betaFeatures.includes("skills")) {
    return;
  }
  const { promptSkillSelection, collectSkillEnvVars } = await import("../shared/skills.js");
  const selectedSkills = await promptSkillSelection(manifest, agentName);
  if (selectedSkills && selectedSkills.length > 0) {
    process.env.SPAWN_SELECTED_SKILLS = selectedSkills.join(",");
    const envPairs = await collectSkillEnvVars(manifest, selectedSkills);
    if (envPairs.length > 0) {
      const existing = process.env.SPAWN_SKILL_ENV_PAIRS ?? "";
      process.env.SPAWN_SKILL_ENV_PAIRS = existing ? `${existing},${envPairs.join(",")}` : envPairs.join(",");
    }
  }
}

export { getAndValidateCloudChoices, promptSetupOptions, promptSpawnName, selectCloud };

export async function cmdInteractive(): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  // Funnel entry — fires BEFORE any prompt so we catch users who bail at
  // the very first screen. See also: funnel_* events in orchestrate.ts.
  captureEvent("spawn_launched", {
    mode: "interactive",
  });

  // If the user has existing spawns, offer a top-level menu so they can
  // reconnect without knowing about `spawn list` or `spawn last`.
  const activeServers = getActiveServers();
  if (activeServers.length > 0) {
    captureEvent("menu_shown", {
      active_servers: activeServers.length,
    });
    const topChoice = await p.select({
      message: "What would you like to do?",
      options: [
        {
          value: "create",
          label: "Create a new server",
        },
        {
          value: "connect",
          label: "Connect to existing server",
        },
      ],
    });
    if (p.isCancel(topChoice)) {
      captureEvent("menu_cancelled");
      handleCancel();
    }
    captureEvent("menu_selected", {
      choice: String(topChoice),
    });
    if (topChoice === "connect") {
      const manifestResult = await asyncTryCatch(() => loadManifestWithSpinner());
      const manifest = manifestResult.ok ? manifestResult.data : null;
      await activeServerPicker(activeServers, manifest);
      return;
    }
  }

  const manifest = await loadManifestWithSpinner();
  captureEvent("agent_picker_shown");
  const agentChoice = await selectAgent(manifest);
  captureEvent("agent_selected", {
    agent: agentChoice,
  });
  setTelemetryContext("agent", agentChoice);

  const { clouds, hintOverrides } = getAndValidateCloudChoices(manifest, agentChoice);
  captureEvent("cloud_picker_shown");
  const cloudChoice = await selectCloud(manifest, clouds, hintOverrides);
  captureEvent("cloud_selected", {
    cloud: cloudChoice,
  });
  setTelemetryContext("cloud", cloudChoice);

  // Handle "Link Existing Server" — redirect to spawn link with the agent pre-selected
  if (cloudChoice === "link-existing") {
    p.outro("Switching to link mode...");
    await cmdLink([
      "link",
      "--agent",
      agentChoice,
    ]);
    return;
  }

  await preflightCredentialCheck(manifest, cloudChoice);
  captureEvent("preflight_passed");

  // Skip setup prompt if steps already set via --steps or --config
  if (!process.env.SPAWN_ENABLED_STEPS) {
    captureEvent("setup_options_shown");
    const enabledSteps = await promptSetupOptions(agentChoice);
    if (enabledSteps) {
      process.env.SPAWN_ENABLED_STEPS = [
        ...enabledSteps,
      ].join(",");
      captureEvent("setup_options_selected", {
        step_count: enabledSteps.size,
      });
    }
  }

  // Skills picker (--beta skills)
  await maybePromptSkills(manifest, agentChoice);

  captureEvent("name_prompt_shown");
  const spawnName = await promptSpawnName();
  // promptSpawnName cancels via handleCancel() on its own path if the user
  // bails; if we reach this line the name was entered successfully.
  captureEvent("name_entered");

  const agentName = manifest.agents[agentChoice].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${agentChoice} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");
  captureEvent("picker_completed");

  const success = await execScript(
    cloudChoice,
    agentChoice,
    undefined,
    getAuthHint(manifest, cloudChoice),
    manifest.clouds[cloudChoice].url,
    undefined,
    spawnName,
  );
  if (success) {
    maybeShowStarPrompt();
  }
}

/** Interactive cloud selection when agent is already known (e.g. `spawn claude`) */
export async function cmdAgentInteractive(agent: string, prompt?: string, dryRun?: boolean): Promise<void> {
  p.intro(pc.inverse(` spawn v${VERSION} `));

  // Same funnel entry as cmdInteractive — mode distinguishes the short-form
  // (`spawn claude`) entry point from the full interactive picker.
  captureEvent("spawn_launched", {
    mode: "agent_interactive",
  });

  const manifest = await loadManifestWithSpinner();
  const resolvedAgent = resolveAgentKey(manifest, agent);

  if (!resolvedAgent) {
    captureEvent("agent_invalid", {
      raw: agent,
    });
    const agentMatch = findClosestKeyByNameOrKey(agent, agentKeys(manifest), (k) => manifest.agents[k].name);
    p.log.error(`Unknown agent: ${pc.bold(agent)}`);
    if (agentMatch) {
      p.log.info(`Did you mean ${pc.cyan(agentMatch)} (${manifest.agents[agentMatch].name})?`);
    }
    p.log.info(`Run ${pc.cyan("spawn agents")} to see available agents.`);
    process.exit(1);
  }

  // Agent was pre-supplied on the command line — treat as implicitly selected.
  captureEvent("agent_selected", {
    agent: resolvedAgent,
  });
  setTelemetryContext("agent", resolvedAgent);

  const { clouds, hintOverrides } = getAndValidateCloudChoices(manifest, resolvedAgent);
  captureEvent("cloud_picker_shown");
  const cloudChoice = await selectCloud(manifest, clouds, hintOverrides);
  captureEvent("cloud_selected", {
    cloud: cloudChoice,
  });
  setTelemetryContext("cloud", cloudChoice);

  // Handle "Link Existing Server" — redirect to spawn link with the agent pre-selected
  if (cloudChoice === "link-existing") {
    p.outro("Switching to link mode...");
    await cmdLink([
      "link",
      "--agent",
      resolvedAgent,
    ]);
    return;
  }

  if (dryRun) {
    showDryRunPreview(manifest, resolvedAgent, cloudChoice, prompt);
    return;
  }

  await preflightCredentialCheck(manifest, cloudChoice);
  captureEvent("preflight_passed");

  // Skip setup prompt if steps already set via --steps or --config
  if (!process.env.SPAWN_ENABLED_STEPS) {
    captureEvent("setup_options_shown");
    const enabledSteps = await promptSetupOptions(resolvedAgent);
    if (enabledSteps) {
      process.env.SPAWN_ENABLED_STEPS = [
        ...enabledSteps,
      ].join(",");
      captureEvent("setup_options_selected", {
        step_count: enabledSteps.size,
      });
    }
  }

  captureEvent("name_prompt_shown");
  const spawnName = await promptSpawnName();
  captureEvent("name_entered");

  const agentName = manifest.agents[resolvedAgent].name;
  const cloudName = manifest.clouds[cloudChoice].name;
  p.log.step(`Launching ${pc.bold(agentName)} on ${pc.bold(cloudName)}`);
  p.log.info(`Next time, run directly: ${pc.cyan(`spawn ${resolvedAgent} ${cloudChoice}`)}`);
  p.outro("Handing off to spawn script...");
  captureEvent("picker_completed");

  const success = await execScript(
    cloudChoice,
    resolvedAgent,
    prompt,
    getAuthHint(manifest, cloudChoice),
    manifest.clouds[cloudChoice].url,
    undefined,
    spawnName,
  );
  if (success) {
    maybeShowStarPrompt();
  }
}

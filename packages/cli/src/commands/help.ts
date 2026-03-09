import pc from "picocolors";
import { REPO, SPAWN_CDN } from "../manifest.js";

function getHelpUsageSection(): string {
  return `${pc.bold("USAGE")}
  spawn                              Interactive agent + cloud picker
  spawn <agent> <cloud>              Launch agent on cloud directly
  spawn <agent> <cloud> --dry-run    Preview what would be provisioned (or -n)
  spawn <agent> <cloud> --zone <zone>  Set zone/region (works for all clouds)
  spawn <agent> <cloud> --size <type>  Set instance size/type (works for all clouds)
  spawn <agent> <cloud> --custom      Show interactive size/region pickers
  spawn <agent> <cloud> --headless   Provision and exit (no interactive session)
  spawn <agent> <cloud> --output json
                                     Headless mode with structured JSON on stdout
  spawn <agent> <cloud> --prompt "text"
                                     Execute agent with prompt (non-interactive)
  spawn <agent> <cloud> --prompt-file <file>  (or -f)
                                     Execute agent with prompt from file
  spawn <agent>                      Interactive cloud picker for agent
  spawn <cloud>                      Show available agents for cloud
  spawn list                         Browse and rerun previous spawns (aliases: ls, history)
  spawn list <filter>                Filter history by agent or cloud name
  spawn list -a <agent>              Filter spawn history by agent (or --agent)
  spawn list -c <cloud>              Filter spawn history by cloud (or --cloud)
  spawn list --clear                 Clear all spawn history
  spawn delete                       Delete a previously spawned server (aliases: rm, destroy, kill)
  spawn delete -a <agent>            Filter servers by agent
  spawn delete -c <cloud>            Filter servers by cloud
  spawn status                       Show live state of cloud servers (aliases: ps)
  spawn status -a <agent>            Filter status by agent (or --agent)
  spawn status -c <cloud>            Filter status by cloud (or --cloud)
  spawn status --prune               Remove gone servers from history
  spawn last                         Instantly rerun the most recent spawn (alias: rerun)
  spawn matrix                       Full availability matrix (alias: m)
  spawn agents                       List all agents with descriptions
  spawn clouds                       List all cloud providers
  spawn update                       Check for CLI updates
  spawn version                      Show version (or --version, -v)
  spawn help                         Show this help message (or --help, -h)`;
}

function getHelpExamplesSection(): string {
  return `${pc.bold("EXAMPLES")}
  spawn                              ${pc.dim("# Pick interactively")}
  spawn openclaw sprite              ${pc.dim("# Launch OpenClaw on Sprite")}
  spawn codex hetzner                ${pc.dim("# Launch Codex CLI on Hetzner Cloud")}
  spawn kilocode digitalocean        ${pc.dim("# Launch Kilo Code on DigitalOcean")}
  spawn claude sprite --prompt "Fix all linter errors"
                                     ${pc.dim("# Execute Claude with prompt and exit")}
  spawn codex sprite -p "Add tests"  ${pc.dim("# Short form of --prompt")}
  spawn openclaw aws -f instructions.txt
                                     ${pc.dim("# Read prompt from file (short for --prompt-file)")}
  spawn claude gcp --zone us-east1-b  ${pc.dim("# Use a specific GCP zone")}
  spawn claude gcp --size e2-standard-4
                                     ${pc.dim("# Use a specific machine type")}
  spawn opencode gcp --dry-run       ${pc.dim("# Preview without provisioning")}
  spawn claude hetzner --headless    ${pc.dim("# Provision, print connection info, exit")}
  spawn claude hetzner --output json ${pc.dim("# Structured JSON output on stdout")}
  spawn claude                       ${pc.dim("# Show which clouds support Claude")}
  spawn hetzner                      ${pc.dim("# Show which agents run on Hetzner")}
  spawn list                         ${pc.dim("# Browse history and pick one to rerun")}
  spawn list codex                   ${pc.dim("# Filter history by agent name")}
  spawn last                         ${pc.dim("# Instantly rerun the most recent spawn")}
  spawn matrix                       ${pc.dim("# See the full agent x cloud matrix")}`;
}

function getHelpAuthSection(): string {
  return `${pc.bold("AUTHENTICATION")}
  All agents use OpenRouter for LLM access. Get your API key at:
  ${pc.cyan("https://openrouter.ai/settings/keys")}

  For non-interactive use, set environment variables:
  ${pc.dim("OPENROUTER_API_KEY")}=sk-or-v1-... spawn claude sprite

  Each cloud provider has its own auth requirements.
  Run ${pc.cyan("spawn <cloud>")} to see setup instructions for a specific provider.`;
}

function getHelpInstallSection(): string {
  return `${pc.bold("INSTALL")}
  curl -fsSL ${SPAWN_CDN}/cli/install.sh | bash`;
}

function getHelpTroubleshootingSection(): string {
  return `${pc.bold("TROUBLESHOOTING")}
  ${pc.dim("*")} Script not found: Run ${pc.cyan("spawn matrix")} to verify the combination exists
  ${pc.dim("*")} Missing credentials: Run ${pc.cyan("spawn <cloud>")} to see setup instructions
  ${pc.dim("*")} Update issues: Try ${pc.cyan("spawn update")} or reinstall manually
  ${pc.dim("*")} Garbled unicode: Set ${pc.cyan("SPAWN_NO_UNICODE=1")} for ASCII-only output
  ${pc.dim("*")} Missing unicode over SSH: Set ${pc.cyan("SPAWN_UNICODE=1")} to force unicode on
  ${pc.dim("*")} Slow startup: Set ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")} to skip auto-update`;
}

function getHelpEnvVarsSection(): string {
  return `${pc.bold("ENVIRONMENT VARIABLES")}
  ${pc.cyan("OPENROUTER_API_KEY")}        OpenRouter API key (all agents require this)
  ${pc.cyan("SPAWN_NO_UPDATE_CHECK=1")}   Skip auto-update check on startup
  ${pc.cyan("SPAWN_NO_UNICODE=1")}        Force ASCII output (no unicode symbols)
  ${pc.cyan("SPAWN_UNICODE=1")}           Force Unicode output (override auto-detection)
  ${pc.cyan("SPAWN_HOME")}                Override spawn data directory (default: ~/.spawn)
  ${pc.cyan("SPAWN_DEBUG=1")}             Show debug output (unicode detection, etc.)
  ${pc.cyan("SPAWN_HEADLESS=1")}          Set automatically in --headless mode (for scripts)
  ${pc.cyan("SPAWN_CUSTOM=1")}           Set automatically in --custom mode (show size/region pickers)`;
}

function getHelpFooterSection(): string {
  return `${pc.bold("MORE INFO")}
  Repository:  https://github.com/${REPO}
  OpenRouter:  https://openrouter.ai`;
}

export function cmdHelp(): void {
  const sections = [
    "",
    `${pc.bold("spawn")} -- Launch any AI coding agent on any cloud`,
    "",
    getHelpUsageSection(),
    "",
    getHelpExamplesSection(),
    "",
    getHelpAuthSection(),
    "",
    getHelpInstallSection(),
    "",
    getHelpTroubleshootingSection(),
    "",
    getHelpEnvVarsSection(),
    "",
    getHelpFooterSection(),
  ];
  console.log(sections.join("\n"));
}

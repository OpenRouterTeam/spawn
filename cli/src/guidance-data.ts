/**
 * Guidance data structures for error and signal reporting.
 * Extracted from commands.ts to improve maintainability and reduce cognitive complexity.
 */

import pc from "picocolors";

export interface SignalEntry {
  header: string;
  causes: string[];
  includeDashboard: boolean;
}

export interface ExitCodeEntry {
  header: string;
  lines: string[];
  includeDashboard: boolean;
  specialHandling?: (cloud: string, authHint?: string, dashboardUrl?: string) => string[];
}

export function buildDashboardHint(dashboardUrl?: string): string {
  return dashboardUrl
    ? `  - Check your dashboard: ${pc.cyan(dashboardUrl)}`
    : "  - Check your cloud provider dashboard to stop or delete any unused servers";
}

// Note: Exit code 1 uses specialHandling because it needs credentialHints from commands.ts to avoid circular deps
export const EXIT_CODE_GUIDANCE: Record<number, ExitCodeEntry> = {
  130: {
    header: "Script was interrupted (Ctrl+C).",
    lines: ["Note: If a server was already created, it may still be running."],
    includeDashboard: true,
  },
  137: {
    header: "Script was killed (likely by the system due to timeout or out of memory).",
    lines: [
      "  - The server may not have enough RAM for this agent",
      "  - Try a larger instance size or a different cloud provider",
    ],
    includeDashboard: true,
  },
  255: {
    header: "SSH connection failed. Common causes:",
    lines: [
      "  - Server is still booting (wait a moment and retry)",
      "  - Firewall blocking SSH port 22",
      "  - Server was terminated before the session started",
    ],
    includeDashboard: false,
  },
  127: {
    header: "A required command was not found. Check that these are installed:",
    lines: ["  - bash, curl, ssh, jq"],
    includeDashboard: false,
    specialHandling: (cloud) => [`  - Cloud-specific CLI tools (run ${pc.cyan(`spawn ${cloud}`)} for details)`],
  },
  126: {
    header: "A command was found but could not be executed (permission denied).",
    lines: [
      "  - A downloaded binary may lack execute permissions",
      "  - The script may require root/sudo access",
      `  - Report it if this persists: ${pc.cyan(`https://github.com/OpenRouterTeam/spawn/issues`)}`,
    ],
    includeDashboard: false,
  },
  2: {
    header: "Shell syntax or argument error. This is likely a bug in the script.",
    lines: [`  Report it at: ${pc.cyan(`https://github.com/OpenRouterTeam/spawn/issues`)}`],
    includeDashboard: false,
  },
  1: {
    header: "Common causes:",
    lines: [],
    includeDashboard: true,
    // specialHandling is set in getScriptFailureGuidance in commands.ts
    // to avoid circular dependency with credentialHints
    specialHandling: () => [],
  },
};

export const SIGNAL_GUIDANCE: Record<string, SignalEntry> = {
  SIGKILL: {
    header: "Script was forcibly killed (SIGKILL). Common causes:",
    causes: [
      "  - Out of memory (OOM killer terminated the process)",
      "  - The server may not have enough RAM for this agent",
      "  - Try a larger instance size or a different cloud provider",
    ],
    includeDashboard: true,
  },
  SIGTERM: {
    header: "Script was terminated (SIGTERM). Common causes:",
    causes: [
      "  - The process was stopped by the system or a supervisor",
      "  - Server shutdown or reboot in progress",
      "  - Cloud provider terminated the instance (spot/preemptible instance or billing issue)",
    ],
    includeDashboard: true,
  },
  SIGINT: {
    header: "Script was interrupted (Ctrl+C).",
    causes: [
      "Note: If a server was already created, it may still be running.",
    ],
    includeDashboard: true,
  },
  SIGHUP: {
    header: "Script lost its terminal connection (SIGHUP). Common causes:",
    causes: [
      "  - SSH session disconnected or timed out",
      "  - Terminal window was closed during execution",
      "  - Try using a more stable connection or a terminal multiplexer (tmux/screen)",
    ],
    includeDashboard: false,
  },
};

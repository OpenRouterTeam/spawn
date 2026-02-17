import pc from "picocolors";

// ── Error Guidance Data Structures ────────────────────────────────────────────

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

export interface ErrorGuidance {
  causes: string[];
  steps: (ghUrl: string) => string[];
}

// ── Exit Code Guidance ────────────────────────────────────────────────────────
// Note: specialHandling functions are deferred to avoid circular dependencies

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
    // Note: specialHandling for exit code 1 is handled in getExitCodeGuidanceLines to avoid circular dependency
  },
};

// ── Signal Guidance ───────────────────────────────────────────────────────────

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

// ── Network Error Guidance ────────────────────────────────────────────────────

export const NETWORK_ERROR_GUIDANCE: Record<"timeout" | "connection" | "unknown", ErrorGuidance> = {
  timeout: {
    causes: [
      "  • Slow or unstable internet connection",
      "  • Download server not responding (possibly overloaded)",
      "  • Firewall blocking or slowing the connection",
    ],
    steps: (ghUrl) => [
      "  2. Verify combination exists: " + pc.cyan("spawn matrix"),
      "  3. Wait a moment and retry",
      "  4. Test URL directly: " + pc.dim(ghUrl),
    ],
  },
  connection: {
    causes: [
      "  • No internet connection",
      "  • Firewall or proxy blocking GitHub access",
      "  • DNS not resolving GitHub's domain",
    ],
    steps: () => [
      "  2. Test github.com access in your browser",
      "  3. Check firewall/VPN settings",
      "  4. Try disabling proxy temporarily",
    ],
  },
  unknown: {
    causes: [
      "  • Internet connection issue",
      "  • GitHub's servers temporarily down",
    ],
    steps: (ghUrl) => [
      "  2. Verify combination exists: " + pc.cyan("spawn matrix"),
      "  3. Wait a moment and retry",
      "  4. Test URL directly: " + pc.dim(ghUrl),
    ],
  },
};

// ── Helper Functions ──────────────────────────────────────────────────────────

export function buildDashboardHint(dashboardUrl?: string): string {
  return dashboardUrl
    ? `  - Check your dashboard: ${pc.cyan(dashboardUrl)}`
    : "  - Check your cloud provider dashboard to stop or delete any unused servers";
}

export function optionalDashboardLine(dashboardUrl?: string): string[] {
  return dashboardUrl ? [`  - Check your dashboard: ${pc.cyan(dashboardUrl)}`] : [];
}

export function getSignalGuidanceLines(signal: string, dashboardUrl?: string): string[] {
  const entry = SIGNAL_GUIDANCE[signal];
  if (entry) {
    const lines = [entry.header, ...entry.causes];
    if (entry.includeDashboard) lines.push(buildDashboardHint(dashboardUrl));
    return lines;
  }
  return [
    `Script was killed by signal ${signal}.`,
    "  - The process was terminated by the system or another process",
    buildDashboardHint(dashboardUrl),
  ];
}

// Type for credential hints function (imported from commands.ts)
type CredentialHintsFn = (cloud: string, authHint?: string, verb?: string) => string[];

let credentialHintsFn: CredentialHintsFn | null = null;

// Register credential hints function to avoid circular dependency
export function setCredentialHintsFn(fn: CredentialHintsFn): void {
  credentialHintsFn = fn;
}

export function getExitCodeGuidanceLines(exitCode: number | null, cloud: string, authHint?: string, dashboardUrl?: string): string[] {
  const entry = exitCode !== null ? EXIT_CODE_GUIDANCE[exitCode] : null;

  if (!entry) {
    // Default/unknown exit code
    const credentialsHints = credentialHintsFn ? credentialHintsFn(cloud, authHint, "Missing") : [];
    return [
      `${pc.bold("Common causes:")}`,
      ...credentialsHints,
      "  - Cloud provider API rate limit or quota exceeded",
      "  - Missing local dependencies (SSH, curl, jq)",
      ...optionalDashboardLine(dashboardUrl),
    ];
  }

  const lines = [pc.bold(entry.header), ...entry.lines];

  // Special handling for exit code 1: include credential hints
  if (exitCode === 1 && credentialHintsFn) {
    lines.push(...credentialHintsFn(cloud, authHint));
    lines.push("  - Cloud provider API error (quota, rate limit, or region issue)");
    lines.push("  - Server provisioning failed (try again or pick a different region)");
  } else if (entry.specialHandling) {
    // Apply special handling if defined for this exit code
    lines.push(...entry.specialHandling(cloud, authHint, dashboardUrl));
  }

  if (entry.includeDashboard) {
    lines.push(buildDashboardHint(dashboardUrl));
  }

  return lines;
}

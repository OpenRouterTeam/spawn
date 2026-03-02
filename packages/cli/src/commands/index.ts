// Barrel re-export — keeps all existing `import { ... } from "./commands.js"` working.

// shared.ts — helpers, entity resolution, fuzzy matching, credentials
export {
  getErrorMessage,
  loadManifestWithSpinner,
  getImplementedClouds,
  levenshtein,
  findClosestMatch,
  findClosestKeyByNameOrKey,
  resolveAgentKey,
  resolveCloudKey,
  checkEntity,
  hasCloudCli,
  prioritizeCloudsByCredentials,
  buildAgentPickerHints,
  formatCredStatusLine,
  preflightCredentialCheck,
  credentialHints,
  isInteractiveTTY,
  resolveDisplayName,
  buildRetryCommand,
  getStatusDescription,
  getImplementedAgents,
  parseAuthEnvVars,
  hasCloudCredentials,
} from "./shared.js";

// interactive.ts — cmdInteractive, cmdAgentInteractive
export { cmdInteractive, cmdAgentInteractive } from "./interactive.js";

// run.ts — cmdRun, cmdRunHeadless, script failure guidance
export type { HeadlessOptions } from "./run.js";
export {
  cmdRun,
  cmdRunHeadless,
  getSignalGuidance,
  getScriptFailureGuidance,
  isRetryableExitCode,
} from "./run.js";

// list.ts — cmdList, cmdLast, cmdListClear, history display
export {
  formatRelativeTime,
  buildRecordLabel,
  buildRecordSubtitle,
  cmdListClear,
  cmdList,
  cmdLast,
} from "./list.js";

// delete.ts — cmdDelete
export { cmdDelete } from "./delete.js";

// info.ts — cmdMatrix, cmdAgents, cmdClouds, cmdAgentInfo, cmdCloudInfo
export {
  getTerminalWidth,
  calculateColumnWidth,
  getMissingClouds,
  cmdMatrix,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdCloudInfo,
} from "./info.js";

// update.ts — cmdUpdate
export { cmdUpdate } from "./update.js";

// help.ts — cmdHelp
export { cmdHelp } from "./help.js";

// pick.ts — cmdPick
export { cmdPick } from "./pick.js";

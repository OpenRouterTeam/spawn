// Barrel re-export — keeps all existing `import { ... } from "./commands.js"` working.

// run.ts — cmdRun, cmdRunHeadless, script failure guidance
export type { HeadlessOptions } from "./run.js";

// delete.ts — cmdDelete
export { cmdDelete } from "./delete.js";
// help.ts — cmdHelp
export { cmdHelp } from "./help.js";
// info.ts — cmdMatrix, cmdAgents, cmdClouds, cmdAgentInfo, cmdCloudInfo
export {
  calculateColumnWidth,
  cmdAgentInfo,
  cmdAgents,
  cmdCloudInfo,
  cmdClouds,
  cmdMatrix,
  getMissingClouds,
  getTerminalWidth,
} from "./info.js";
// interactive.ts — cmdInteractive, cmdAgentInteractive
export { cmdAgentInteractive, cmdInteractive } from "./interactive.js";
// list.ts — cmdList, cmdLast, cmdListClear, history display
export {
  buildRecordLabel,
  buildRecordSubtitle,
  cmdLast,
  cmdList,
  cmdListClear,
  formatRelativeTime,
} from "./list.js";
// pick.ts — cmdPick
export { cmdPick } from "./pick.js";
export {
  cmdRun,
  cmdRunHeadless,
  getScriptFailureGuidance,
  getSignalGuidance,
  isRetryableExitCode,
} from "./run.js";
// shared.ts — helpers, entity resolution, fuzzy matching, credentials
export {
  buildAgentPickerHints,
  buildRetryCommand,
  checkEntity,
  credentialHints,
  findClosestKeyByNameOrKey,
  findClosestMatch,
  formatCredStatusLine,
  getErrorMessage,
  getImplementedAgents,
  getImplementedClouds,
  hasCloudCli,
  hasCloudCredentials,
  isInteractiveTTY,
  levenshtein,
  loadManifestWithSpinner,
  parseAuthEnvVars,
  preflightCredentialCheck,
  prioritizeCloudsByCredentials,
  resolveAgentKey,
  resolveCloudKey,
  resolveDisplayName,
} from "./shared.js";
// status.ts — cmdStatus
export { cmdStatus } from "./status.js";
// update.ts — cmdUpdate
export { cmdUpdate } from "./update.js";

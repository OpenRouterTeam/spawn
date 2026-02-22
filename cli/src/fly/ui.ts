// fly/lib/ui.ts — Re-exports from shared/ui.ts for backwards compatibility
export {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  selectFromList,
  openBrowser,
  jsonEscape,
  validateServerName,
  validateRegionName,
  validateModelId,
  toKebabCase,
} from "../shared/ui";

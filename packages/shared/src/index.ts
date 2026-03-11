export type { Result } from "./result";
export type { ValueOf } from "./type-guards";

export { parseJsonObj, parseJsonWith } from "./parse";
export {
  asyncTryCatch,
  asyncTryCatchIf,
  Err,
  isFileError,
  isNetworkError,
  isOperationalError,
  mapResult,
  Ok,
  tryCatch,
  tryCatchIf,
  unwrapOr,
} from "./result";
export { getErrorMessage, hasStatus, isNumber, isString, toObjectArray, toRecord } from "./type-guards";

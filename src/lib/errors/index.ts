export * from "./types";
export { ERROR_REGISTRY, getErrorDefinition, listCategories } from "./registry";
export { DuoSpaceError, createDuoSpaceError, APP_VERSION } from "./DuoSpaceError";
export { errorManager } from "./errorManager";
export { registerRecovery, hasRecovery, runRecovery, getRecoveryStats } from "./recovery";
export { useErrorManager, useErrorStream } from "./useErrorManager";

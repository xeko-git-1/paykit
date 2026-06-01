// @vibecc/paykit-cli — bin entry exposed via `npx paykit`.
// Library API (for testing + programmatic invocation):
export { runDoctor, type CheckResult, type CheckLevel } from "./lib/doctor.js";
export { loadEnv, type PaykitEnv } from "./lib/env-loader.js";
export type { MigrationEntry, MigrationManifest } from "./lib/manifest-types.js";
export {
  listStatus,
  migrateDown,
  migrateUp,
  type MigrationStatus,
} from "./lib/migration-runner.js";
export {
  createMerchant,
  mintKey,
  mintJwt,
  type MintKeyInput,
  type MintKeyResult,
  type MintJwtInput,
} from "./lib/bootstrap.js";

export const PAYKIT_CLI_VERSION = "0.1.0-alpha.1";

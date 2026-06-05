/**
 * Database client + transaction handle types.
 *
 * Paykit accepts a Drizzle node-postgres client. Repos use `DbOrTx` union so
 * any helper accepts both the top-level client and an in-progress transaction
 * handle (passed to callbacks of `db.transaction(tx => ...)`).
 */

import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.js";

export type DbClient = NodePgDatabase<typeof schema>;
export type DbTransactionHandle = NodePgTransaction<typeof schema, Record<string, never>>;
export type DbOrTx = DbClient | DbTransactionHandle;

/**
 * Read the paykit Postgres URL from an explicit flag or the environment.
 *
 * Resolution order (highest priority first):
 *   1. --db-url flag
 *   2. DATABASE_URL_PAYKIT   — explicit paykit DB in embedded/consumer repos,
 *                              where DATABASE_URL is the consumer app's own DB
 *   3. PAYKIT_DATABASE_URL   — legacy alias for (2)
 *   4. DATABASE_URL          — standalone service mode (Docker), where the only
 *                              database present IS paykit's own
 *
 * The paykit-specific names keep priority so an embedded consumer never points
 * paykit at its app DB by accident; DATABASE_URL is the convenient single var
 * for the standalone service/compose path.
 */
export interface PaykitEnv {
  readonly databaseUrl: string;
}

export function loadEnv(flagDbUrl?: string): PaykitEnv {
  const databaseUrl =
    flagDbUrl ??
    process.env.DATABASE_URL_PAYKIT ??
    process.env.PAYKIT_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.length === 0) {
    throw new Error(
      "No Postgres URL found. Provide --db-url, or set DATABASE_URL_PAYKIT (embedded) " +
        "or DATABASE_URL (standalone service).\n" +
        "Note: paykit requires its OWN Postgres database, separate from your app DB.",
    );
  }
  return { databaseUrl };
}

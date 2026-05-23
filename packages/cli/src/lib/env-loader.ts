/**
 * Read DATABASE_URL_PAYKIT from env or --db-url flag.
 *
 * Distinct from consumer's app DB — paykit owns its own Postgres database
 * (round-3 validation decision).
 */
export interface PaykitEnv {
  readonly databaseUrl: string;
}

export function loadEnv(flagDbUrl?: string): PaykitEnv {
  const databaseUrl =
    flagDbUrl ?? process.env.DATABASE_URL_PAYKIT ?? process.env.PAYKIT_DATABASE_URL;
  if (!databaseUrl || databaseUrl.length === 0) {
    throw new Error(
      "DATABASE_URL_PAYKIT is not set. Provide via env var or --db-url flag.\n" +
        "Note: paykit requires its OWN Postgres database, separate from your app DB.",
    );
  }
  return { databaseUrl };
}

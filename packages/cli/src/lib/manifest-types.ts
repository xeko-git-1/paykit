/**
 * Migration manifest types — mirrors migrations/manifest.json.
 */
export interface MigrationEntry {
  readonly id: string;
  readonly slug: string;
  readonly up: string;
  readonly down: string;
  readonly description: string;
}

export interface MigrationManifest {
  readonly schema: string;
  readonly advisoryLockKey: string;
  readonly migrations: readonly MigrationEntry[];
}

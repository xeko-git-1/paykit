/**
 * In-memory Drizzle-shaped DB for CLI bootstrap + merchant-repo unit tests.
 *
 * The server repos issue real Drizzle query-builder calls and are imported
 * (not injected), so a faithful-enough fake handle is the testable seam. Tables
 * are routed by Drizzle's public getTableName() — no reference fragility. The
 * fake ignores WHERE predicates (tests control state so only the relevant rows
 * exist) but honors insert/returning, count, and runtime_config upsert.
 */
import { getTableName } from "drizzle-orm";
import type { DbClient } from "@vibecc/paykit-server";

type Row = Record<string, unknown>;

export interface InMemoryStore {
  merchants: Row[];
  api_keys: Row[];
  runtime_config: Row[];
}

export function createInMemoryStore(seed: Partial<InMemoryStore> = {}): InMemoryStore {
  return {
    merchants: seed.merchants ?? [],
    api_keys: seed.api_keys ?? [],
    runtime_config: seed.runtime_config ?? [],
  };
}

function thenable<T>(value: T): T & PromiseLike<T> {
  const out = (Array.isArray(value) ? [...(value as unknown[])] : { ...(value as object) }) as T &
    PromiseLike<T>;
  (out as { then: PromiseLike<T>["then"] }).then = (resolve, reject) =>
    Promise.resolve(value).then(resolve, reject);
  return out;
}

export function createInMemoryDb(store: InMemoryStore): DbClient {
  const handle = {
    insert(table: unknown) {
      const tname = getTableName(table as never);
      return {
        values(rec: Row) {
          const build = (): Row => {
            if (tname === "merchants") {
              return {
                merchantId: crypto.randomUUID(),
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
                ...rec,
              };
            }
            if (tname === "api_keys") {
              return {
                keyId: crypto.randomUUID(),
                mode: "live",
                scopes: [],
                lastUsedAt: null,
                revokedAt: null,
                createdAt: new Date(),
                createdBy: null,
                ...rec,
              };
            }
            return { updatedAt: new Date(), expiresAt: null, ...rec };
          };
          return {
            returning() {
              const row = build();
              (store as Record<string, Row[]>)[tname]!.push(row);
              return thenable([row]);
            },
            onConflictDoUpdate() {
              // runtime_config upsert keyed by `key`
              const existing = store.runtime_config.find((r) => r.key === rec.key);
              if (existing) {
                Object.assign(existing, { value: rec.value, updatedAt: new Date() });
                return { returning: () => thenable([existing]) };
              }
              const row = build();
              store.runtime_config.push(row);
              return { returning: () => thenable([row]) };
            },
          };
        },
      };
    },

    select(fields?: unknown) {
      const isCount = fields !== undefined && typeof fields === "object" && fields !== null && "count" in (fields as object);
      return {
        from(table: unknown) {
          const tname = getTableName(table as never);
          const rows = (store as Record<string, Row[]>)[tname] ?? [];
          const resolveRows = () => {
            if (isCount) {
              const active = store.api_keys.filter((r) => r.revokedAt == null).length;
              return [{ count: active }];
            }
            return rows;
          };
          const builder = thenable(resolveRows()) as unknown as Row[] & {
            where: (c?: unknown) => unknown;
          };
          builder.where = () => {
            const afterWhere = thenable(resolveRows()) as unknown as Row[] & {
              limit: (n: number) => unknown;
            };
            afterWhere.limit = (n: number) => thenable(resolveRows().slice(0, n));
            return afterWhere;
          };
          return builder;
        },
      };
    },
  };

  return handle as unknown as DbClient;
}

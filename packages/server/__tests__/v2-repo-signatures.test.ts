import type { DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import * as customerRepo from "@xeko-git-1/paykit-auth-core/db/repos/customer.repo.js";
import * as idempotencyRepo from "@xeko-git-1/paykit-auth-core/db/repos/idempotency.repo.js";
import * as runtimeConfigRepo from "@xeko-git-1/paykit-auth-core/db/repos/runtime-config.repo.js";
import * as subscriptionEventRepo from "@xeko-git-1/paykit-auth-core/db/repos/subscription-event.repo.js";
import * as subscriptionRepo from "@xeko-git-1/paykit-auth-core/db/repos/subscription.repo.js";
/**
 * V2 repo signature tests — same pattern as V1/V1.5 repo-signatures.
 * Live DB tests live in Phase 10 testcontainer suite.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

describe("customerRepo public API (V2 Phase 02, Phase 04 source-of-truth)", () => {
  it("exposes lookup + lazy upsert + cascade-delete helpers", () => {
    expect(typeof customerRepo.findCustomer).toBe("function");
    expect(typeof customerRepo.findByProviderCustomerId).toBe("function");
    expect(typeof customerRepo.getOrInsertCustomer).toBe("function");
    expect(typeof customerRepo.deleteCustomerForCascade).toBe("function");
  });

  it("getOrInsertCustomer first arg accepts DbOrTx", () => {
    expectTypeOf(customerRepo.getOrInsertCustomer).parameter(0).toEqualTypeOf<DbOrTx>();
  });
});

describe("subscriptionRepo public API (RT F9 last-write-wins)", () => {
  it("exposes upsert + read + cancel helpers", () => {
    expect(typeof subscriptionRepo.upsertFromEvent).toBe("function");
    expect(typeof subscriptionRepo.findByProviderSub).toBe("function");
    expect(typeof subscriptionRepo.findById).toBe("function");
    expect(typeof subscriptionRepo.listForTenant).toBe("function");
    expect(typeof subscriptionRepo.listByCustomer).toBe("function");
    expect(typeof subscriptionRepo.markCanceled).toBe("function");
  });

  it("upsertFromEvent first arg accepts DbOrTx", () => {
    expectTypeOf(subscriptionRepo.upsertFromEvent).parameter(0).toEqualTypeOf<DbOrTx>();
  });
});

describe("subscriptionEventRepo public API (RT 15j append-only)", () => {
  it("exposes append + list ONLY (no update/delete by design)", () => {
    expect(typeof subscriptionEventRepo.appendSubscriptionEvent).toBe("function");
    expect(typeof subscriptionEventRepo.listEventsForSubscription).toBe("function");
    // Critical: append-only contract — these MUST NOT exist as helpers
    const exposed = Object.keys(subscriptionEventRepo);
    expect(exposed.some((k) => /update|delete|remove/i.test(k))).toBe(false);
  });
});

describe("idempotencyRepo public API (RT F6 tenant-scoped 24h replay)", () => {
  it("exposes claim + finalize + release + sweep helpers + body-mismatch error", () => {
    expect(typeof idempotencyRepo.claimIdempotency).toBe("function");
    expect(typeof idempotencyRepo.finalizeIdempotency).toBe("function");
    expect(typeof idempotencyRepo.releaseIdempotency).toBe("function");
    expect(typeof idempotencyRepo.sweepExpired).toBe("function");
    expect(typeof idempotencyRepo.IdempotencyBodyMismatchError).toBe("function");
  });

  it("IdempotencyBodyMismatchError is throwable Error", () => {
    const err = new idempotencyRepo.IdempotencyBodyMismatchError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IdempotencyBodyMismatchError");
  });
});

describe("runtimeConfigRepo public API (Val S4 Q3 canary auto-flip)", () => {
  it("exposes get + set + ensure helpers", () => {
    expect(typeof runtimeConfigRepo.getKey).toBe("function");
    expect(typeof runtimeConfigRepo.setKey).toBe("function");
    expect(typeof runtimeConfigRepo.ensureKey).toBe("function");
  });

  it("setKey first arg accepts DbOrTx", () => {
    expectTypeOf(runtimeConfigRepo.setKey).parameter(0).toEqualTypeOf<DbOrTx>();
  });
});

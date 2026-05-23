import { describe, expectTypeOf, it } from "vitest";
import type {
  AdminGuard,
  AdminGuardResult,
  AppliedDiscount,
  CurrencyCode,
  DbTransaction,
  DiscountResolver,
  ResolvedTenant,
  TenantResolver,
} from "../src/index.js";

describe("TenantResolver contract (compile-time)", () => {
  it("accepts sync resolver returning ResolvedTenant", () => {
    const sync: TenantResolver = (_req: unknown) => ({ tenantId: "t-1", ownerId: "o-1" });
    expectTypeOf(sync).toBeFunction();
  });

  it("accepts async resolver returning Promise<ResolvedTenant>", () => {
    const asyncResolver: TenantResolver = async (_req: unknown) => ({
      tenantId: "t-1",
      ownerId: "o-1",
    });
    expectTypeOf(asyncResolver).toBeFunction();
  });

  it("ResolvedTenant requires tenantId + ownerId both as string", () => {
    expectTypeOf<ResolvedTenant>().toEqualTypeOf<{
      readonly tenantId: string;
      readonly ownerId: string;
    }>();
  });
});

describe("DiscountResolver contract", () => {
  it("returns null OR AppliedDiscount with consume callback", () => {
    const noop: DiscountResolver = async (_req, _amount, _currency) => null;
    const withCode: DiscountResolver = async (_req, _amount, _currency) => ({
      percent: 10,
      code: "WELCOME",
      sourceId: "uuid-1",
      consume: async (_tx: DbTransaction) => true,
    });
    expectTypeOf(noop).toBeFunction();
    expectTypeOf(withCode).toBeFunction();
  });

  it("AppliedDiscount.consume returns Promise<boolean>", () => {
    expectTypeOf<AppliedDiscount["consume"]>().returns.resolves.toBeBoolean();
  });
});

describe("AdminGuard contract", () => {
  it("returns AdminGuardResult never raw boolean", () => {
    const guard: AdminGuard = async (_req) => ({ allowed: true, adminUserId: "u-1" });
    expectTypeOf(guard).toBeFunction();
  });

  it("AdminGuardResult.allowed is required, identity is optional", () => {
    expectTypeOf<AdminGuardResult>().toMatchTypeOf<{
      readonly allowed: boolean;
      readonly adminUserId?: string;
      readonly role?: string;
    }>();
  });
});

describe("CurrencyCode discriminated union", () => {
  it("only USD or VND", () => {
    expectTypeOf<CurrencyCode>().toEqualTypeOf<"USD" | "VND">();
  });
});

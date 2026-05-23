/**
 * Admin authorization hook. Returns identity context (not raw boolean) so
 * audit log can record `adminUserId` per mutation.
 *
 * Falsy `allowed` → 403. `adminUserId`/`role` are optional metadata.
 */

export interface AdminGuardResult {
  readonly allowed: boolean;
  readonly adminUserId?: string;
  readonly role?: string;
}

export type AdminGuard = (req: unknown) => AdminGuardResult | Promise<AdminGuardResult>;

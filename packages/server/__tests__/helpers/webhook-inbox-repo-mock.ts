/**
 * A `vi.mock` factory for the webhook inbox repo, shared by every test that drives
 * the real webhook router.
 *
 * Those tests exist to pin business behaviour — settlement amounts, refund
 * identity, discount reservations, screening handoff — and none of them are about
 * the inbox itself. But the router now records a delivery before processing it, so
 * every one of them has to stand in for that repo. Six hand-written copies of the
 * same eight stubs would mean that adding a repo function breaks six files in six
 * slightly different ways.
 *
 * The default behaviour is the happy path: the delivery is new, the claim succeeds,
 * and the row is in `processing` — which is the state `processDelivery` expects and
 * the state the guarded UPDATEs in the real repo would have produced. A test that
 * cares about a redelivery or a lost claim overrides the specific mock.
 */
import { vi } from "vitest";

/** Fixed so an assertion can name it without threading a value through. */
export const TEST_INBOX_ID = "b0000000-0000-4000-8000-00000000000a";

export interface InboxRowOverrides {
  readonly inboxId?: string;
  readonly provider?: string;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly providerRef?: string | null;
  readonly state?: string;
  readonly processingAttempts?: number;
  readonly normalizedPayload?: Record<string, unknown>;
}

/**
 * An inbox row as the repo would return it after a successful claim.
 *
 * `normalizedPayload` matters: `processDelivery` reads the event back from the row
 * rather than re-parsing the body, so a row without it is dead-lettered as
 * unreadable. Tests pass the same event their adapter returns.
 */
export function inboxRow(overrides: InboxRowOverrides = {}): Record<string, unknown> {
  const now = new Date();
  return {
    inboxId: overrides.inboxId ?? TEST_INBOX_ID,
    provider: overrides.provider ?? "test-provider",
    eventId: overrides.eventId ?? "evt-1",
    tenantId: null,
    matchedTransactionId: null,
    eventType: overrides.eventType ?? "payment.completed",
    providerRef: overrides.providerRef ?? "prov-ref-1",
    payloadHash: "hash",
    rawPayload: "{}",
    normalizedPayload: overrides.normalizedPayload ?? {},
    state: overrides.state ?? "processing",
    processingAttempts: overrides.processingAttempts ?? 1,
    nextRetryAt: now,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    lastErrorCode: null,
    lastErrorMessage: null,
    receivedAt: now,
    processedAt: null,
    updatedAt: now,
  };
}

/**
 * The complete export surface of the inbox repo, stubbed.
 *
 * Complete on purpose: `vi.mock` replaces the whole module, so a function left out
 * becomes `undefined` at the call site and surfaces as an unrelated TypeError deep
 * inside the router.
 */
export function inboxRepoMock(): Record<string, unknown> {
  // The claim must hand back the row that was recorded, not a fresh default. The
  // processor reads the provider, the reference and the event off that row to find
  // the payment, so a claim returning placeholder values would look up a provider
  // nothing was stored under — and every assertion about crediting would fail for a
  // reason that has nothing to do with what the test is pinning.
  let recorded: Record<string, unknown> = inboxRow();

  return {
    recordDelivery: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      const normalized = input?.normalizedPayload;
      recorded = inboxRow({
        state: "received",
        processingAttempts: 0,
        normalizedPayload:
          normalized !== null && typeof normalized === "object"
            ? (normalized as Record<string, unknown>)
            : {},
        ...(typeof input?.provider === "string" ? { provider: input.provider } : {}),
        ...(typeof input?.eventId === "string" ? { eventId: input.eventId } : {}),
        ...(typeof input?.eventType === "string" ? { eventType: input.eventType } : {}),
        ...(typeof input?.providerRef === "string" ? { providerRef: input.providerRef } : {}),
      });
      return { row: recorded, created: true, payloadMismatch: false };
    }),
    // A claim moves the row to `processing` and burns an attempt, exactly as the
    // guarded UPDATE in the real repo does.
    claimDeliveryById: vi.fn(async () => ({
      ...recorded,
      state: "processing",
      processingAttempts: (recorded.processingAttempts as number) + 1,
    })),
    claimNextDelivery: vi.fn(async () => undefined),
    markDeliveryProcessed: vi.fn(async () => inboxRow({ state: "processed" })),
    markDeliveryUnmatched: vi.fn(async () => inboxRow({ state: "unmatched" })),
    markDeliveryFailed: vi.fn(async () => inboxRow({ state: "failed" })),
    markDeliveryDeadLettered: vi.fn(async () => inboxRow({ state: "dead_letter" })),
    requeueDeadLetteredDelivery: vi.fn(async () => undefined),
    findDeliveryById: vi.fn(async () => undefined),
    findDeliveryByEvent: vi.fn(async () => undefined),
    listDeliveriesByState: vi.fn(async () => []),
    sweepInboxPayloads: vi.fn(async () => 0),
    countDeliveriesByState: vi.fn(async () => 0),
  };
}

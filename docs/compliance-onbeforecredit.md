# Compliance Screening (`onBeforeCredit` / `screeningService`)

Paykit lets you gate a payment on an OFAC/sanctions/AML verdict before the money reaches a wallet. This is opt-in: configure nothing and the credit path is unchanged.

Two config fields reach the same machinery:

| Field | Signature | Verdicts it can express |
|---|---|---|
| `onBeforeCredit` | `(evt: NormalizedWebhookEvent) => Promise<void>` | resolve = allow, throw = block |
| `screeningService` | `(req: ScreeningRequest) => Promise<ScreeningDecision>` | `clear` / `reject` / `manual_review`, plus throw = *no answer* |

`screeningService` takes precedence when both are set. Prefer it for new integrations — see [Why the hook is limited](#why-the-hook-is-limited).

## The transaction boundary

A screening call is an outbound HTTP request to a third party, so its latency is unbounded from paykit's point of view. It must not run inside the crediting transaction, because that transaction holds a `SELECT ... FOR UPDATE` lock on the payment row plus a pooled connection: a slow screening provider would pin both for the length of its request while every redelivery of the same webhook queues behind the lock. Under a small connection pool, one slow compliance vendor becomes a full outage.

So the work is split into three phases, with the network call between two short transactions and never inside one:

```
webhook tx │ settle amount → park payment in screening_pending → enqueue job → COMMIT
           │                                                     (row lock released)
  no tx    │ claim job → call screening service under a timeout
verdict tx │ credit or quarantine + record verdict → COMMIT
```

Correctness rests on the parked state being durable. If the process dies at any point, the payment is still `screening_pending` with a claimable job, so the work resumes. The single-transaction alternative is only "safe" while the process lives.

## Configuring it

```ts
import { createPaykit } from "@vibecc/paykit-server";
import type { ScreeningDecision, ScreeningRequest } from "@vibecc/paykit";
import { ScreeningUnavailableError } from "@vibecc/paykit";

const paykit = await createPaykit({
  db,
  providers: [stripeAdapter],
  screeningService: async (req: ScreeningRequest): Promise<ScreeningDecision> => {
    const res = await fetch("https://screening.example.com/v1/check", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SCREENING_TOKEN}` },
      body: JSON.stringify({
        reference: req.transactionId,
        amountMicros: req.amountMicros,
        currency: req.currencyCode,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    // A non-2xx is NOT a rejection — it means you do not know yet.
    if (!res.ok) {
      throw new ScreeningUnavailableError(`screening returned ${res.status}`);
    }

    const body = (await res.json()) as { status: string; reason?: string };
    if (body.status === "clear") return { verdict: "clear" };
    if (body.status === "hit") {
      return { verdict: "reject", reason: body.reason ?? "sanctions hit" };
    }
    return { verdict: "manual_review", reason: body.reason ?? "inconclusive" };
  },
});
```

`ScreeningRequest` carries `transactionId`, `tenantId`, `provider`, `amountMicros`, `currencyCode`, and `event` — the normalized provider event as captured when the payment arrived. Nothing else is passed, so a screening vendor never receives your provider credentials or signing secrets.

## Verdicts and where they lead

| Verdict | Payment status | Ledger | Discount reservation | Retried? |
|---|---|---|---|---|
| `clear` | `completed` | credit written | committed | — |
| `reject` | `quarantine` | untouched | released | no — the answer will not change |
| `manual_review` | `quarantine` | untouched | released | no — a human decides |
| *throws* | stays `screening_pending` | untouched | held | yes, with backoff |

A quarantined payment has money at the provider and none in the wallet. That is the intended outcome: the `screening_jobs` row carries the reason and decision time, which is the audit trail needed to later release or refund it by hand.

**Absence of an answer never reads as permission.** A screening service that times out or 5xxs does not clear the payment; the job is retried. After 6 inconclusive attempts the payment is quarantined as `manual_review` rather than retried forever or, worse, defaulted to credit.

## Retry schedule

Exponential backoff with full jitter, starting at 2s and capped at 15 minutes. The jitter is not cosmetic: a screening outage makes every queued job fail at once, and a fixed schedule would then retry them all in the same instant, repeatedly — the retry storm keeps the vendor down.

## Draining the queue

The webhook request path attempts the verdict once, immediately after its transaction commits. That keeps the common case (a vendor that answers promptly) about as fast as an inline call, without holding the row lock across it.

**A job that needs a retry has nothing else to pick it up.** Nothing in the request path will come back for it, so a deployment that configures screening must also drain the queue from a cron or worker tick:

```ts
import { drainScreeningJobs } from "@vibecc/paykit-server";

// Every minute, from your scheduler of choice.
await drainScreeningJobs({ db, screeningService, logger, events }, 50);
```

Pass the same `events` handlers you gave `createPaykit`. `payment.completed` fires from whichever path applies the verdict, so a drain without them credits the payment silently and your `onPaymentCompleted` consumer never runs for payments that screening held.

Without that tick, a payment whose first screening attempt was inconclusive stays parked in `screening_pending` indefinitely. The `paykit_screening_retry_total` metric going up while `paykit_credit_screened_total` stays flat is what that looks like.

Concurrent drains are safe: a job is claimed by a guarded `UPDATE ... RETURNING` under a lease, so two workers running the same statement produce one winner and one no-op. A worker that dies mid-call leaves a lease that expires and the job becomes claimable again.

## Metrics

| Metric | Meaning |
|---|---|
| `paykit_screening_pending_total` | payment parked, job enqueued |
| `paykit_credit_screened_total` | screening cleared, payment credited |
| `paykit_credit_blocked_total` | screening rejected, payment quarantined |
| `paykit_credit_manual_review_total` | verdict needs a human |
| `paykit_screening_retry_total` | inconclusive, retry scheduled |
| `paykit_screening_exhausted_total` | attempts exhausted, sent to manual review |

`paykit_credit_blocked_total` keeps the name it had when the hook ran inline, so existing dashboards and alerts survive the change.

## Why the hook is limited

`onBeforeCredit`'s protocol is "throw to block the credit", which conflates two outcomes the screening step has to tell apart: *this payment is not allowed* and *I could not find out*. Existing hooks throw for the first case only, so that is the meaning preserved: a throw maps to `reject` — quarantine, terminal, no retry, exactly the behaviour those hooks produce today.

A hook therefore cannot express "retry me later". If your screening vendor can be unavailable — and it can — supply a `screeningService` and throw `ScreeningUnavailableError` from it. Otherwise a vendor outage quarantines every payment that arrives during it, and each one needs manual release.

## Migrating from an inline hook

No config change is required and the observable outcomes are the same. What changed:

- The credit (or quarantine) can land a moment **after** the webhook is ACKed rather than before. Code that read the payment status immediately after a webhook response needs to tolerate `screening_pending`.
- `payment_transactions.status` gains `screening_pending`. Anything enumerating statuses — a dashboard filter, an admin view, a `CHECK` in your own schema — has to know about it.
- The `payment.completed` event still fires only on an actual credit, so downstream consumers do not see a payment that screening later rejected.
- You must wire the drain tick described above.

Applied by migration `021_screening_jobs`.

## Data handling

The screening request contains payment metadata, not credentials: no API secrets, no authorization headers, no card data, no provider signing secrets. The `screening_jobs.event_json` column stores the normalized event so a reviewer can see what was judged and the worker does not have to re-parse a provider payload — apply your own redaction before persisting anything sensitive in adapter metadata, since that is what lands there.

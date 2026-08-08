/**
 * Retry policy for the webhook inbox.
 *
 * Separate from the processor so the numbers are readable in one place and can be
 * asserted directly by a test, rather than being reverse-engineered from a backoff
 * call buried in an error path.
 *
 * The values differ from the screening queue's on purpose. An unmatched webhook is
 * usually waiting on a checkout that is milliseconds away from committing its
 * provider reference, so the first retries are quick. But the outer bound has to
 * cover a real incident — a provider that races us consistently, or a deploy that
 * left checkouts wedged — so the cap is long and the attempt count is generous.
 * Giving up early on a webhook means giving up on a payment the customer has
 * already made.
 */

/** Delay ceiling for the first retry. */
export const INBOX_BASE_RETRY_MS = 1_000;

/** Ceiling for the backoff, so late attempts settle into a steady poll. */
export const INBOX_MAX_RETRY_MS = 10 * 60_000;

/**
 * Attempts before a delivery is dead-lettered.
 *
 * With the schedule above, twelve attempts span hours rather than minutes: long
 * enough that a delivery only dies when something is genuinely wrong, not because a
 * checkout took an unusual amount of time to commit.
 */
export const INBOX_MAX_ATTEMPTS = 12;

/**
 * How long a claim is held before another worker may take the delivery.
 *
 * Must exceed the processing transaction's own worst case, or a slow-but-healthy
 * attempt has its lease stolen while still running and the work runs twice. The
 * ledger's uniqueness makes that safe rather than catastrophic, but it still burns
 * an attempt and doubles the load.
 */
export const INBOX_LEASE_MS = 60_000;

/**
 * How long a settled delivery keeps its stored body.
 *
 * Long enough to investigate an incident from last week, short enough that the
 * table does not grow without bound and that a redacted-but-still-sensitive payload
 * is not kept forever. Dropping the body keeps the row: the dedup key and the audit
 * trail are what must last.
 */
export const INBOX_PAYLOAD_RETENTION_DAYS = 30;

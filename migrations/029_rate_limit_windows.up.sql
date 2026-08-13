-- A rate-limit counter every instance can see.
--
-- The v1 rate limiter is an in-memory token bucket, which is honest about its
-- own limits ("soft, per-process") but quietly wrong once the service runs
-- behind a load balancer: N replicas each grant the full budget, so the
-- effective limit is N times what the operator configured, and it resets on
-- every deploy. A limit that scales with replica count is not a limit, it is a
-- suggestion.
--
-- One row per credential, holding the current fixed window and its request
-- count. The middleware upserts: same window -> increment, new window -> reset
-- to 1. Both arms are a single guarded statement, so concurrent requests
-- across instances serialize on the row and the count is exact.
--
-- Fixed window rather than a token bucket because the bucket's refill
-- arithmetic needs read-modify-write of two fields (tokens, last_refill),
-- which cannot be one atomic UPSERT without moving the arithmetic into SQL —
-- and the boundary-burst weakness of fixed windows (2x budget straddling a
-- window edge) is acceptable for an API throttle that exists to stop runaway
-- clients, not to meter billing.
--
-- The table stays one row per credential forever: each new window overwrites
-- the previous one in place, so there is nothing to clean up and no growth to
-- monitor.

CREATE TABLE IF NOT EXISTS paykit.rate_limit_windows (
  -- The credential identity the limit applies to: api-key id, or the
  -- namespaced `jwt:<merchantId>` the jwt plane synthesizes. Same key the
  -- in-memory limiter used, so the two implementations throttle identically.
  bucket_key TEXT PRIMARY KEY,

  -- Start of the fixed window this count belongs to. A request arriving in a
  -- later window resets the count rather than adding to a stale one.
  window_start TIMESTAMPTZ NOT NULL,

  -- Requests observed in this window, including rejected ones: a client
  -- hammering past the limit keeps the window saturated instead of being let
  -- back in the moment the count would have decayed.
  request_count INTEGER NOT NULL DEFAULT 0
);

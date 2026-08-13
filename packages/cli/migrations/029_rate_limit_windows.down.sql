-- Drop the durable rate-limit counters.
--
-- Rolling back loses the current window counts, so every credential starts a
-- fresh window on the next request. That is the same amnesty a deploy already
-- grants the in-memory limiter — momentarily generous, never unsafe. The
-- middleware falls back to its per-process bucket when the table is gone.

DROP TABLE IF EXISTS paykit.rate_limit_windows;

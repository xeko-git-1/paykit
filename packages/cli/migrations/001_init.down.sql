-- Paykit V1 — rollback initial schema.
-- WARNING: drops the entire paykit schema. Use only in dev/test.

DROP TABLE IF EXISTS paykit.reconciliation_runs;
DROP TABLE IF EXISTS paykit.webhook_events;
DROP TABLE IF EXISTS paykit.balance_projections;
DROP TABLE IF EXISTS paykit.ledger_entries;
DROP TABLE IF EXISTS paykit.payment_transactions;
DROP SCHEMA IF EXISTS paykit;

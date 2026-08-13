-- Rollback 030: drop the per-tenant currency preference table. Checkouts fall
-- back to explicit currency / legacy amount fields; no money data is touched.

DROP TABLE IF EXISTS paykit.tenant_currency_preferences;

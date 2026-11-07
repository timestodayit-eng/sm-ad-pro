-- 0005_lead_call_counts: leads, calls and messages as their own columns, and cost alert limits.

ALTER TABLE meta_insights_daily
  ADD COLUMN leads BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN messages BIGINT UNSIGNED NOT NULL DEFAULT 0;

-- Rows synced before this column existed have zeros; the next sync re-fetches the full 30 days to fill them in.
UPDATE meta_ad_accounts SET live_full_synced_at = NULL;

-- Cost alerts. One row for the default limits of each currency, and one row per account that overrides them.
-- Default row: NULL or 0 means "no alert". Account row: NULL means "use the default", 0 means "off for this account".
CREATE TABLE cost_alert_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  scope_key VARCHAR(64) NOT NULL,
  ad_account_row_id BIGINT UNSIGNED NULL,
  currency CHAR(3) NOT NULL,
  daily_spend_limit DECIMAL(18,4) NULL,
  max_cost_per_lead DECIMAL(18,4) NULL,
  max_cost_per_call DECIMAL(18,4) NULL,
  max_cost_per_message DECIMAL(18,4) NULL,
  max_cost_per_result DECIMAL(18,4) NULL,
  min_spend DECIMAL(18,4) NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cost_alert_scope (org_id, scope_key),
  CONSTRAINT fk_cost_alert_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

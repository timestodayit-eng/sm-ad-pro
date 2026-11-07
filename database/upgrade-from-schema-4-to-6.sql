-- =====================================================================================
-- Ads Command Center 0.4.2 : UPGRADE database from schema version 4 to 6
--
-- Use this ONLY on a database that is at schema version 4. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be 4.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the 0.4.2 files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: 0005_lead_call_counts, 0006_dashboard_prefs
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------- 0005_lead_call_counts
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

-- ---------------------------------------------------------------- 0006_dashboard_prefs
-- 0006_dashboard_prefs: one shared account order for the whole panel, per-user layout choices
-- (columns, sort), and 90 days of daily history.

ALTER TABLE meta_ad_accounts ADD COLUMN display_order INT NULL AFTER is_managed;

CREATE TABLE user_preferences (
  user_id BIGINT UNSIGNED NOT NULL,
  pref_key VARCHAR(64) NOT NULL,
  value JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, pref_key),
  CONSTRAINT fk_user_preferences_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The live sync now keeps 90 days instead of 30; the next sync of each account fetches the older days.
UPDATE meta_ad_accounts SET live_full_synced_at = NULL;

-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
  (5, '0005_lead_call_counts', 'ec6935a177b44b1b895cade7e894adfc0ec2456997932c65ae8d86817cb26af2', 'applied', 'upgrade-sql'),
  (6, '0006_dashboard_prefs', 'b8846a758b6fc363458a2e054f798dff9f0e564f12a9df35e3456bd7e0a654b7', 'applied', 'upgrade-sql');

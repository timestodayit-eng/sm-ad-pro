-- =====================================================================================
-- Ads Command Center 0.10.3 : UPGRADE database from schema version 5 to 12
--
-- Use this ONLY on a database that is at schema version 5. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be 5.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the 0.10.3 files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: 0006_dashboard_prefs, 0007_budget_changes, 0008_account_funds, 0009_launches, 0010_ai, 0011_modules, 0012_launch_ads
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

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

-- ---------------------------------------------------------------- 0007_budget_changes
-- 0007_budget_changes: every ad set budget change the panel makes on Meta, with what Meta reported back.

CREATE TABLE budget_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  batch_id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  adset_id VARCHAR(32) NOT NULL,
  adset_name VARCHAR(512) NULL,
  position INT NOT NULL,
  currency CHAR(3) NOT NULL,
  old_daily_budget_minor BIGINT NULL,
  new_daily_budget_minor BIGINT NOT NULL,
  confirmed_daily_budget_minor BIGINT NULL,
  status VARCHAR(16) NOT NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_budget_changes_org (org_id, created_at),
  KEY idx_budget_changes_batch (batch_id),
  CONSTRAINT fk_budget_changes_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- 0008_account_funds
-- 0008_account_funds: money left in each ad account (prepaid funds, amount owed, spending limit), read on every
-- live sync, and a low-balance alert measured in days of spend left.

ALTER TABLE meta_ad_accounts
  ADD COLUMN balance_minor BIGINT NULL AFTER spend_cap_minor,
  ADD COLUMN is_prepay TINYINT(1) NULL AFTER balance_minor,
  ADD COLUMN funding_type INT NULL AFTER is_prepay,
  ADD COLUMN funding_display VARCHAR(255) NULL AFTER funding_type,
  ADD COLUMN prepaid_funds_minor BIGINT NULL AFTER funding_display,
  ADD COLUMN funds_checked_at DATETIME(3) NULL AFTER prepaid_funds_minor,
  ADD COLUMN funds_error VARCHAR(500) NULL AFTER funds_checked_at;

ALTER TABLE cost_alert_settings ADD COLUMN min_days_left DECIMAL(8,2) NULL AFTER max_cost_per_result;

-- ---------------------------------------------------------------- 0009_launches
-- 0009_launches: Easy Ads. One launch = one ad sent to several ad accounts in the panel's account order.
-- Each account gets its own campaign, ad set and ad, all created PAUSED. Every Meta ID is stored as soon as Meta
-- returns it, so a retry continues where it stopped instead of creating duplicates.

CREATE TABLE launches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  name VARCHAR(190) NOT NULL,
  goal VARCHAR(16) NOT NULL,
  settings JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_launches_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE launch_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  launch_id BIGINT UNSIGNED NOT NULL,
  org_id BIGINT UNSIGNED NOT NULL,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  position INT NOT NULL,
  page_id VARCHAR(32) NOT NULL,
  currency CHAR(3) NOT NULL,
  -- lifetime (between the launch's start and end dates) or daily
  budget_kind VARCHAR(8) NOT NULL DEFAULT 'lifetime',
  budget_minor BIGINT NOT NULL,
  media_asset_id BIGINT UNSIGNED NOT NULL,
  -- what this account's ad says: caption, title, call/website link and button (rows from an uploaded sheet can differ)
  content JSON NOT NULL,
  -- queued -> working -> done | failed | needs_review | cancelled
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  -- the next thing to do: video, processing, campaign, adset, creative, ad, check, done
  stage VARCHAR(16) NOT NULL DEFAULT 'video',
  video_id VARCHAR(32) NULL,
  thumbnail_url VARCHAR(2048) NULL,
  campaign_id VARCHAR(32) NULL,
  adset_id VARCHAR(32) NULL,
  creative_id VARCHAR(32) NULL,
  ad_id VARCHAR(32) NULL,
  ad_status VARCHAR(32) NULL,
  job_id BIGINT UNSIGNED NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  error_hint VARCHAR(500) NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_launch_item (launch_id, ad_account_row_id),
  KEY idx_launch_items_status (org_id, status),
  CONSTRAINT fk_launch_items_launch FOREIGN KEY (launch_id) REFERENCES launches(id) ON DELETE CASCADE,
  CONSTRAINT fk_launch_items_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A video uploaded to an ad account once is reused by later launches in that account.
CREATE TABLE meta_video_uploads (
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  media_asset_id BIGINT UNSIGNED NOT NULL,
  video_id VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ad_account_row_id, media_asset_id),
  CONSTRAINT fk_video_uploads_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- 0010_ai
-- 0010_ai: AI Copilot conversations and AI Documents (versioned, section-based reports).
-- AI Analytics findings are computed from synced data on request and are not stored.

CREATE TABLE ai_conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_ai_conv_user (org_id, user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  -- user | assistant | tool
  role VARCHAR(12) NOT NULL,
  content MEDIUMTEXT NULL,
  -- assistant: the tool calls it asked for; tool: the call it answers
  tool_calls JSON NULL,
  tool_call_id VARCHAR(64) NULL,
  tool_name VARCHAR(64) NULL,
  -- a change the assistant proposed (for example a budget plan); applied only through the normal confirm flow
  proposal JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ai_msg_conv (conversation_id, id),
  CONSTRAINT fk_ai_msg_conv FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  title VARCHAR(190) NOT NULL,
  -- performance (more kinds later)
  kind VARCHAR(32) NOT NULL,
  params JSON NOT NULL,
  current_version INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_ai_docs_org (org_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_document_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  version INT NOT NULL,
  sections JSON NOT NULL,
  note VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ai_doc_version (document_id, version),
  CONSTRAINT fk_ai_docver_doc FOREIGN KEY (document_id) REFERENCES ai_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- 0011_modules
-- 0011_modules: Audience Manager, Placements, Custom Reports, Finance, Monitoring and Comments.

CREATE TABLE saved_audiences (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  special_category VARCHAR(24) NOT NULL DEFAULT 'NONE',
  spec JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_saved_audience (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE saved_placements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  placements JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_saved_placements (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE report_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  config JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_report_template (org_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One stated, dated exchange rate per currency, typed in by the team (the panel never guesses a rate).
CREATE TABLE finance_rates (
  org_id BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL,
  rate_to_bdt DECIMAL(18,6) NOT NULL,
  as_of DATE NOT NULL,
  note VARCHAR(255) NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (org_id, currency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Money put into an account (top-ups) or other entries, logged by hand: Meta does not report payments.
CREATE TABLE finance_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  on_date DATE NOT NULL,
  note VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_finance_entries (org_id, on_date),
  CONSTRAINT fk_finance_entry_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_settings (
  org_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  min_severity VARCHAR(16) NOT NULL DEFAULT 'warning',
  kinds JSON NULL,
  stale_sync_minutes INT UNSIGNED NOT NULL DEFAULT 120,
  token_days_warning INT UNSIGNED NOT NULL DEFAULT 7,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  accounts INT UNSIGNED NOT NULL DEFAULT 0,
  findings INT UNSIGNED NOT NULL DEFAULT 0,
  alerts INT UNSIGNED NOT NULL DEFAULT 0,
  summary JSON NULL,
  error VARCHAR(1000) NULL,
  KEY idx_monitor_runs (org_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE comment_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  page_id VARCHAR(32) NOT NULL,
  comment_id VARCHAR(64) NOT NULL,
  action VARCHAR(16) NOT NULL,
  text TEXT NULL,
  result_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_comment_actions (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO recurring_schedules (name, queue, type, interval_seconds) VALUES
  ('monitor_scan', 'sync', 'monitor.scan', 1800);

-- ---------------------------------------------------------------- 0012_launch_ads
-- 0012_launch_ads: several ads (one per video) in one campaign. Each launch item (one account) still gets one
-- campaign and one ad set; every row here is one ad inside that ad set. Meta IDs are stored as soon as Meta
-- returns them, so a retry continues where it stopped instead of creating duplicates. Launch items created
-- before this version have no rows here; the job adds the single ad from the item itself when it runs.

CREATE TABLE launch_item_ads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  launch_item_id BIGINT UNSIGNED NOT NULL,
  position INT NOT NULL,
  media_asset_id BIGINT UNSIGNED NOT NULL,
  caption TEXT NULL,
  title VARCHAR(255) NULL,
  video_id VARCHAR(32) NULL,
  thumbnail_url VARCHAR(2048) NULL,
  creative_id VARCHAR(32) NULL,
  ad_id VARCHAR(32) NULL,
  ad_status VARCHAR(32) NULL,
  warning VARCHAR(500) NULL,
  UNIQUE KEY uq_launch_item_ad (launch_item_id, position),
  CONSTRAINT fk_launch_item_ads_item FOREIGN KEY (launch_item_id) REFERENCES launch_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
  (6, '0006_dashboard_prefs', 'b8846a758b6fc363458a2e054f798dff9f0e564f12a9df35e3456bd7e0a654b7', 'applied', 'upgrade-sql'),
  (7, '0007_budget_changes', '7ef76bbd233f7c232a4217e345c2cc19e131a5dd4e77ff0adc03d68d956dd900', 'applied', 'upgrade-sql'),
  (8, '0008_account_funds', '73c0bb4d0f513ff177660d25fd9ee6322807fa97c8b6380158d24cc506ec9f26', 'applied', 'upgrade-sql'),
  (9, '0009_launches', 'b90814e072bc0614fc9be6652cf65cd419dee9384ab2e5bce200a52c0e719c3b', 'applied', 'upgrade-sql'),
  (10, '0010_ai', '34b20c7733cc57b2dc305a03485ccad94577d63d31203fbe9f6fb48820932bb4', 'applied', 'upgrade-sql'),
  (11, '0011_modules', '24f1d70bcd1868e427456b72abdb1d4d9452bd146985e540e650b2fed16a6605', 'applied', 'upgrade-sql'),
  (12, '0012_launch_ads', 'ee043359a2e038f8ae94d859b6ca7a42ffb2f503e4e036131166e572e2a159e6', 'applied', 'upgrade-sql');

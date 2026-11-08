-- =====================================================================================
-- Ads Command Center 0.9.0 : UPGRADE database from schema version 1 to 11
--
-- Use this ONLY on a database that is at schema version 1. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be 1.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the 0.9.0 files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: 0002_media, 0003_two_factor, 0004_live_reporting, 0005_lead_call_counts, 0006_dashboard_prefs, 0007_budget_changes, 0008_account_funds, 0009_launches, 0010_ai, 0011_modules
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------- 0002_media
-- 0002_media: media library (direct-to-R2 multipart uploads).

CREATE TABLE media_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NULL,
  kind VARCHAR(8) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  -- uploading -> ready | failed | aborted ; ready -> deleted
  status VARCHAR(16) NOT NULL DEFAULT 'uploading',
  upload_id VARCHAR(1024) NULL,
  part_size INT UNSIGNED NOT NULL,
  part_count INT UNSIGNED NOT NULL,
  fingerprint VARCHAR(64) NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  duration_ms INT UNSIGNED NULL,
  thumbnail_key VARCHAR(512) NULL,
  last_error TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_media_object (object_key),
  KEY idx_media_org_status (org_id, status, id),
  KEY idx_media_fingerprint (org_id, fingerprint, status),
  CONSTRAINT fk_media_org FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- R2 drops unfinished multipart uploads after 7 days; abort ours at 6 so the library never lists ghosts.
INSERT INTO recurring_schedules (name, queue, type, interval_seconds) VALUES
  ('media_stale_uploads', 'maintenance', 'media.abort_stale_uploads', 21600);

-- ---------------------------------------------------------------- 0003_two_factor
-- 0003_two_factor: TOTP two-step login with recovery codes.

ALTER TABLE users
  ADD COLUMN totp_secret_enc TEXT NULL,
  ADD COLUMN totp_pending_enc TEXT NULL,
  ADD COLUMN totp_enabled_at DATETIME(3) NULL,
  ADD COLUMN totp_last_step BIGINT UNSIGNED NULL,
  ADD COLUMN recovery_codes JSON NULL;

-- Password accepted, code not yet entered. Short-lived, single use, limited attempts.
CREATE TABLE login_challenges (
  id CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_login_challenges_user (user_id),
  CONSTRAINT fk_login_challenges_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- 0004_live_reporting
-- 0004_live_reporting: choose which ad accounts the panel manages, and keep their campaigns, ads and daily results in sync.

ALTER TABLE meta_ad_accounts
  ADD COLUMN is_managed TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN live_synced_at DATETIME(3) NULL,
  ADD COLUMN live_full_synced_at DATETIME(3) NULL,
  ADD COLUMN live_sync_error VARCHAR(1024) NULL,
  ADD KEY idx_ad_account_managed (org_id, is_managed);

CREATE TABLE meta_campaigns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  campaign_id VARCHAR(32) NOT NULL,
  name VARCHAR(512) NOT NULL,
  status VARCHAR(32) NULL,
  effective_status VARCHAR(32) NULL,
  objective VARCHAR(64) NULL,
  daily_budget_minor BIGINT NULL,
  lifetime_budget_minor BIGINT NULL,
  synced_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_campaign (ad_account_row_id, campaign_id),
  CONSTRAINT fk_campaign_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meta_adsets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  adset_id VARCHAR(32) NOT NULL,
  campaign_id VARCHAR(32) NOT NULL,
  name VARCHAR(512) NOT NULL,
  status VARCHAR(32) NULL,
  effective_status VARCHAR(32) NULL,
  daily_budget_minor BIGINT NULL,
  lifetime_budget_minor BIGINT NULL,
  optimization_goal VARCHAR(64) NULL,
  synced_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_adset (ad_account_row_id, adset_id),
  KEY idx_adset_campaign (campaign_id),
  CONSTRAINT fk_adset_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meta_ads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  ad_id VARCHAR(32) NOT NULL,
  adset_id VARCHAR(32) NOT NULL,
  campaign_id VARCHAR(32) NOT NULL,
  name VARCHAR(512) NOT NULL,
  status VARCHAR(32) NULL,
  effective_status VARCHAR(32) NULL,
  creative_id VARCHAR(32) NULL,
  thumbnail_url VARCHAR(2048) NULL,
  title VARCHAR(512) NULL,
  body TEXT NULL,
  synced_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_ad (ad_account_row_id, ad_id),
  KEY idx_ad_campaign (campaign_id),
  CONSTRAINT fk_ad_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per object per day, in the ad account's own time zone, exactly as Meta reports it.
-- Reach is not stored: it cannot be added across days.
CREATE TABLE meta_insights_daily (
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  level VARCHAR(8) NOT NULL,
  object_id VARCHAR(32) NOT NULL,
  date DATE NOT NULL,
  objective VARCHAR(64) NULL,
  spend DECIMAL(18,4) NOT NULL DEFAULT 0,
  impressions BIGINT UNSIGNED NOT NULL DEFAULT 0,
  clicks BIGINT UNSIGNED NOT NULL DEFAULT 0,
  link_clicks BIGINT UNSIGNED NOT NULL DEFAULT 0,
  result_type VARCHAR(96) NULL,
  results BIGINT UNSIGNED NULL,
  actions JSON NULL,
  synced_at DATETIME(3) NOT NULL,
  PRIMARY KEY (level, object_id, date),
  KEY idx_insights_account (ad_account_row_id, level, date),
  CONSTRAINT fk_insights_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO recurring_schedules (name, queue, type, interval_seconds) VALUES
  ('meta_live_sync', 'sync', 'meta.sync_live', 900);

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

-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
  (2, '0002_media', '69eee0842be8295c40630cf665890f975ccfc44d337a7d2062ed6d42cfa47621', 'applied', 'upgrade-sql'),
  (3, '0003_two_factor', '47a2f25e0c80314f2e6d2b89362093445a7a2216aff1499fcbebb4194a749d4e', 'applied', 'upgrade-sql'),
  (4, '0004_live_reporting', '2c7d6b32998a1bb821fae0e851472a114450c595f019eec4a5405971f6d50dc6', 'applied', 'upgrade-sql'),
  (5, '0005_lead_call_counts', 'ec6935a177b44b1b895cade7e894adfc0ec2456997932c65ae8d86817cb26af2', 'applied', 'upgrade-sql'),
  (6, '0006_dashboard_prefs', 'b8846a758b6fc363458a2e054f798dff9f0e564f12a9df35e3456bd7e0a654b7', 'applied', 'upgrade-sql'),
  (7, '0007_budget_changes', '7ef76bbd233f7c232a4217e345c2cc19e131a5dd4e77ff0adc03d68d956dd900', 'applied', 'upgrade-sql'),
  (8, '0008_account_funds', '73c0bb4d0f513ff177660d25fd9ee6322807fa97c8b6380158d24cc506ec9f26', 'applied', 'upgrade-sql'),
  (9, '0009_launches', 'b90814e072bc0614fc9be6652cf65cd419dee9384ab2e5bce200a52c0e719c3b', 'applied', 'upgrade-sql'),
  (10, '0010_ai', '34b20c7733cc57b2dc305a03485ccad94577d63d31203fbe9f6fb48820932bb4', 'applied', 'upgrade-sql'),
  (11, '0011_modules', '24f1d70bcd1868e427456b72abdb1d4d9452bd146985e540e650b2fed16a6605', 'applied', 'upgrade-sql');

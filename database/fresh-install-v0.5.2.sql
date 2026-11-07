-- =====================================================================================
-- Ads Command Center 0.5.2 : FRESH INSTALL database (schema version 8)
--
-- You normally do NOT need this file: the app's Setup page installs the database itself.
-- Use it only if you prefer to import with phpMyAdmin (MySQL 8).
--
-- SAFETY
--   * Import ONLY into a NEW, EMPTY database. It has no DROP statements, so it stops with
--     "table already exists" instead of overwriting anything. Never run it over a live database.
--   * To upgrade an existing install, do NOT use this file. Deploy the new release and press
--     "Apply pending migrations" in Settings -> Database (see docs/UPGRADE.md).
--   * It records migrations 1-8 in schema_migrations, so the app sees the database as up to
--     date. After importing, open the panel: it asks for the SETUP_TOKEN and creates the Super Admin.
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE schema_migrations (
  version INT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  checksum CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  applied_by VARCHAR(190) NULL,
  error TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- 0001_foundation
-- 0001_foundation: identity, sessions, audit, settings, Meta connections, accounts, jobs, notifications.
-- Applied by the migration runner (Setup page or `npm run migrate`). Never run by hand over a live database
-- unless schema_migrations shows it has not been applied.

CREATE TABLE orgs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE brands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  logo_url VARCHAR(1024) NULL,
  default_page_id VARCHAR(64) NULL,
  default_phone VARCHAR(40) NULL,
  default_website VARCHAR(1024) NULL,
  naming_format VARCHAR(255) NULL,
  reporting_currency CHAR(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_brands_org_name (org_id, name),
  CONSTRAINT fk_brands_org FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL,
  ai_level TINYINT UNSIGNED NOT NULL DEFAULT 1,
  all_accounts TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES orgs(id),
  CONSTRAINT chk_users_ai_level CHECK (ai_level BETWEEN 1 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  csrf_token CHAR(64) NOT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_kind VARCHAR(16) NOT NULL DEFAULT 'user',
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(128) NULL,
  details JSON NULL,
  correlation_id VARCHAR(64) NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_created (created_at),
  KEY idx_audit_actor (actor_user_id, created_at),
  KEY idx_audit_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE system_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE branding_settings (
  org_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  panel_name VARCHAR(120) NOT NULL DEFAULT 'Ads Command Center',
  logo_url VARCHAR(1024) NULL,
  favicon_url VARCHAR(1024) NULL,
  primary_color CHAR(7) NOT NULL DEFAULT '#4f46e5',
  sidebar_style VARCHAR(16) NOT NULL DEFAULT 'default',
  default_theme VARCHAR(8) NOT NULL DEFAULT 'system',
  default_currency CHAR(3) NOT NULL DEFAULT 'USD',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dhaka',
  default_language VARCHAR(8) NOT NULL DEFAULT 'bn',
  ai_assistant_name VARCHAR(80) NOT NULL DEFAULT 'AI Ads Copilot',
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_branding_org FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meta_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  connected_by BIGINT UNSIGNED NOT NULL,
  meta_user_id VARCHAR(64) NOT NULL,
  meta_user_name VARCHAR(190) NULL,
  token_ciphertext TEXT NOT NULL,
  token_key_id VARCHAR(16) NOT NULL,
  token_expires_at DATETIME(3) NULL,
  scopes TEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  last_checked_at DATETIME(3) NULL,
  last_error VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_meta_conn (org_id, meta_user_id),
  CONSTRAINT fk_meta_conn_org FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meta_ad_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NULL,
  connection_id BIGINT UNSIGNED NOT NULL,
  account_id VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  currency CHAR(3) NOT NULL,
  timezone_name VARCHAR(64) NULL,
  account_status INT NULL,
  disable_reason INT NULL,
  amount_spent_minor BIGINT NULL,
  spend_cap_minor BIGINT NULL,
  business_id VARCHAR(32) NULL,
  business_name VARCHAR(255) NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_synced_at DATETIME(3) NULL,
  last_sync_error VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ad_account (org_id, account_id),
  KEY idx_ad_account_brand (brand_id),
  KEY idx_ad_account_name (name),
  CONSTRAINT fk_ad_account_org FOREIGN KEY (org_id) REFERENCES orgs(id),
  CONSTRAINT fk_ad_account_conn FOREIGN KEY (connection_id) REFERENCES meta_connections(id),
  CONSTRAINT fk_ad_account_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meta_pages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  connection_id BIGINT UNSIGNED NOT NULL,
  page_id VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  ig_account_id VARCHAR(32) NULL,
  ig_username VARCHAR(190) NULL,
  tasks TEXT NULL,
  last_synced_at DATETIME(3) NULL,
  UNIQUE KEY uq_meta_page (org_id, page_id),
  CONSTRAINT fk_meta_page_conn FOREIGN KEY (connection_id) REFERENCES meta_connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_account_access (
  user_id BIGINT UNSIGNED NOT NULL,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  can_publish TINYINT(1) NOT NULL DEFAULT 0,
  can_manage TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ad_account_row_id),
  CONSTRAINT fk_uaa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_uaa_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE account_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  brand_id BIGINT UNSIGNED NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(512) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_group_name (org_id, name),
  CONSTRAINT fk_group_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE account_group_members (
  group_id BIGINT UNSIGNED NOT NULL,
  ad_account_row_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (group_id, ad_account_row_id),
  CONSTRAINT fk_agm_group FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_agm_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE account_defaults (
  ad_account_row_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  page_id VARCHAR(32) NULL,
  ig_account_id VARCHAR(32) NULL,
  phone_number VARCHAR(40) NULL,
  website_url VARCHAR(1024) NULL,
  daily_budget_minor BIGINT NULL,
  audience JSON NULL,
  placements JSON NULL,
  naming_format VARCHAR(255) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_defaults_account FOREIGN KEY (ad_account_row_id) REFERENCES meta_ad_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  queue VARCHAR(32) NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 100,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 6,
  run_after DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_by VARCHAR(64) NULL,
  lease_until DATETIME(3) NULL,
  dedupe_key VARCHAR(190) NULL,
  last_error JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  UNIQUE KEY uq_jobs_dedupe (dedupe_key),
  KEY idx_jobs_due (status, queue, run_after, priority),
  KEY idx_jobs_lease (status, lease_until),
  CONSTRAINT chk_jobs_status CHECK (status IN ('queued','running','succeeded','failed','needs_review','dead','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE job_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT UNSIGNED NOT NULL,
  attempt INT UNSIGNED NOT NULL,
  worker_id VARCHAR(64) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  outcome VARCHAR(16) NULL,
  error JSON NULL,
  KEY idx_job_runs_job (job_id),
  CONSTRAINT fk_job_runs_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE scheduler_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  locked_by VARCHAR(64) NULL,
  lease_until DATETIME(3) NULL,
  last_tick_at DATETIME(3) NULL,
  last_success_at DATETIME(3) NULL,
  last_source VARCHAR(32) NULL,
  last_error VARCHAR(1024) NULL,
  last_error_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO scheduler_state (id) VALUES (1);

CREATE TABLE scheduler_heartbeats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(32) NOT NULL,
  worker_id VARCHAR(64) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  jobs_claimed INT UNSIGNED NOT NULL DEFAULT 0,
  jobs_succeeded INT UNSIGNED NOT NULL DEFAULT 0,
  jobs_failed INT UNSIGNED NOT NULL DEFAULT 0,
  leases_reclaimed INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_reason VARCHAR(64) NULL,
  error VARCHAR(1024) NULL,
  KEY idx_heartbeats_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE recurring_schedules (
  name VARCHAR(64) NOT NULL PRIMARY KEY,
  queue VARCHAR(32) NOT NULL,
  type VARCHAR(64) NOT NULL,
  interval_seconds INT UNSIGNED NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_enqueued_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO recurring_schedules (name, queue, type, interval_seconds) VALUES
  ('meta_account_sync', 'sync', 'meta.sync_accounts', 300),
  ('meta_token_check', 'sync', 'meta.check_tokens', 3600),
  ('session_cleanup', 'maintenance', 'maintenance.cleanup_sessions', 3600);

CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'info',
  category VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NULL,
  link VARCHAR(512) NULL,
  dedupe_key VARCHAR(190) NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_notifications_user (org_id, user_id, read_at),
  UNIQUE KEY uq_notifications_dedupe (dedupe_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE oauth_states (
  state CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_oauth_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
  (1, '0001_foundation', 'bed3cda6f6eec68af544ca187e09074281aa5ff13d2a76228b7ec99449af8560', 'applied', 'fresh-install-sql'),
  (2, '0002_media', '69eee0842be8295c40630cf665890f975ccfc44d337a7d2062ed6d42cfa47621', 'applied', 'fresh-install-sql'),
  (3, '0003_two_factor', '47a2f25e0c80314f2e6d2b89362093445a7a2216aff1499fcbebb4194a749d4e', 'applied', 'fresh-install-sql'),
  (4, '0004_live_reporting', '2c7d6b32998a1bb821fae0e851472a114450c595f019eec4a5405971f6d50dc6', 'applied', 'fresh-install-sql'),
  (5, '0005_lead_call_counts', 'ec6935a177b44b1b895cade7e894adfc0ec2456997932c65ae8d86817cb26af2', 'applied', 'fresh-install-sql'),
  (6, '0006_dashboard_prefs', 'b8846a758b6fc363458a2e054f798dff9f0e564f12a9df35e3456bd7e0a654b7', 'applied', 'fresh-install-sql'),
  (7, '0007_budget_changes', '7ef76bbd233f7c232a4217e345c2cc19e131a5dd4e77ff0adc03d68d956dd900', 'applied', 'fresh-install-sql'),
  (8, '0008_account_funds', '73c0bb4d0f513ff177660d25fd9ee6322807fa97c8b6380158d24cc506ec9f26', 'applied', 'fresh-install-sql');

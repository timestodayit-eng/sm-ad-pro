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

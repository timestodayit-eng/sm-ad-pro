-- =====================================================================================
-- Ads Command Center 0.8.0 : UPGRADE database from schema version 9 to 11
--
-- Use this ONLY on a database that is at schema version 9. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be 9.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the 0.8.0 files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: 0010_ai, 0011_modules
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

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
  (10, '0010_ai', '34b20c7733cc57b2dc305a03485ccad94577d63d31203fbe9f6fb48820932bb4', 'applied', 'upgrade-sql'),
  (11, '0011_modules', '24f1d70bcd1868e427456b72abdb1d4d9452bd146985e540e650b2fed16a6605', 'applied', 'upgrade-sql');

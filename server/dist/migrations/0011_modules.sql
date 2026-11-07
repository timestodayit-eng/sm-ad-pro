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

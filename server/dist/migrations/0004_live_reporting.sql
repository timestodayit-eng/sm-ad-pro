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

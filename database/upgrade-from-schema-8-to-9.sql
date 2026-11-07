-- =====================================================================================
-- Ads Command Center 0.6.0 : UPGRADE database from schema version 8 to 9
--
-- Use this ONLY on a database that is at schema version 8. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be 8.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the 0.6.0 files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: 0009_launches
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

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

-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
  (9, '0009_launches', 'b90814e072bc0614fc9be6652cf65cd419dee9384ab2e5bce200a52c0e719c3b', 'applied', 'upgrade-sql');

-- =====================================================================================
-- Ads Command Center 0.10.3 : UPGRADE database from schema version 11 to 12
--
-- Use this ONLY on a database that is at schema version 11. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be 11.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the 0.10.3 files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: 0012_launch_ads
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

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
  (12, '0012_launch_ads', 'ee043359a2e038f8ae94d859b6ca7a42ffb2f503e4e036131166e572e2a159e6', 'applied', 'upgrade-sql');

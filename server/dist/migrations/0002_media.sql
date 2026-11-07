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

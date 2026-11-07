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

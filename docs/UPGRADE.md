# Upgrading an existing install

Upgrades never re-run the fresh-install SQL. Schema changes ship as numbered migration files
(`server/migrations/0002_….sql`, …) and are applied in order by the migration runner, which records each one
in `schema_migrations` with a checksum.

## Steps

1. **Back up the database.** hPanel → Databases → phpMyAdmin → Export, or hPanel backups.
2. Upload the new release (or pull and run `npm ci && npm run build`).
3. Restart the Node.js app.
4. Sign in as Super Admin. If the new release needs schema changes, a notice appears; open
   **Settings → Database** and press **Apply pending migrations**. (Command line alternative: `npm run migrate`.)
5. Check **System Health**: *Database schema* should say up to date.

While upgrades are pending, `GET /readyz` returns 503 and background jobs pause, so nothing runs against
a half-upgraded schema.

## Safety checks in the runner

| Error code | What it means | What to do |
| --- | --- | --- |
| `MIGRATION_LOCKED` | Another process is migrating | Wait a minute and retry |
| `MIGRATION_CHECKSUM_MISMATCH` | An already-applied migration file was edited | Restore the original file; never edit applied migrations |
| `MIGRATION_PREVIOUSLY_FAILED` | An earlier attempt failed part-way | Restore the backup from step 1, fix the cause, retry |
| `MIGRATION_FAILED` | A statement failed; the message names it | Restore the backup, report the message |

## Rolling back

Restore the database backup and redeploy the previous release. Migrations are forward-only on purpose.

## Release notes

- **0.2.0** adds migration `0002_media` (media library table and a cleanup schedule). After deploying, apply it from Settings → Database. Add the R2 settings from docs/R2_SETUP.md, then run **Check storage connection** on the Media Library page.

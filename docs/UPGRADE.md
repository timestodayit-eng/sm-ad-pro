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

### phpMyAdmin alternative

Each release ZIP has `database/upgrade-from-schema-N-to-M.sql` files. Open the `schema_migrations` table: the
highest applied `version` is your N. Back up, then import that one file (Import → choose file → Go). It applies the
same migrations as the button and records them with matching checksums.

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

- **0.5.1** adds migration `0008_account_funds` (balance, amount owed, payment method and a low-balance alert setting). With phpMyAdmin, import `upgrade-from-schema-7-to-8.sql` (use the 6-, 5- … to-8 file if you skipped releases). The **Balance** page fills in on the next sync of each account, within 15 minutes. Set the low-balance alert under **Settings → Cost alerts → Low balance (days)**.

- **0.5.0** adds migration `0007_budget_changes` (a history of every budget change). With phpMyAdmin, import `upgrade-from-schema-6-to-7.sql` (or `upgrade-from-schema-5-to-7.sql` if you skipped 0.4.2). The new **Budgets** page changes ad set daily budgets on Meta, so the Meta login needs the `ads_management` permission. Only Super Admin, Admin and Media Buyer can confirm a change.

- **0.4.2** adds migration `0006_dashboard_prefs`: one shared account order for the whole panel, each user's column and sort choices, and 90 days of history instead of 30. If you upgrade with phpMyAdmin, import `upgrade-from-schema-5-to-6.sql`. After applying it, set your order under **Settings → Working accounts → Arrange order** (drag, or paste your list). The next sync of each account re-reads 90 days, so older dates fill in within a few minutes.

- **0.4.1** adds migration `0005_lead_call_counts`. Leads, calls and messaging conversations are now counted for every account and campaign, and **Settings → Cost alerts** sets limits for daily spend and cost per lead, call, message or result (a default per currency, overridable per account). After applying it, the next sync re-reads the last 30 days so the new counts fill in.

- **0.4.0** adds migration `0004_live_reporting` (managed-account flag, campaigns, ad sets, ads, daily insights, and a 15-minute sync schedule). After applying it, open **Ad Accounts**, turn **Dashboard** on for the accounts you manage, and the dashboard fills in within a minute or two. No account is managed until you choose it. The cron job must be running (docs/SCHEDULER.md) for numbers to stay fresh.

- **0.3.3** has no schema changes. If a Meta login lacks `business_management`, ad accounts and Pages still import (without business names), and the Meta login row lists the missing permissions with the fix. See docs/META_SETUP.md.

- **0.3.2** has no schema changes. A wrong or missing setting now shows a page naming the setting instead of a bare 503. `TOKEN_ENCRYPTION_KEY` also accepts a value wrapped in quotes or spaces, or a 64-character hex key.

- **0.3.0** adds migration `0003_two_factor`. After you apply it, every Super Admin and Admin is taken to **Security** at their next page load and must set up two-step login with an authenticator app before using the panel. Schema upgrades stay reachable without it, so an upgrade can never lock everyone out. Save the recovery codes. If someone loses their phone, another Super Admin can reset it from Settings → Users.

- **0.2.0** adds migration `0002_media` (media library table and a cleanup schedule). After deploying, apply it from Settings → Database. Add the R2 settings from docs/R2_SETUP.md, then run **Check storage connection** on the Media Library page.

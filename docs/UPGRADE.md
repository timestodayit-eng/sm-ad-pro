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

- **0.9.0** has no schema changes. Easy Ads and Advanced Ads get the Ads Manager campaign details: **Buying type** (Auction; Reserved is listed but not supported) and **Campaign objective** (Awareness, Traffic, Engagement, Leads, Sales, App promotion) with the optimisations Meta allows for each with a call or a website; Advanced Ads also gets a campaign spending limit. Defaults are unchanged (Calls under Engagement, Link clicks under Traffic), so saved launches and sheets behave as before.
- **0.8.1** has no schema changes. The assistant no longer sends a temperature to OpenAI unless a feature asks for one, and when a model refuses a parameter (reasoning models such as the o-series and gpt-5 family accept only the default temperature) the panel drops it and retries once, then remembers. Fixes "Unsupported value: 'temperature'" in the Copilot.
- **0.8.0** adds migration `0011_modules` (tables for saved audiences, placement sets, report templates, finance rates and entries, monitoring settings and runs, comment actions; the `monitor_scan` schedule every 30 minutes). With phpMyAdmin, import `upgrade-from-schema-10-to-11.sql` (or the older-schema file if you skipped releases), or press **Apply pending migrations** in Settings → Database. To answer comments, reconnect Meta from Ad Accounts once: the panel now asks for `pages_read_user_content` and `pages_manage_engagement`. Monitoring starts on its own with the scheduler; check it under Monitoring.
- **0.7.1** has no schema changes. The AI Copilot no longer keeps the browser request open while the model answers: the message is accepted at once and the panel polls for the answer, so the hosting proxy cannot cut it off with a 502. A model error now appears inside the chat, marked as an error, with the reason. Proxy cut-offs (502/503/504) on any page now show a plain explanation instead of "Request failed".
- **0.7.0** adds migration `0010_ai` (tables `ai_conversations`, `ai_messages`, `ai_documents`, `ai_document_versions`). With phpMyAdmin, import `upgrade-from-schema-9-to-10.sql` (use the 8-, 7- … to-10 file if you skipped releases), or press **Apply pending migrations** in Settings → Database. The AI Copilot and the assistant parts of AI Documents need two new hosting settings: `OPENAI_API_KEY` and `OPENAI_MODEL` (for example `gpt-4o-mini`), optionally `OPENAI_BASE_URL` for a compatible gateway. Put them in the hosting environment (Hostinger → Advanced → Environment variables), never in the panel or in chat, then restart the app. AI Analytics findings and the data tables in AI Documents work without a key. Advanced Ads needs no new settings.
- **0.6.1** has no schema changes. Easy Ads: when Meta refuses the "Advantage+ creative off" switches on the ad creative, the panel now falls back (fewer switches, then none) instead of failing the row, and shows a warning on the Publishing page so you can turn enhancements off by hand. Press **Retry** on rows that stopped at the creative step; the campaign and ad set are kept.

- **0.6.0** adds migration `0009_launches` (tables `launches`, `launch_items`, `meta_video_uploads` for Easy Ads). With phpMyAdmin, import `upgrade-from-schema-8-to-9.sql` (use the 7-, 6- … to-9 file if you skipped releases), or press **Apply pending migrations** in Settings → Database. Easy Ads needs the Meta login to have `ads_management` and `pages_show_list` (reconnect Meta from Ad Accounts if the Pages list is empty). Everything Easy Ads creates is PAUSED; switch ads on in Ads Manager.

- **0.5.3** has no schema changes. Fixes the confusing "database is at version 8 but needs 8" message: when an earlier migration was skipped (for example only the 7-to-8 file was imported on a schema-6 database), Settings → Database, System Health and the banner now name the missing migration, and **Apply pending migrations** fills the gap. Refused cron calls (wrong secret, upgrade pending) now show in System Health → Recent ticks.

- **0.5.2** has no schema changes. When the database is behind the code, background jobs pause on purpose; the banner and System Health now say so and name the upgrade file, instead of only "not running".

- **0.5.1** adds migration `0008_account_funds` (balance, amount owed, payment method and a low-balance alert setting). With phpMyAdmin, import `upgrade-from-schema-7-to-8.sql` (use the 6-, 5- … to-8 file if you skipped releases). The **Balance** page fills in on the next sync of each account, within 15 minutes. Set the low-balance alert under **Settings → Cost alerts → Low balance (days)**.

- **0.5.0** adds migration `0007_budget_changes` (a history of every budget change). With phpMyAdmin, import `upgrade-from-schema-6-to-7.sql` (or `upgrade-from-schema-5-to-7.sql` if you skipped 0.4.2). The new **Budgets** page changes ad set daily budgets on Meta, so the Meta login needs the `ads_management` permission. Only Super Admin, Admin and Media Buyer can confirm a change.

- **0.4.2** adds migration `0006_dashboard_prefs`: one shared account order for the whole panel, each user's column and sort choices, and 90 days of history instead of 30. If you upgrade with phpMyAdmin, import `upgrade-from-schema-5-to-6.sql`. After applying it, set your order under **Settings → Working accounts → Arrange order** (drag, or paste your list). The next sync of each account re-reads 90 days, so older dates fill in within a few minutes.

- **0.4.1** adds migration `0005_lead_call_counts`. Leads, calls and messaging conversations are now counted for every account and campaign, and **Settings → Cost alerts** sets limits for daily spend and cost per lead, call, message or result (a default per currency, overridable per account). After applying it, the next sync re-reads the last 30 days so the new counts fill in.

- **0.4.0** adds migration `0004_live_reporting` (managed-account flag, campaigns, ad sets, ads, daily insights, and a 15-minute sync schedule). After applying it, open **Ad Accounts**, turn **Dashboard** on for the accounts you manage, and the dashboard fills in within a minute or two. No account is managed until you choose it. The cron job must be running (docs/SCHEDULER.md) for numbers to stay fresh.

- **0.3.3** has no schema changes. If a Meta login lacks `business_management`, ad accounts and Pages still import (without business names), and the Meta login row lists the missing permissions with the fix. See docs/META_SETUP.md.

- **0.3.2** has no schema changes. A wrong or missing setting now shows a page naming the setting instead of a bare 503. `TOKEN_ENCRYPTION_KEY` also accepts a value wrapped in quotes or spaces, or a 64-character hex key.

- **0.3.0** adds migration `0003_two_factor`. After you apply it, every Super Admin and Admin is taken to **Security** at their next page load and must set up two-step login with an authenticator app before using the panel. Schema upgrades stay reachable without it, so an upgrade can never lock everyone out. Save the recovery codes. If someone loses their phone, another Super Admin can reset it from Settings → Users.

- **0.2.0** adds migration `0002_media` (media library table and a cleanup schedule). After deploying, apply it from Settings → Database. Add the R2 settings from docs/R2_SETUP.md, then run **Check storage connection** on the Media Library page.

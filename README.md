# Ads Command Center

A self-hosted panel for running many Meta ad accounts from one place: bulk PAUSED campaign creation, real
reporting from synced Meta data, and an AI Copilot that works through approved, permission-checked tools.

Stack: React + Vite + TypeScript + Tailwind (web), Node 22 + Express + TypeScript (server), MySQL 8.

## What works in this release (0.5.2)

| Area | State |
| --- | --- |
| First-run Setup page: install the database and create the Super Admin, no SSH needed | Built and tested |
| Sign-in, sessions, CSRF and origin checks, login lockout | Built and tested |
| Two-step login (authenticator app + 10 recovery codes), required for Super Admin and Admin, Super Admin reset for lost phones | Built and tested, checked in a browser |
| Roles: Super Admin, Admin, Media Buyer, Analyst, Viewer | Built and tested |
| Audit log of every admin change | Built and tested |
| White-label branding, light / dark / follow-device theme, Bengali / English | Built, checked in a browser |
| Versioned database migrations with checksums and a lock | Built and tested |
| MySQL job queue with leases, retries, backoff and dead-letter, plus the every-minute scheduler | Built and tested |
| System Health page with an evidence level for every check | Built |
| Meta connection (Facebook Login for Business), ad account and Page import, account groups, per-account defaults | Built, **not yet verified against a live Meta app** |
| Media library: direct-to-R2 uploads up to 1 GB, pause/resume/retry, resume after a crash, thumbnails, preview, delete, storage connection check | Built, tested against an S3-compatible store and in a browser; **not yet tested against your real R2 bucket** |
| Working accounts chosen once in Settings, one shared account order (drag or paste a list) used on every page; account groups that open the dashboard and Campaigns; date filter (Today, Yesterday, Last 7/14/30 days, This/Last month, custom range, 90 days of history); sortable dashboard columns you can show, hide and reorder; Campaigns page across all working accounts; live dashboard with spend, results, CTR/CPC, running campaigns and ads, daily spend, ad thumbnails and Meta's own ad previews, synced every 15 minutes; leads, calls and messages per account and campaign; cost alerts with limits in Settings | Built, tested against recorded Meta responses and in a browser; **not yet verified against a live Meta account** |
| Budgets page: change ad set daily budgets across working accounts in the account order (step up, same for all, or add to current), preview, explicit confirm, one-by-one writes read back from Meta, and a history of every change | Built, tested against recorded Meta responses; **not yet verified against a live Meta account** |
| Balance page: prepaid funds, amount owed, spending limit left and days left at the last 7 days' spend for every working account, plus a low-balance alert | Built, tested against recorded Meta responses; **prepaid balance text not yet verified against a live Meta account** |
| Pause/resume, publishing engine, Easy/Advanced Ads, reports, AI Copilot, AI documents, alerts, creative leaderboard, budget pacing | Not built yet; each page in the panel says which phase it ships in |

The panel never shows sample data. Pages for modules that are not built say so instead of showing fake numbers or buttons.

## Run it locally

```bash
npm install
cp .env.example .env          # then fill in DB_*, the secrets and APP_ORIGIN=http://localhost:3000
set -a; . ./.env; set +a
npm run build
npm start                      # open http://localhost:3000 and follow the Setup page
```

For development with hot reload run `npm run dev:server` and `npm run dev:web` (Vite proxies `/api` to port 3000).

## Tests

```bash
# needs a MySQL 8 (or MariaDB 10.11) database the test user may wipe
TEST_DB_NAME=acc_test TEST_DB_USER=acc TEST_DB_PASSWORD=acc_pw npm test
# media upload tests also need an S3-compatible server, e.g. `pip install "moto[server]" && moto_server -p 5055`
TEST_S3_ENDPOINT=http://127.0.0.1:5055 npm test
```

CI (`.github/workflows/ci.yml`) runs typecheck, build and the full test suite against MySQL 8 on every push.

## Database file

`database/fresh-install-v<version>.sql` is the complete MySQL 8 schema for a new, empty database, built from `server/migrations/` by `npm run build:sql`. The Setup page applies the same migrations automatically, so importing it is optional. Upgrades always go through the migration runner, never this file.

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Hostinger Cloud, step by step
- [docs/SCHEDULER.md](docs/SCHEDULER.md): the every-minute cron job
- [docs/META_SETUP.md](docs/META_SETUP.md): creating the Meta app and Login for Business configuration
- [docs/R2_SETUP.md](docs/R2_SETUP.md): Cloudflare R2 bucket, keys and CORS
- [docs/UPGRADE.md](docs/UPGRADE.md): upgrading an existing install without losing data

## Safety rules built into the code

- Everything is created on Meta as PAUSED. Turning anything ACTIVE needs `ACTIVATION_ENABLED=true` and a separate approval.
- A Meta step only counts as done when Meta returns a real ID. Network failures on writes are marked "needs review", never "succeeded".
- Secrets live only in the hosting environment. Meta tokens are encrypted in the database with AES-256-GCM.
- The fresh-install SQL is applied only by the migration runner, which refuses to run over an install that already has users.

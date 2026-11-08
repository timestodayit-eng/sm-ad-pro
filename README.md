# Ads Command Center

A self-hosted panel for running many Meta ad accounts from one place: bulk PAUSED campaign creation, real
reporting from synced Meta data, and an AI Copilot that works through approved, permission-checked tools.

Stack: React + Vite + TypeScript + Tailwind (web), Node 22 + Express + TypeScript (server), MySQL 8.

## What works in this release (0.8.1)

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
| Easy Ads: the same video, caption and headline to the accounts (or group) you tick, in your account order, from one Facebook Page; lifetime budget (or daily) with start and end dates, running hours such as 07:00–22:00 in each account's time zone, fixed placements you tick (never Advantage+ placements), every Advantage+ creative change switched off; budget and age range per account (typed in, stepped 20, 22, 24 …, or from an uploaded CSV sheet); goal Call or Website; review with every problem named, explicit confirm; one campaign + one ad set + one ad per account, **all created PAUSED**; video uploaded to each account once and reused | Built, tested against recorded Meta responses and in a browser; **not yet verified against a live Meta account** |
| Publishing page: live progress per account through the 7 steps, the real Meta IDs, the error Meta gave, Retry that checks Meta first so it never makes a duplicate, Cancel for rows not started | Built and tested |
| Advanced Ads: everything Easy Ads does plus bid cap or cost cap, places inside the countries (regions, cities with a radius, postcodes) and places to exclude, living-in / recently-in / travelling-in, interests and behaviours (and interests to exclude), languages, mobile/desktop and Android/iOS, running days, link description and URL tags, Advantage+ creative on or off, and per-account overrides (Page, video, caption, title, link, and that account's own custom audiences to include or exclude). Every list is read live from Meta's own search; job-ad (Employment) rules are checked before anything is created | Built, tested against recorded Meta responses and in a browser; **not yet verified against a live Meta account** |
| AI Analytics: findings computed by the panel's code from synced data (spend spikes, stalled delivery, spend without results, expensive or cheap results against the other accounts, low balance, rejected ads, failed launches), each with the numbers behind it, likely causes, confidence and a link; optional one-paragraph explanation by the assistant in Bengali or English | Built and tested; findings work without an AI key |
| AI Ads Copilot: chat in Bengali, Banglish or English about accounts, campaigns, balances, findings, launches and notifications; every number comes from the panel's data through tools, never guessed; budget changes come back as a proposal card that goes through the same preview and confirm as the Budgets page | Built, tested with a recorded assistant; needs `OPENAI_API_KEY` and `OPENAI_MODEL` in the hosting settings; **not yet run against the real OpenAI API** |
| AI Documents: performance reports built from synced data (overview, accounts, campaigns, money left, findings) with an assistant-written summary and recommendations marked as such; edit in the panel, every save is a new version, export as PDF or Word | Built and tested; the assistant parts need the OpenAI settings, the tables do not |
| Audience Manager: audiences saved once (countries, ages, gender, places with radius, exclusions, interests, behaviours, languages, devices, Advantage+ audience) and loaded into Easy Ads or Advanced Ads; Meta's own reach estimate per account; Employment rules checked before saving | Built and tested against recorded Meta responses |
| Placements: saved sets of manual placements loaded into any launch | Built and tested |
| Custom Reports: any working accounts, any period, rows by account, campaign, ad, day or month, the metrics you pick (spend, impressions, clicks, link clicks, leads, calls, messages, results, CTR, CPC, CPM, cost per lead/call/message/result), sortable, totals per currency, saved reports, CSV export; no account or row limit beyond what was synced | Built and tested |
| Finance: spend by account, currency and period; money left as Meta reports it; top-ups and other entries logged by hand; last 6 months by currency; BDT totals only at a rate you typed in, shown with its date; CSV export | Built and tested |
| Monitoring: every 30 minutes the scheduler runs the AI Analytics checks plus stale-sync and expiring-login checks for every organisation and writes one notification per finding per day; settings for which checks and severities alert; Scan now; history of runs | Built and tested |
| Comments: comments on each Page's recent posts (ads included) read live from Meta, reply and hide through the Page token, an assistant-drafted reply that is only sent when you press Send, a log of what the panel did; needs the Meta login reconnected with `pages_read_user_content` and `pages_manage_engagement` | Built, tested against recorded Meta responses; **not yet verified on a live Page** |
| Pause/resume, scheduled report delivery, Telegram/WhatsApp alerts, creative leaderboard, budget pacing | Not built yet |

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

# Ads Command Center

A self-hosted panel for running many Meta ad accounts from one place: bulk PAUSED campaign creation, real
reporting from synced Meta data, and an AI Copilot that works through approved, permission-checked tools.

Stack: React + Vite + TypeScript + Tailwind (web), Node 22 + Express + TypeScript (server), MySQL 8.

## What works in this release (0.2.0)

| Area | State |
| --- | --- |
| First-run Setup page: install the database and create the Super Admin, no SSH needed | Built and tested |
| Sign-in, sessions, CSRF and origin checks, login lockout | Built and tested |
| Roles: Super Admin, Admin, Media Buyer, Analyst, Viewer | Built and tested |
| Audit log of every admin change | Built and tested |
| White-label branding, light / dark / follow-device theme, Bengali / English | Built, checked in a browser |
| Versioned database migrations with checksums and a lock | Built and tested |
| MySQL job queue with leases, retries, backoff and dead-letter, plus the every-minute scheduler | Built and tested |
| System Health page with an evidence level for every check | Built |
| Meta connection (Facebook Login for Business), ad account and Page import, account groups, per-account defaults | Built, **not yet verified against a live Meta app** |
| Media library: direct-to-R2 uploads up to 1 GB, pause/resume/retry, resume after a crash, thumbnails, preview, delete, storage connection check | Built, tested against an S3-compatible store and in a browser; **not yet tested against your real R2 bucket** |
| Publishing engine, Easy/Advanced Ads, reports, AI Copilot, AI documents, alerts, creative leaderboard, budget pacing, two-step login | Not built yet; each page in the panel says which phase it ships in |

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

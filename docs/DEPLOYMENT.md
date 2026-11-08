# Deploying on Hostinger Cloud

Target: `https://proads.smenterpriserl1987.com`, Node.js app in hPanel, MySQL 8 from the same plan.

## 1. Create the database

hPanel → Databases → MySQL Databases. Create a database and a user, and note the three values
(`u…_proads` style names). Leave the database empty: the app installs its own tables.

### Optional: import the database with phpMyAdmin

The Setup page (step 4) installs the tables for you, so this is not needed. If you prefer phpMyAdmin:

1. hPanel → Databases → phpMyAdmin → open your **new, empty** database.
2. **Import** → choose `database/fresh-install-v<version>.sql` from the release ZIP → **Go**.
3. Continue with step 2. The Setup page will skip "Install database" and go straight to creating the Super Admin.

Never import this file into a database that already has the app's tables. For upgrades use [UPGRADE.md](UPGRADE.md).

## 2. Create the Node.js app

hPanel → Websites → your domain → Node.js (or "Add website → Node.js app").

- Node version: **22**
- Application root: the folder you upload to
- Startup file: **`server.js`**
- Install command: `npm ci --omit=dev` (or leave Hostinger's default)
- Build command: `npm run build`. With a release ZIP this finishes instantly ("Prebuilt … found"), because the ZIP already contains the compiled app. From Git source it compiles; all build tools are regular dependencies, so it works even when the host skips dev packages.

## 3. Add the environment variables

Open the app's **Environment variables** panel and add every key from `.env.example` with real values.
Minimum to boot:

`NODE_ENV=production`, `APP_ORIGIN`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `JOB_RUNNER_SECRET`, `SETUP_TOKEN`.

Generate secrets on your own computer:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET, JOB_RUNNER_SECRET, SETUP_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOKEN_ENCRYPTION_KEY (keep a private copy: it must never change)
```

No Node on your computer? Use hPanel → Advanced → SSH terminal (or any Mac/Linux terminal) and run
`openssl rand -base64 32` for `TOKEN_ENCRYPTION_KEY` (44 characters ending in `=`) and `openssl rand -base64 48`
for the other three. Paste the value without quotes or spaces.

Keep a private copy of `TOKEN_ENCRYPTION_KEY`. Without it, stored Meta tokens cannot be decrypted.

If a value is wrong the app does not start its main server. Instead the site shows a page listing each bad
setting by name (never its value), `/healthz` returns 503 with the same list, and the log says the same thing, for
example `META_REDIRECT_URI: must be on APP_ORIGIN`. Fix the value in hPanel and restart the app.

## 4. Start and run Setup

Start the app, then open `https://proads.smenterpriserl1987.com`. You land on **Setup**:

1. Enter the `SETUP_TOKEN`, press **Install database**.
2. Fill in business name, your name, email and a password of 12+ characters, press **Create Super Admin and sign in**.

Setup refuses to run again once a user exists.

3. You are taken to **Security** to turn on two-step login (required for Super Admins and Admins). Scan the QR code with Google Authenticator, Microsoft Authenticator or Authy, enter the code, and save the 10 recovery codes somewhere safe.

## 5. Add the cron job

Follow [SCHEDULER.md](SCHEDULER.md). Until the cron job runs, a yellow banner says background jobs are not running.

## 6. Check System Health

Open **System Health**. Each check shows what it proved: *Live check* (tested just now), *Config only*
(settings look right, not tested live), or *Not configured*.

## Checks after each deploy

- `GET /healthz` returns `{"ok":true}` (process is up)
- `GET /readyz` returns 200 only when the database is reachable and the schema is current
- System Health shows the scheduler as **Running** within two minutes

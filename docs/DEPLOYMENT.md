# Deploying on Hostinger Cloud

Target: `https://proads.smenterpriserl1987.com`, Node.js app in hPanel, MySQL 8 from the same plan.

## 1. Create the database

hPanel → Databases → MySQL Databases. Create a database and a user, and note the three values
(`u…_proads` style names). Leave the database empty: the app installs its own tables.

## 2. Create the Node.js app

hPanel → Websites → your domain → Node.js (or "Add website → Node.js app").

- Node version: **22**
- Application root: the folder you upload to
- Startup file: **`server.js`**
- Build command: `npm ci && npm run build` (or upload a release ZIP that already contains `server/dist` and `web/dist`, then use `npm ci --omit=dev`)

## 3. Add the environment variables

Open the app's **Environment variables** panel and add every key from `.env.example` with real values.
Minimum to boot:

`NODE_ENV=production`, `APP_ORIGIN`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `JOB_RUNNER_SECRET`, `SETUP_TOKEN`.

Generate secrets on your own computer:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET, JOB_RUNNER_SECRET, SETUP_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOKEN_ENCRYPTION_KEY
```

Keep a private copy of `TOKEN_ENCRYPTION_KEY`. Without it, stored Meta tokens cannot be decrypted.

If a value is wrong the app refuses to start and the log names each bad key, for example
`META_REDIRECT_URI: must be on APP_ORIGIN`.

## 4. Start and run Setup

Start the app, then open `https://proads.smenterpriserl1987.com`. You land on **Setup**:

1. Enter the `SETUP_TOKEN`, press **Install database**.
2. Fill in business name, your name, email and a password of 12+ characters, press **Create Super Admin and sign in**.

Setup refuses to run again once a user exists.

## 5. Add the cron job

Follow [SCHEDULER.md](SCHEDULER.md). Until the cron job runs, a yellow banner says background jobs are not running.

## 6. Check System Health

Open **System Health**. Each check shows what it proved: *Live check* (tested just now), *Config only*
(settings look right, not tested live), or *Not configured*.

## Checks after each deploy

- `GET /healthz` returns `{"ok":true}` (process is up)
- `GET /readyz` returns 200 only when the database is reachable and the schema is current
- System Health shows the scheduler as **Running** within two minutes

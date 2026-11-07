# Background scheduler

Account sync, token checks, publishing jobs and reports run from a MySQL job queue. Something has to
"tick" the queue every minute. The app does this two ways:

1. **External cron (required).** Calls `POST /internal/tick` every minute. This keeps working when the Node
   process has been idle or restarted.
2. **In-process loop (helper).** While the app is awake it ticks every 10 seconds (`IN_PROCESS_WORKER=true`).

A database lease makes sure only one tick runs at a time, so running both is safe.

## Hostinger cron job

hPanel → Advanced → Cron Jobs → Custom. Schedule: every minute (`* * * * *`). Command:

```bash
curl -fsS -m 55 -X POST -H "Authorization: Bearer YOUR_JOB_RUNNER_SECRET" -H "X-Tick-Source: hostinger" https://proads.smenterpriserl1987.com/internal/tick > /dev/null
```

Replace `YOUR_JOB_RUNNER_SECRET` with the same value you set in the app's environment.

## Optional second trigger: Cloudflare Cron

If the domain is on Cloudflare, a Worker with a `* * * * *` Cron Trigger can make the same request with
`X-Tick-Source: cloudflare`. Two triggers give redundancy; the lease prevents double work.

## How to tell it works

- **System Health → Scheduler** shows *Running* and "Last run Ns ago".
- **Test the cron** on that card queues a small test job. If it completes without you pressing **Run now**, ticks are arriving. The "Recent ticks" table shows the source of each tick (`hostinger`, `cloudflare` or `in_process`).
- If no tick has succeeded for 3 minutes the state turns *Stopped* and every page shows a banner.
- Jobs more than 2 minutes past their due time are counted as *Overdue*.

## Responses from `/internal/tick`

| Status | Meaning |
| --- | --- |
| 200 | Tick ran, or another tick held the lease (the body has `skippedReason`) |
| 401 `TICK_UNAUTHORIZED` | Wrong or missing `Authorization: Bearer` value |
| 503 `SCHEMA_NOT_INSTALLED` | Setup has not installed the database yet, or an upgrade is pending |

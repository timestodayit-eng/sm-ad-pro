import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { execute, query, queryOne } from '../db/pool.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { requirePermission } from '../auth/sessions.js';
import { cancelJob, enqueue, QUEUES, retryJob } from '../jobs/queue.js';
import { recordRefusedTick, schedulerHealth, schedulerSchemaReady, tick } from '../jobs/scheduler.js';
import { db } from '../db/pool.js';
import { schemaStatus } from '../db/migrations.js';
import { audit } from '../services/audit.js';
import { runHealthChecks } from '../services/health.js';
export const opsRouter = Router();
opsRouter.get('/health', requirePermission('health.read'), asyncHandler(async (_req, res) => res.json(await runHealthChecks())));
opsRouter.get('/jobs/scheduler', requirePermission('jobs.read'), asyncHandler(async (_req, res) => res.json(await schedulerHealth())));
opsRouter.get('/jobs', requirePermission('jobs.read'), asyncHandler(async (req, res) => {
    const q = parse(z.object({
        status: z.enum(['queued', 'running', 'succeeded', 'failed', 'needs_review', 'dead', 'cancelled']).optional(),
        queue: z.enum(QUEUES).optional(),
        page: z.coerce.number().int().min(1).default(1),
    }), req.query);
    const size = 50;
    const rows = await query(`SELECT id, queue, type, status, priority, attempts, max_attempts, run_after, locked_by, lease_until, last_error, created_at, finished_at,
              (status='queued' AND run_after < CURRENT_TIMESTAMP(3) - INTERVAL 120 SECOND) AS overdue
         FROM jobs WHERE (? IS NULL OR status=?) AND (? IS NULL OR queue=?)
        ORDER BY id DESC LIMIT ? OFFSET ?`, [q.status ?? null, q.status ?? null, q.queue ?? null, q.queue ?? null, size + 1, (q.page - 1) * size]);
    res.json({
        items: rows.slice(0, size).map((r) => ({ ...r, overdue: Boolean(Number(r.overdue)), last_error: typeof r.last_error === 'string' ? JSON.parse(r.last_error) : r.last_error })),
        hasMore: rows.length > size,
        page: q.page,
    });
}));
opsRouter.post('/jobs/:id/retry', requirePermission('jobs.manage', 'retry jobs'), asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    if (!(await retryJob(id)))
        throw new AppError({ code: 'JOB_NOT_RETRYABLE', message: 'Only failed, dead or needs-review jobs can be retried.', status: 409, category: 'conflict' });
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'job.retried', targetType: 'job', targetId: id, ip: req.ip });
    res.json({ ok: true });
}));
opsRouter.post('/jobs/:id/cancel', requirePermission('jobs.manage', 'cancel jobs'), asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    if (!(await cancelJob(id)))
        throw new AppError({ code: 'JOB_NOT_CANCELLABLE', message: 'This job is running or already finished.', status: 409, category: 'conflict' });
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'job.cancelled', targetType: 'job', targetId: id, ip: req.ip });
    res.json({ ok: true });
}));
/** Manual "process now" (bug 4). Runs one tick in the request, bounded to 20 s. */
opsRouter.post('/jobs/run-now', requirePermission('jobs.manage', 'run the scheduler manually'), asyncHandler(async (req, res) => {
    const result = await tick('manual', { budgetMs: 20_000 });
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'scheduler.manual_tick', details: { ...result }, ip: req.ip });
    res.json(result);
}));
/** Enqueues a no-op probe job. If it reaches "succeeded" without anyone clicking run-now, the cron scheduler works (bug 5). */
opsRouter.post('/jobs/probe', requirePermission('jobs.manage', 'test the scheduler'), asyncHandler(async (req, res) => {
    const id = await enqueue({ queue: 'maintenance', type: 'system.probe', payload: { requestedBy: req.user.id }, priority: 10 });
    res.status(201).json({ jobId: id });
}));
opsRouter.get('/dashboard/summary', asyncHandler(async (req, res) => {
    const u = req.user;
    const scope = u.allAccounts || ['super_admin', 'admin'].includes(u.role);
    const accounts = await queryOne(`SELECT COUNT(*) AS total, SUM(a.account_status=1) AS active, SUM(a.account_status<>1) AS inactive, MAX(a.last_synced_at) AS last_sync,
              COUNT(DISTINCT a.currency) AS currencies
         FROM meta_ad_accounts a
        WHERE a.org_id=? AND a.is_enabled=1 ${scope ? '' : 'AND a.id IN (SELECT ad_account_row_id FROM user_account_access WHERE user_id=?)'}`, scope ? [u.orgId] : [u.orgId, u.id]);
    const connections = await query(`SELECT status, COUNT(*) AS n FROM meta_connections WHERE org_id=? GROUP BY status`, [u.orgId]);
    const sched = await schedulerHealth();
    const unread = await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE org_id=? AND (user_id IS NULL OR user_id=?) AND read_at IS NULL`, [u.orgId, u.id]);
    res.json({
        accounts: {
            total: Number(accounts?.total ?? 0),
            active: Number(accounts?.active ?? 0),
            inactive: Number(accounts?.inactive ?? 0),
            currencies: Number(accounts?.currencies ?? 0),
            lastSync: accounts?.last_sync ?? null,
        },
        connections: Object.fromEntries(connections.map((c) => [c.status, Number(c.n)])),
        scheduler: { state: sched.state, lastSuccessAt: sched.lastSuccessAt, warnings: sched.warnings, overdue: sched.queue.overdue, failed: sched.queue.failed },
        notificationsUnread: Number(unread?.n ?? 0),
        // Performance metrics come from synced Meta Insights (Phase 6). Until then the API says so instead of returning zeros.
        performance: { available: false, reason: 'Insights sync is not built yet (Phase 6). No spend or results are shown until real data is synced.' },
    });
}));
opsRouter.get('/notifications', asyncHandler(async (req, res) => {
    const rows = await query(`SELECT id, severity, category, title, body, link, read_at, created_at FROM notifications
        WHERE org_id=? AND (user_id IS NULL OR user_id=?) ORDER BY id DESC LIMIT 100`, [req.user.orgId, req.user.id]);
    res.json({ items: rows });
}));
opsRouter.post('/notifications/read-all', asyncHandler(async (req, res) => {
    await execute(`UPDATE notifications SET read_at=CURRENT_TIMESTAMP(3) WHERE org_id=? AND (user_id IS NULL OR user_id=?) AND read_at IS NULL`, [req.user.orgId, req.user.id]);
    res.json({ ok: true });
}));
/** External cron entry point. Bearer JOB_RUNNER_SECRET only; never reachable with a browser session. */
export const internalRouter = Router();
let lastUnauthorizedNote = 0;
internalRouter.post('/tick', asyncHandler(async (req, res) => {
    const auth = req.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const src = (req.get('x-tick-source') ?? 'cron').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'cron';
    if (!token || !safeEqual(token, env().JOB_RUNNER_SECRET)) {
        // At most once a minute, so a stranger hammering this URL cannot fill the table.
        if (Date.now() - lastUnauthorizedNote > 60_000) {
            lastUnauthorizedNote = Date.now();
            await recordRefusedTick(src, 'unauthorized', `A ${src} tick was refused: the Authorization secret does not match JOB_RUNNER_SECRET.`);
        }
        throw new AppError({ code: 'TICK_UNAUTHORIZED', message: 'Invalid scheduler secret.', status: 401, category: 'auth', hint: 'The cron job must send "Authorization: Bearer <JOB_RUNNER_SECRET>".' });
    }
    if (!(await schedulerSchemaReady())) {
        const st = await schemaStatus(db()).catch(() => null);
        if (st && st.current > 0)
            await recordRefusedTick(src, 'schema_pending', `A ${src} tick was refused: the database upgrade is not complete (${st.failed.length ? `failed: ${st.failed.map((f) => f.version).join(', ')}` : `not applied: ${st.pending.map((p) => p.version).join(', ')}`}).`);
        throw new AppError({ code: 'SCHEMA_NOT_INSTALLED', message: 'The database is not installed or needs an upgrade.', status: 503, category: 'schema', hint: 'Open the panel and finish Setup, or apply pending upgrades in Settings → Database.' });
    }
    const source = parse(z.string().regex(/^[a-z0-9_-]{1,32}$/).default('cron'), req.get('x-tick-source') ?? undefined);
    res.json(await tick(source));
}));
//# sourceMappingURL=ops.js.map
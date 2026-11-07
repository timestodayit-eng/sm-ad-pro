import { env, features } from '../config/env.js';
import { db, describeDbError, query, queryOne } from '../db/pool.js';
import { schemaStatus } from '../db/migrations.js';
import { schedulerHealth } from '../jobs/scheduler.js';
import { lastDiagnostic } from '../routes/media.js';
import { headBucket } from './storage.js';
const now = () => new Date().toISOString();
export async function runHealthChecks() {
    const checks = [];
    const f = features();
    // Database
    let dbOk = false;
    try {
        const t0 = Date.now();
        await db().query('SELECT 1');
        dbOk = true;
        checks.push({ id: 'db.connection', group: 'database', label: 'Database connection', status: 'pass', evidence: 'live', message: `Connected in ${Date.now() - t0} ms.`, checkedAt: now() });
    }
    catch (err) {
        const d = describeDbError(err);
        checks.push({ id: 'db.connection', group: 'database', label: 'Database connection', status: 'fail', evidence: 'live', message: d.message, hint: d.hint, checkedAt: now() });
    }
    if (dbOk) {
        const s = await schemaStatus(db());
        checks.push({
            id: 'db.schema',
            group: 'database',
            label: 'Schema version',
            status: s.upToDate ? 'pass' : 'fail',
            evidence: 'live',
            message: s.upToDate ? `Schema v${s.current} matches this build.` : `Schema v${s.current}, build needs v${s.required}. Pending: ${s.pending.map((p) => p.name).join(', ') || 'none'}${s.failed.length ? `; failed: ${s.failed.map((x) => x.name).join(', ')}` : ''}.`,
            hint: s.upToDate ? undefined : 'Open Settings > Database and click "Apply pending migrations" (Super Admin), or run npm run migrate.',
            checkedAt: now(),
        });
        const pool = db().pool;
        const total = pool?._allConnections?.length ?? null;
        const free = pool?._freeConnections?.length ?? null;
        checks.push({ id: 'db.pool', group: 'database', label: 'Connection pool', status: 'pass', evidence: 'live', message: total != null ? `${total} open, ${free} idle, limit ${env().DB_POOL_SIZE}.` : `Limit ${env().DB_POOL_SIZE}.`, checkedAt: now() });
    }
    // Meta
    if (!f.meta) {
        checks.push({ id: 'meta.config', group: 'meta', label: 'Meta app configuration', status: 'not_configured', evidence: 'none', message: 'META_APP_ID, META_APP_SECRET, META_API_VERSION or META_REDIRECT_URI is missing.', hint: 'See docs/META_SETUP.md.', checkedAt: now() });
    }
    else {
        checks.push({ id: 'meta.config', group: 'meta', label: 'Meta app configuration', status: f.metaLoginForBusiness ? 'pass' : 'warn', evidence: 'config', message: `API ${env().META_API_VERSION}, redirect ${env().META_REDIRECT_URI}.${f.metaLoginForBusiness ? '' : ' META_CONFIG_ID not set: classic Facebook Login scopes will be used.'}`, checkedAt: now() });
        if (dbOk) {
            const conns = await query(`SELECT status, COUNT(*) AS n, MIN(token_expires_at) AS soonest FROM meta_connections GROUP BY status`);
            const active = conns.find((c) => c.status === 'active');
            const bad = conns.filter((c) => c.status !== 'active').reduce((a, c) => a + Number(c.n), 0);
            const soon = active?.soonest ? new Date(active.soonest) : null;
            const days = soon ? Math.floor((soon.getTime() - Date.now()) / 86400_000) : null;
            checks.push({
                id: 'meta.tokens',
                group: 'meta',
                label: 'Meta connections and tokens',
                status: !active ? 'warn' : bad ? 'fail' : days != null && days < 7 ? 'warn' : 'pass',
                evidence: 'live',
                message: !active ? 'No Meta connection yet. Connect Meta from Ad Accounts.' : `${active.n} active connection(s)${bad ? `, ${bad} need reconnecting` : ''}${days != null ? `; earliest token expiry in ${days} day(s)` : ''}.`,
                checkedAt: now(),
            });
            const acc = await queryOne(`SELECT COUNT(*) AS n, MAX(last_synced_at) AS last FROM meta_ad_accounts`);
            checks.push({ id: 'meta.accounts', group: 'meta', label: 'Ad accounts imported', status: Number(acc?.n) ? 'pass' : 'warn', evidence: 'live', message: Number(acc?.n) ? `${acc.n} account(s); last sync ${acc.last ? new Date(acc.last).toISOString() : 'never'}.` : 'No ad accounts imported yet.', checkedAt: now() });
        }
    }
    // Storage
    if (!f.r2) {
        checks.push({ id: 'storage.config', group: 'storage', label: 'Cloudflare R2 configuration', status: 'not_configured', evidence: 'none', message: 'R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is missing.', hint: 'See docs/R2_SETUP.md.', checkedAt: now() });
    }
    else {
        try {
            const t0 = Date.now();
            await headBucket();
            checks.push({ id: 'storage.bucket', group: 'storage', label: 'R2 bucket access', status: 'pass', evidence: 'live', message: `Bucket ${env().R2_BUCKET} reachable with these credentials in ${Date.now() - t0} ms.`, checkedAt: now() });
        }
        catch (err) {
            checks.push({ id: 'storage.bucket', group: 'storage', label: 'R2 bucket access', status: 'fail', evidence: 'live', message: `${err?.code ?? 'R2_ERROR'}: ${err?.message ?? err}`, hint: err?.hint, checkedAt: now() });
        }
        const d = dbOk ? await lastDiagnostic().catch(() => null) : null;
        const fresh = d && Date.now() - new Date(d.at).getTime() < 7 * 86400_000;
        if (!d || d.browserPut == null) {
            checks.push({ id: 'storage.browser', group: 'storage', label: 'Browser uploads (CORS)', status: 'warn', evidence: 'none', message: 'Not tested yet.', hint: 'Open Media Library and press "Check storage connection".', checkedAt: now() });
        }
        else if (d.browserPut && d.browserEtag && d.serverSawObject) {
            checks.push({ id: 'storage.browser', group: 'storage', label: 'Browser uploads (CORS)', status: fresh ? 'pass' : 'warn', evidence: 'verified', message: `A browser uploaded a test file to R2 and the server confirmed it (${d.at}).${fresh ? '' : ' Older than 7 days; run the check again.'}`, checkedAt: d.at });
        }
        else {
            checks.push({ id: 'storage.browser', group: 'storage', label: 'Browser uploads (CORS)', status: 'fail', evidence: 'verified', message: `${d.error?.code ?? 'FAILED'}: ${d.error?.message ?? 'The browser test failed.'}`, hint: d.error?.hint, checkedAt: d.at });
        }
    }
    // Jobs
    if (dbOk) {
        const s = await schedulerHealth();
        checks.push({
            id: 'jobs.scheduler',
            group: 'jobs',
            label: 'Scheduler',
            status: s.state === 'running' ? 'pass' : 'fail',
            evidence: 'live',
            message: s.state === 'running' ? `Last successful tick ${s.secondsSinceLastSuccess}s ago (source: ${s.lastSource}).` : s.state === 'never_started' ? 'SCHEDULER_NOT_STARTED: no tick has ever completed.' : `Stale: last successful tick ${Math.round((s.secondsSinceLastSuccess ?? 0) / 60)} min ago.`,
            hint: s.state === 'running' ? undefined : 'Create the every-minute cron job from docs/SCHEDULER.md and check JOB_RUNNER_SECRET matches.',
            checkedAt: now(),
        });
        checks.push({
            id: 'jobs.queue',
            group: 'jobs',
            label: 'Job queue',
            status: s.queue.overdue ? 'fail' : s.queue.failed ? 'warn' : 'pass',
            evidence: 'live',
            message: `${s.queue.waiting} waiting, ${s.queue.running} running, ${s.queue.overdue} overdue, ${s.queue.failed} failed/needs review.`,
            checkedAt: now(),
        });
    }
    // AI
    checks.push(f.openai
        ? { id: 'ai.config', group: 'ai', label: 'OpenAI configuration', status: 'pass', evidence: 'config', message: `Model ${env().OPENAI_MODEL}. Live model and tool-calling checks arrive with the AI Copilot milestone.`, checkedAt: now() }
        : { id: 'ai.config', group: 'ai', label: 'OpenAI configuration', status: 'not_configured', evidence: 'none', message: 'OPENAI_API_KEY or OPENAI_MODEL is missing.', checkedAt: now() });
    // Publishing
    checks.push({
        id: 'publishing.engine',
        group: 'publishing',
        label: 'Publishing engine',
        status: 'not_implemented',
        evidence: 'none',
        message: `Not built yet (Phase 3). PUBLISH_ENABLED=${env().PUBLISH_ENABLED}, ACTIVATION_ENABLED=${env().ACTIVATION_ENABLED}. No live publishing has been verified.`,
        checkedAt: now(),
    });
    const order = ['fail', 'warn', 'not_configured', 'not_implemented', 'pass'];
    const overall = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
    checks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return { overall, checks };
}
//# sourceMappingURL=health.js.map
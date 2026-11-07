import { features } from '../config/env.js';
import { abortMultipart } from '../services/storage.js';
import { execute, query } from '../db/pool.js';
import { inspectToken, decryptConnectionToken, syncConnection } from '../meta/connections.js';
import { MetaApiError } from '../meta/graph.js';
import { syncManagedAccounts } from '../meta/live.js';
import { runLaunchItem } from '../services/launch.js';
import { enqueue } from './queue.js';
import { JobError, registerHandler } from './scheduler.js';
function metaFailure(err) {
    if (err instanceof MetaApiError) {
        const kind = err.retryable ? 'transient' : err.meta.class === 'ambiguous' ? 'ambiguous' : 'deterministic';
        return new JobError({ kind, code: err.code, message: err.message, hint: err.hint, details: err.details });
    }
    return err;
}
export function registerCoreHandlers() {
    /** Every 5 minutes: refresh ad accounts and Pages for each active connection. */
    registerHandler('meta.sync_accounts', async (job) => {
        if (!features().meta)
            return; // nothing to do until Meta is configured; health shows "not configured"
        const ids = job.payload?.connectionId
            ? [Number(job.payload.connectionId)]
            : (await query(`SELECT id FROM meta_connections WHERE status IN ('active','error')`)).map((r) => Number(r.id));
        const failures = [];
        for (const id of ids) {
            try {
                await syncConnection(id);
            }
            catch (err) {
                failures.push(`connection ${id}: ${err.message}`);
                if (ids.length === 1)
                    throw metaFailure(err);
            }
        }
        if (failures.length && failures.length === ids.length) {
            throw new JobError({ kind: 'transient', code: 'META_SYNC_ALL_FAILED', message: failures.join('; ').slice(0, 900) });
        }
    });
    /** Every 15 minutes (and on demand): campaigns, ads and daily results for the accounts the panel manages. */
    registerHandler('meta.sync_live', async (job) => {
        if (!features().meta)
            return;
        const ids = Array.isArray(job.payload?.accountIds) ? job.payload.accountIds.map(Number).filter(Number.isFinite) : undefined;
        if (!ids?.length) {
            // The recurring run fans out to one short job per account, so a slow account never outlives its job lease
            // and one failing account does not hold up the others.
            const slot = Math.floor(Date.now() / 600_000);
            const rows = await query(`SELECT a.id FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id
          WHERE a.is_managed=1 AND a.is_enabled=1 AND c.status IN ('active','error')`);
            for (const r of rows) {
                await enqueue({ queue: 'sync', type: 'meta.sync_live', payload: { accountIds: [Number(r.id)] }, dedupeKey: `live:${r.id}:${slot}`, maxAttempts: 3, priority: 60 });
            }
            return;
        }
        const out = await syncManagedAccounts(ids);
        // Rate limits and dead tokens: back off and retry the whole run later instead of hammering Meta.
        if (out.stoppedBy)
            throw metaFailure(out.stoppedBy);
        if (out.failed.length && out.synced === 0) {
            throw new JobError({ kind: 'transient', code: 'META_LIVE_SYNC_FAILED', message: out.failed.map((f) => `account ${f.id}: ${f.error}`).join('; ').slice(0, 900) });
        }
    });
    /** Hourly: check token validity and expiry so the UI can warn before publishing breaks. */
    registerHandler('meta.check_tokens', async () => {
        if (!features().meta)
            return;
        const conns = await query(`SELECT * FROM meta_connections WHERE status <> 'revoked'`);
        for (const c of conns) {
            try {
                const info = await inspectToken(decryptConnectionToken(c));
                const status = !info.valid ? 'expired' : 'active';
                await execute(`UPDATE meta_connections SET status=?, token_expires_at=COALESCE(?, token_expires_at), scopes=?, last_checked_at=CURRENT_TIMESTAMP(3), last_error=? WHERE id=?`, [status, info.expiresAt, info.scopes.join(','), info.valid ? null : 'Token is no longer valid. Reconnect Meta.', c.id]);
                if (!info.valid) {
                    await execute(`INSERT INTO notifications (org_id, severity, category, title, body, link, dedupe_key)
             VALUES (?, 'critical', 'meta', 'Meta connection expired', ?, '/accounts', ?)
             ON DUPLICATE KEY UPDATE id=id`, [c.org_id, `The Meta login for ${c.meta_user_name ?? c.meta_user_id} is no longer valid. Reconnect it to keep syncing and publishing.`, `meta-expired:${c.id}:${new Date().toISOString().slice(0, 10)}`]);
                }
            }
            catch (err) {
                await execute(`UPDATE meta_connections SET last_checked_at=CURRENT_TIMESTAMP(3), last_error=? WHERE id=?`, [String(err.message).slice(0, 1000), c.id]);
            }
        }
    });
    /** Easy Ads: builds one account's campaign, ad set and ad (all PAUSED), one stage at a time. */
    registerHandler('launch.item', (job, ctx) => runLaunchItem(job, ctx));
    registerHandler('maintenance.cleanup_sessions', async () => {
        await execute(`DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP(3)`);
        await execute(`DELETE FROM oauth_states WHERE expires_at < CURRENT_TIMESTAMP(3)`);
        await execute(`DELETE FROM scheduler_heartbeats WHERE started_at < CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY`);
    });
    /** Aborts uploads left unfinished for 6 days, before R2 silently drops them at 7. */
    registerHandler('media.abort_stale_uploads', async () => {
        if (!features().r2)
            return;
        const rows = await query(`SELECT id, object_key, upload_id FROM media_assets WHERE status='uploading' AND created_at < UTC_TIMESTAMP(3) - INTERVAL 6 DAY LIMIT 200`);
        for (const r of rows) {
            if (r.upload_id)
                await abortMultipart(r.object_key, r.upload_id);
            await execute(`UPDATE media_assets SET status='aborted', upload_id=NULL, last_error='Not finished within 6 days.' WHERE id=?`, [r.id]);
        }
    });
    /** Used by the System Health "test the worker" button: proves a job goes queued -> running -> succeeded via the scheduler. */
    registerHandler('system.probe', async () => {
        /* no-op on purpose */
    });
}
//# sourceMappingURL=handlers.js.map
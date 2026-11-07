import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { findings } from '../ai/findings.js';
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1, good: 0 };
/**
 * Monitoring: the same findings AI Analytics computes, run on a schedule (every 30 minutes) for every
 * organisation, turned into Notifications once a day per finding, plus the two things that break a panel
 * silently: a Meta login about to expire and an account whose sync has gone stale.
 */
export const ALL_KINDS = ['spend_spike', 'stalled_delivery', 'spend_no_results', 'cost_per_result_high', 'low_balance', 'rejected_ads', 'launch_failed', 'sync_error', 'not_synced', 'stale_sync', 'token_expiring'];
export const KIND_LABEL = {
    spend_spike: 'Spend spike', stalled_delivery: 'Stalled delivery', spend_no_results: 'Spend with no results', cost_per_result_high: 'Expensive results', low_balance: 'Low balance',
    rejected_ads: 'Rejected ads', launch_failed: 'Failed launch', sync_error: 'Sync error', not_synced: 'Account not synced', stale_sync: 'Sync stopped', token_expiring: 'Meta login expiring',
};
export const settingsInput = z.object({
    enabled: z.boolean().default(true),
    minSeverity: z.enum(['info', 'warning', 'critical']).default('warning'),
    kinds: z.array(z.enum(ALL_KINDS)).default([...ALL_KINDS]),
    staleSyncMinutes: z.number().int().min(30).max(10_080).default(120),
    tokenDaysWarning: z.number().int().min(1).max(60).default(7),
});
export async function getSettings(orgId) {
    const r = await queryOne(`SELECT * FROM monitor_settings WHERE org_id=?`, [orgId]);
    if (!r)
        return settingsInput.parse({});
    const kinds = r.kinds == null ? [...ALL_KINDS] : typeof r.kinds === 'string' ? JSON.parse(r.kinds) : r.kinds;
    return settingsInput.parse({ enabled: Boolean(r.is_enabled), minSeverity: r.min_severity, kinds, staleSyncMinutes: Number(r.stale_sync_minutes), tokenDaysWarning: Number(r.token_days_warning) });
}
export async function saveSettings(user, s) {
    await execute(`INSERT INTO monitor_settings (org_id, is_enabled, min_severity, kinds, stale_sync_minutes, token_days_warning, updated_by) VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE is_enabled=VALUES(is_enabled), min_severity=VALUES(min_severity), kinds=VALUES(kinds), stale_sync_minutes=VALUES(stale_sync_minutes), token_days_warning=VALUES(token_days_warning), updated_by=VALUES(updated_by)`, [user.orgId, s.enabled ? 1 : 0, s.minSeverity, JSON.stringify(s.kinds), s.staleSyncMinutes, s.tokenDaysWarning, user.id]);
}
/** Connections and accounts checked without the model: expiring logins and stale syncs. */
export async function systemChecks(orgId, s, now = new Date()) {
    const out = [];
    const conns = await query(`SELECT id, meta_user_name, meta_user_id, token_expires_at, status, last_error FROM meta_connections WHERE org_id=? AND status<>'revoked'`, [orgId]);
    for (const c of conns) {
        const who = c.meta_user_name ?? c.meta_user_id;
        if (c.status === 'expired')
            out.push({ key: `token_expired:${c.id}`, kind: 'token_expiring', severity: 'critical', confidence: 'high', accountRowId: null, accountName: null, title: `Meta login for ${who} has expired`, detail: 'Nothing syncs or publishes until it is reconnected.', evidence: { connection: who }, causes: ['Password changed', 'Meta security check', 'Token older than 60 days'], suggestion: 'Reconnect Meta from Ad Accounts.', link: '/accounts' });
        else if (c.token_expires_at) {
            const days = (new Date(c.token_expires_at).getTime() - now.getTime()) / 86_400_000;
            if (days <= s.tokenDaysWarning)
                out.push({ key: `token_expiring:${c.id}`, kind: 'token_expiring', severity: days <= 2 ? 'critical' : 'warning', confidence: 'high', accountRowId: null, accountName: null, title: `Meta login for ${who} expires in ${Math.max(0, Math.round(days))} day${Math.round(days) === 1 ? '' : 's'}`, detail: `Expires ${new Date(c.token_expires_at).toISOString().slice(0, 10)}. Syncing and publishing stop when it does.`, evidence: { daysLeft: Math.round(days * 10) / 10, expiresAt: new Date(c.token_expires_at).toISOString() }, causes: [], suggestion: 'Reconnect Meta from Ad Accounts before it expires.', link: '/accounts' });
        }
    }
    const accounts = await query(`SELECT id, name, live_synced_at, live_full_synced_at, live_sync_error FROM meta_ad_accounts WHERE org_id=? AND is_managed=1 AND is_enabled=1`, [orgId]);
    for (const a of accounts) {
        if (!a.live_full_synced_at)
            continue; // never synced: AI Analytics already reports not_synced
        const age = (now.getTime() - new Date(a.live_synced_at ?? a.live_full_synced_at).getTime()) / 60_000;
        if (age > s.staleSyncMinutes)
            out.push({ key: `stale_sync:${a.id}`, kind: 'stale_sync', severity: age > s.staleSyncMinutes * 4 ? 'critical' : 'warning', confidence: 'high', accountRowId: Number(a.id), accountName: a.name, title: `Sync stopped for ${a.name}`, detail: `Last synced ${Math.round(age)} minutes ago${a.live_sync_error ? `: ${a.live_sync_error}` : '.'}`, evidence: { minutesSinceSync: Math.round(age), limit: s.staleSyncMinutes }, causes: ['Scheduler not running', 'Meta rate limit', 'Connection error'], suggestion: 'Check System Health and the scheduler; the numbers on every page are as old as this sync.', link: '/health' });
    }
    return out;
}
/** One scan for one organisation: computes findings, writes one notification per finding per day. */
export async function scanOrg(orgId, now = new Date()) {
    const s = await getSettings(orgId);
    const runId = (await execute(`INSERT INTO monitor_runs (org_id, started_at) VALUES (?, ?)`, [orgId, now])).insertId;
    try {
        const user = { id: 0, orgId, role: 'admin', allAccounts: true };
        const f = await findings(user, '7d');
        const all = [...f.findings, ...(await systemChecks(orgId, s, now))];
        const day = now.toISOString().slice(0, 10);
        let alerts = 0;
        if (s.enabled) {
            for (const x of all) {
                if (!s.kinds.includes(x.kind) || (SEVERITY_RANK[x.severity] ?? 0) < SEVERITY_RANK[s.minSeverity])
                    continue;
                const key = `monitor:${orgId}:${x.key}:${day}`.slice(0, 190);
                if (await queryOne(`SELECT id FROM notifications WHERE dedupe_key=?`, [key]))
                    continue;
                await execute(`INSERT INTO notifications (org_id, severity, category, title, body, link, dedupe_key) VALUES (?,?,'monitoring',?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [orgId, x.severity === 'critical' ? 'critical' : 'warning', x.title.slice(0, 255), `${x.detail}${x.suggestion ? ` ${x.suggestion}` : ''}`.slice(0, 2000), x.link ?? '/monitoring', key]);
                alerts++;
            }
        }
        const summary = { bySeverity: Object.fromEntries(['critical', 'warning', 'info', 'good'].map((sv) => [sv, all.filter((x) => x.severity === sv).length])), kinds: Object.fromEntries(ALL_KINDS.map((k) => [k, all.filter((x) => x.kind === k).length])) };
        await execute(`UPDATE monitor_runs SET finished_at=CURRENT_TIMESTAMP(3), accounts=?, findings=?, alerts=?, summary=? WHERE id=?`, [f.accounts, all.length, alerts, JSON.stringify(summary), runId]);
        return { runId, accounts: f.accounts, findings: all, alerts };
    }
    catch (err) {
        await execute(`UPDATE monitor_runs SET finished_at=CURRENT_TIMESTAMP(3), error=? WHERE id=?`, [String(err?.message ?? err).slice(0, 1000), runId]);
        throw err;
    }
}
/** The scheduled job: every organisation in turn; one failing org never stops the others. */
export async function scanAll() {
    const orgs = await query(`SELECT id FROM orgs`);
    for (const o of orgs) {
        try {
            await scanOrg(Number(o.id));
        }
        catch (err) {
            logger.warn({ orgId: o.id, err: err?.message }, 'monitor scan failed');
        }
    }
}
export async function recentRuns(orgId, limit = 20) {
    const rows = await query(`SELECT * FROM monitor_runs WHERE org_id=? ORDER BY id DESC LIMIT ?`, [orgId, limit]);
    return rows.map((r) => ({ id: Number(r.id), startedAt: r.started_at, finishedAt: r.finished_at, accounts: Number(r.accounts), findings: Number(r.findings), alerts: Number(r.alerts), summary: typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary, error: r.error }));
}
export async function connectionsStatus(orgId) {
    const rows = await query(`SELECT id, meta_user_name, meta_user_id, token_expires_at, status, last_checked_at, last_error, scopes FROM meta_connections WHERE org_id=? ORDER BY id`, [orgId]);
    return rows.map((c) => ({ id: Number(c.id), name: c.meta_user_name ?? c.meta_user_id, status: c.status, expiresAt: c.token_expires_at, checkedAt: c.last_checked_at, error: c.last_error, scopes: String(c.scopes ?? '').split(',').filter(Boolean) }));
}
//# sourceMappingURL=monitoring.js.map
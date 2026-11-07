import { Router } from 'express';
import { z } from 'zod';
import { features } from '../config/env.js';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError, errors } from '../lib/errors.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { requirePermission } from '../auth/sessions.js';
import { enqueue } from '../jobs/queue.js';
import { accountToday, addDays, adPreviewUrl, minorToMajor, RESULT_LABELS } from '../meta/live.js';
import { audit } from '../services/audit.js';
import { costAlertsToday, METRICS } from '../services/costAlerts.js';
import { accountScope } from './meta.js';
export const liveRouter = Router();
const periodSchema = z.enum(['today', 'yesterday', '7d', '30d']).default('7d');
/** Date range in the account's own time zone, inclusive, the way Ads Manager shows it. */
export function periodRange(period, timezone, now = new Date()) {
    const today = accountToday(timezone, now);
    switch (period) {
        case 'today':
            return { since: today, until: today };
        case 'yesterday':
            return { since: addDays(today, -1), until: addDays(today, -1) };
        case '7d':
            return { since: addDays(today, -6), until: today };
        case '30d':
            return { since: addDays(today, -29), until: today };
    }
}
const emptyTotals = () => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, calls: 0, messages: 0, results: new Map() });
function addRow(t, r) {
    t.spend += Number(r.spend ?? 0);
    t.impressions += Number(r.impressions ?? 0);
    t.clicks += Number(r.clicks ?? 0);
    t.linkClicks += Number(r.link_clicks ?? 0);
    t.leads += Number(r.leads ?? 0);
    t.calls += Number(r.calls ?? 0);
    t.messages += Number(r.messages ?? 0);
}
/** Ratios are null when the denominator is zero: "no data" is not the same as "0". */
function metrics(t) {
    const results = [...t.results.entries()]
        .map(([type, count]) => ({ type, label: RESULT_LABELS[type] ?? type, count, costPer: count > 0 ? t.spend / count : null }))
        .sort((a, b) => b.count - a.count);
    return {
        spend: round(t.spend),
        impressions: t.impressions,
        clicks: t.clicks,
        linkClicks: t.linkClicks,
        // Counted whatever the objective, so a Leads campaign that also gets calls shows both.
        contacts: {
            leads: { count: t.leads, costPer: t.leads ? round(t.spend / t.leads, 4) : null },
            calls: { count: t.calls, costPer: t.calls ? round(t.spend / t.calls, 4) : null },
            messages: { count: t.messages, costPer: t.messages ? round(t.spend / t.messages, 4) : null },
        },
        ctr: t.impressions ? round((t.clicks / t.impressions) * 100, 4) : null,
        cpc: t.linkClicks ? round(t.spend / t.linkClicks, 4) : null,
        cpm: t.impressions ? round((t.spend / t.impressions) * 1000, 4) : null,
        results,
    };
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
async function managedAccounts(user, onlyId) {
    const scope = accountScope(user);
    return query(`SELECT a.id, a.account_id, a.name, a.currency, a.timezone_name, a.account_status, a.business_name, a.live_synced_at,
            a.live_full_synced_at, a.live_sync_error, c.status AS connection_status
       FROM meta_ad_accounts a JOIN meta_connections c ON c.id=a.connection_id
      WHERE ${scope.sql} AND a.is_managed=1 AND a.is_enabled=1 ${onlyId ? 'AND a.id=?' : ''}
      ORDER BY a.name`, onlyId ? [...scope.params, onlyId] : scope.params);
}
/** Active daily budget per account: campaign budgets (CBO) plus ad set budgets in campaigns without one. Minor units. */
async function activeDailyBudgets(ids) {
    const out = new Map();
    if (!ids.length)
        return out;
    const rows = await query(`SELECT ad_account_row_id AS id, SUM(daily_budget_minor) AS b FROM meta_campaigns
      WHERE ad_account_row_id IN (?) AND effective_status='ACTIVE' AND daily_budget_minor IS NOT NULL GROUP BY ad_account_row_id
     UNION ALL
     SELECT s.ad_account_row_id AS id, SUM(s.daily_budget_minor) AS b FROM meta_adsets s
       JOIN meta_campaigns c ON c.ad_account_row_id=s.ad_account_row_id AND c.campaign_id=s.campaign_id
      WHERE s.ad_account_row_id IN (?) AND s.effective_status='ACTIVE' AND s.daily_budget_minor IS NOT NULL
        AND c.daily_budget_minor IS NULL AND c.lifetime_budget_minor IS NULL
      GROUP BY s.ad_account_row_id`, [ids, ids]);
    for (const r of rows)
        out.set(Number(r.id), (out.get(Number(r.id)) ?? 0) + Number(r.b ?? 0));
    return out;
}
liveRouter.get('/live/overview', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
    const period = parse(periodSchema, req.query.period);
    const accounts = await managedAccounts(req.user);
    const scope = accountScope(req.user);
    const available = await queryOne(`SELECT COUNT(*) AS n FROM meta_ad_accounts a WHERE ${scope.sql} AND a.is_enabled=1`, scope.params);
    const base = { period, metaConfigured: features().meta, availableCount: Number(available?.n ?? 0), managedCount: accounts.length };
    if (!accounts.length)
        return res.json({ ...base, accounts: [], totalsByCurrency: [] });
    const ids = accounts.map((a) => Number(a.id));
    const floor = addDays(new Date().toISOString().slice(0, 10), -32);
    const daily = await query(`SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m-%d') AS d, SUM(spend) AS spend, SUM(impressions) AS impressions,
              SUM(clicks) AS clicks, SUM(link_clicks) AS link_clicks,
              SUM(leads) AS leads, SUM(calls) AS calls, SUM(messages) AS messages
         FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date >= ?
        GROUP BY ad_account_row_id, date`, [ids, floor]);
    const resultsDaily = await query(`SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m-%d') AS d, result_type, SUM(results) AS n
         FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date >= ? AND result_type IS NOT NULL
        GROUP BY ad_account_row_id, date, result_type`, [ids, floor]);
    const counts = await query(`SELECT ad_account_row_id AS id, 'campaign' AS k, SUM(effective_status='ACTIVE') AS active, COUNT(*) AS total, 0 AS disapproved
         FROM meta_campaigns WHERE ad_account_row_id IN (?) GROUP BY ad_account_row_id
       UNION ALL
       SELECT ad_account_row_id, 'ad', SUM(effective_status='ACTIVE'), COUNT(*), SUM(effective_status='DISAPPROVED')
         FROM meta_ads WHERE ad_account_row_id IN (?) GROUP BY ad_account_row_id`, [ids, ids]);
    const budgets = await activeDailyBudgets(ids);
    const alerts = await costAlertsToday(accounts.map((a) => ({ id: Number(a.id), timezone_name: a.timezone_name })));
    const byCurrency = new Map();
    const items = accounts.map((a) => {
        const id = Number(a.id);
        const { since, until } = periodRange(period, a.timezone_name);
        const synced = !!a.live_full_synced_at;
        const t = emptyTotals();
        const spark = new Map();
        for (const r of daily) {
            if (Number(r.id) !== id)
                continue;
            if (r.d >= addDays(until, -29) && r.d <= until)
                spark.set(r.d, Number(r.spend));
            if (r.d >= since && r.d <= until)
                addRow(t, r);
        }
        for (const r of resultsDaily)
            if (Number(r.id) === id && r.d >= since && r.d <= until)
                t.results.set(r.result_type, (t.results.get(r.result_type) ?? 0) + Number(r.n));
        const c = counts.find((x) => Number(x.id) === id && x.k === 'campaign');
        const ad = counts.find((x) => Number(x.id) === id && x.k === 'ad');
        const budgetMinor = budgets.get(id) ?? 0;
        if (synced) {
            const cur = byCurrency.get(a.currency) ?? { ...emptyTotals(), accounts: 0, dailyBudget: 0 };
            cur.spend += t.spend;
            cur.impressions += t.impressions;
            cur.clicks += t.clicks;
            cur.linkClicks += t.linkClicks;
            cur.accounts++;
            cur.leads += t.leads;
            cur.calls += t.calls;
            cur.messages += t.messages;
            cur.dailyBudget += minorToMajor(budgetMinor, a.currency) ?? 0;
            for (const [k, v] of t.results)
                cur.results.set(k, (cur.results.get(k) ?? 0) + v);
            byCurrency.set(a.currency, cur);
        }
        return {
            id, accountId: a.account_id, name: a.name, currency: a.currency, timezone: a.timezone_name, accountStatus: a.account_status,
            businessName: a.business_name, connectionStatus: a.connection_status,
            syncedAt: a.live_synced_at, syncError: a.live_sync_error, range: { since, until },
            // Never synced: say so instead of showing zeros.
            metrics: synced ? metrics(t) : null,
            dailySpend: synced ? Array.from({ length: 30 }, (_, i) => { const d = addDays(until, i - 29); return { date: d, spend: spark.get(d) ?? 0 }; }) : null,
            campaigns: { active: Number(c?.active ?? 0), total: Number(c?.total ?? 0) },
            ads: { active: Number(ad?.active ?? 0), total: Number(ad?.total ?? 0), disapproved: Number(ad?.disapproved ?? 0) },
            activeDailyBudget: synced ? minorToMajor(budgetMinor, a.currency) : null,
            costAlertsToday: alerts.get(id) ?? 0,
        };
    });
    res.json({
        ...base,
        accounts: items,
        totalsByCurrency: [...byCurrency.entries()].map(([currency, t]) => ({ currency, accounts: t.accounts, activeDailyBudget: round(t.dailyBudget), ...metrics(t) })),
    });
}));
liveRouter.get('/live/accounts/:id', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const period = parse(periodSchema, req.query.period);
    const [a] = await managedAccounts(req.user, id);
    if (!a)
        throw errors.notFound('Managed ad account');
    const { since, until } = periodRange(period, a.timezone_name);
    const campaigns = await query(`SELECT * FROM meta_campaigns WHERE ad_account_row_id=? ORDER BY effective_status='ACTIVE' DESC, name`, [id]);
    const adsets = await query(`SELECT adset_id, campaign_id, name, effective_status, daily_budget_minor, lifetime_budget_minor FROM meta_adsets WHERE ad_account_row_id=?`, [id]);
    const ads = await query(`SELECT * FROM meta_ads WHERE ad_account_row_id=? ORDER BY effective_status='ACTIVE' DESC, name`, [id]);
    const insights = await query(`SELECT level, object_id, DATE_FORMAT(date,'%Y-%m-%d') AS d, spend, impressions, clicks, link_clicks, leads, calls, messages, result_type, results
         FROM meta_insights_daily WHERE ad_account_row_id=? AND date BETWEEN ? AND ?`, [id, since, until]);
    const per = new Map();
    const daily = new Map();
    const total = emptyTotals();
    for (const r of insights) {
        const key = `${r.level}:${r.object_id}`;
        const t = per.get(key) ?? emptyTotals();
        addRow(t, r);
        if (r.result_type)
            t.results.set(r.result_type, (t.results.get(r.result_type) ?? 0) + Number(r.results ?? 0));
        per.set(key, t);
        if (r.level === 'campaign') {
            addRow(total, r);
            if (r.result_type)
                total.results.set(r.result_type, (total.results.get(r.result_type) ?? 0) + Number(r.results ?? 0));
            daily.set(r.d, (daily.get(r.d) ?? 0) + Number(r.spend));
        }
    }
    const listed = new Set(campaigns.map((c) => c.campaign_id));
    let unlistedSpend = 0;
    for (const [key, t] of per)
        if (key.startsWith('campaign:') && !listed.has(key.slice(9)))
            unlistedSpend += t.spend;
    const cur = a.currency;
    const campaignName = new Map(campaigns.map((c) => [c.campaign_id, c.name]));
    const adsetName = new Map(adsets.map((s) => [s.adset_id, s.name]));
    const days = [];
    for (let d = since; d <= until; d = addDays(d, 1))
        days.push({ date: d, spend: round(daily.get(d) ?? 0) });
    res.json({
        period,
        range: { since, until },
        account: {
            id, accountId: a.account_id, name: a.name, currency: cur, timezone: a.timezone_name, accountStatus: a.account_status,
            syncedAt: a.live_synced_at, syncError: a.live_sync_error, synced: !!a.live_full_synced_at,
        },
        totals: metrics(total),
        dailySpend: days,
        unlistedSpend: round(unlistedSpend),
        campaigns: campaigns.map((c) => {
            const childBudgets = adsets.filter((s) => s.campaign_id === c.campaign_id && s.effective_status === 'ACTIVE');
            return {
                campaignId: c.campaign_id, name: c.name, status: c.status, effectiveStatus: c.effective_status, objective: c.objective,
                budget: c.daily_budget_minor != null ? { kind: 'daily', amount: minorToMajor(c.daily_budget_minor, cur), level: 'campaign' }
                    : c.lifetime_budget_minor != null ? { kind: 'lifetime', amount: minorToMajor(c.lifetime_budget_minor, cur), level: 'campaign' }
                        : childBudgets.some((s) => s.daily_budget_minor != null) ? { kind: 'daily', amount: minorToMajor(childBudgets.reduce((n, s) => n + Number(s.daily_budget_minor ?? 0), 0), cur), level: 'adset' }
                            : null,
                adsets: adsets.filter((s) => s.campaign_id === c.campaign_id).length,
                metrics: metrics(per.get(`campaign:${c.campaign_id}`) ?? emptyTotals()),
            };
        }),
        ads: ads.map((ad) => ({
            adId: ad.ad_id, name: ad.name, status: ad.status, effectiveStatus: ad.effective_status, campaignId: ad.campaign_id,
            campaignName: campaignName.get(ad.campaign_id) ?? null, adsetName: adsetName.get(ad.adset_id) ?? null,
            thumbnailUrl: ad.thumbnail_url, title: ad.title, body: ad.body,
            metrics: metrics(per.get(`ad:${ad.ad_id}`) ?? emptyTotals()),
        })),
    });
}));
const PREVIEW_FORMATS = ['MOBILE_FEED_STANDARD', 'DESKTOP_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY', 'FACEBOOK_STORY_MOBILE', 'INSTAGRAM_REELS', 'FACEBOOK_REELS_MOBILE'];
liveRouter.get('/live/ads/:adId/preview', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
    const adId = parse(z.string().regex(/^\d{1,32}$/), req.params.adId);
    const format = parse(z.enum(PREVIEW_FORMATS).default('MOBILE_FEED_STANDARD'), req.query.format);
    const scope = accountScope(req.user);
    const row = await queryOne(`SELECT ad.ad_account_row_id FROM meta_ads ad JOIN meta_ad_accounts a ON a.id=ad.ad_account_row_id WHERE ad.ad_id=? AND ${scope.sql}`, [adId, ...scope.params]);
    if (!row)
        throw errors.notFound('Ad');
    const src = await adPreviewUrl(Number(row.ad_account_row_id), adId, format);
    if (!src)
        throw new AppError({ code: 'META_PREVIEW_UNAVAILABLE', message: 'Meta did not return a preview for this ad in that placement.', status: 404, category: 'external_meta', hint: 'Try another placement, or open the ad in Ads Manager.' });
    res.json({ src, format });
}));
liveRouter.post('/live/sync', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
    if (!features().meta)
        throw new AppError({ code: 'META_NOT_CONFIGURED', message: 'Meta is not configured on the server.', status: 503, category: 'configuration' });
    const input = parse(z.object({ accountIds: z.array(z.number().int().positive()).max(1000).optional() }), req.body ?? {});
    const accounts = await managedAccounts(req.user);
    const ids = accounts.map((a) => Number(a.id)).filter((id) => !input.accountIds || input.accountIds.includes(id));
    const slot = Math.floor(Date.now() / 30_000);
    let queued = 0;
    for (const id of ids) {
        const jobId = await enqueue({ queue: 'sync', type: 'meta.sync_live', payload: { accountIds: [id] }, priority: 15, maxAttempts: 2, dedupeKey: `live-manual:${id}:${slot}` });
        if (jobId)
            queued++;
    }
    res.status(202).json({ queued, accounts: ids.length });
}));
/** Choose which ad accounts the panel manages. Only managed accounts are synced live and shown on the dashboard. */
liveRouter.put('/accounts/managed', requirePermission('accounts.manage', 'choose managed accounts'), asyncHandler(async (req, res) => {
    const input = parse(z.object({ accountIds: z.array(z.number().int().positive()).min(1).max(10000), managed: z.boolean() }), req.body);
    const rows = await query(`SELECT id FROM meta_ad_accounts WHERE org_id=? AND id IN (?)`, [req.user.orgId, input.accountIds]);
    const ids = rows.map((r) => Number(r.id));
    if (!ids.length)
        throw errors.notFound('Ad account');
    await execute(`UPDATE meta_ad_accounts SET is_managed=? WHERE id IN (?)`, [input.managed ? 1 : 0, ids]);
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: input.managed ? 'account.managed' : 'account.unmanaged', targetType: 'ad_account', targetId: ids.length === 1 ? ids[0] : undefined, details: { accountIds: ids }, ip: req.ip });
    let queued = 0;
    if (input.managed && features().meta) {
        for (const id of ids)
            if (await enqueue({ queue: 'sync', type: 'meta.sync_live', payload: { accountIds: [id] }, priority: 15, maxAttempts: 2, dedupeKey: `live-first:${id}:${Date.now()}` }))
                queued++;
    }
    res.json({ updated: ids.length, syncQueued: queued });
}));
// ---------- cost alert limits (Settings) ----------
const limitValue = z.number().min(0).max(1e12).nullable().optional();
const limitsSchema = z.object(Object.fromEntries([...METRICS, 'min_spend'].map((k) => [k, limitValue])));
liveRouter.get('/alerts/cost-settings', requirePermission('accounts.read'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const accounts = await query(`SELECT id, name, currency, account_id FROM meta_ad_accounts WHERE org_id=? AND is_managed=1 AND is_enabled=1 ORDER BY name`, [orgId]);
    const rows = await query(`SELECT * FROM cost_alert_settings WHERE org_id=?`, [orgId]);
    const pick = (r) => Object.fromEntries([...METRICS, 'min_spend'].map((k) => [k, r?.[k] != null ? Number(r[k]) : null]));
    const currencies = [...new Set(accounts.map((a) => a.currency))].sort();
    res.json({
        metrics: METRICS,
        defaults: currencies.map((c) => ({ currency: c, limits: pick(rows.find((r) => r.scope_key === `default:${c}`)) })),
        accounts: accounts.map((a) => ({ id: Number(a.id), name: a.name, accountId: a.account_id, currency: a.currency, limits: pick(rows.find((r) => r.scope_key === `account:${a.id}`)) })),
    });
}));
liveRouter.put('/alerts/cost-settings', requirePermission('accounts.manage', 'change cost alert limits'), asyncHandler(async (req, res) => {
    const input = parse(z.union([
        z.object({ scope: z.literal('default'), currency: z.string().regex(/^[A-Z]{3}$/), limits: limitsSchema }),
        z.object({ scope: z.literal('account'), accountId: z.number().int().positive(), limits: limitsSchema }),
    ]), req.body);
    const orgId = req.user.orgId;
    let scopeKey, accountRow = null, currency;
    if (input.scope === 'account') {
        const acc = await queryOne(`SELECT id, currency FROM meta_ad_accounts WHERE id=? AND org_id=?`, [input.accountId, orgId]);
        if (!acc)
            throw errors.notFound('Ad account');
        scopeKey = `account:${acc.id}`;
        accountRow = Number(acc.id);
        currency = acc.currency;
    }
    else {
        scopeKey = `default:${input.currency}`;
        currency = input.currency;
    }
    const cols = [...METRICS, 'min_spend'];
    const vals = cols.map((k) => input.limits[k] ?? null);
    await execute(`INSERT INTO cost_alert_settings (org_id, scope_key, ad_account_row_id, currency, ${cols.join(', ')}, updated_by) VALUES (?,?,?,?,${cols.map(() => '?').join(',')},?)
       ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c}=VALUES(${c})`).join(', ')}, updated_by=VALUES(updated_by)`, [orgId, scopeKey, accountRow, currency, ...vals, req.user.id]);
    await audit({ orgId, actorUserId: req.user.id, action: 'cost_alerts.updated', targetType: input.scope === 'account' ? 'ad_account' : 'org', targetId: accountRow ?? undefined, details: { scope: scopeKey, limits: input.limits }, ip: req.ip });
    res.json({ ok: true });
}));
//# sourceMappingURL=live.js.map
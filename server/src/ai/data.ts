import { query } from '../db/pool.js';
import { accountToday, addDays, minorToMajor, RESULT_LABELS } from '../meta/live.js';
import { managedAccounts, periodRange, type Preset } from '../routes/live.js';
import { avgDailySpend } from '../services/costAlerts.js';
import { fundsInfo } from '../services/funds.js';

/**
 * Read-only views of the synced Meta data for the AI pages. Every number here comes from the panel's own
 * tables (what the dashboard shows), never from the model. Nothing in this file writes.
 */

export type User = Express.Request['user'] & {};
export const AI_PERIODS = ['today', 'yesterday', '7d', '14d', '30d', 'this_month', 'last_month'] as const;
export type AiPeriod = (typeof AI_PERIODS)[number];
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AccountSummary {
  id: number;
  accountId: string;
  name: string;
  currency: string;
  position: number;
  synced: boolean;
  syncedAt: string | null;
  range: { since: string; until: string };
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  calls: number;
  messages: number;
  results: { type: string; label: string; count: number; costPer: number | null }[];
  ctr: number | null;
  cpc: number | null;
  activeCampaigns: number;
  activeAds: number;
  disapprovedAds: number;
  syncError: string | null;
}

async function totalsFor(ids: number[], ranges: Map<number, { since: string; until: string }>) {
  if (!ids.length) return { rows: [] as any[], results: [] as any[] };
  const earliest = [...ranges.values()].map((r) => r.since).sort()[0];
  const latest = [...ranges.values()].map((r) => r.until).sort().at(-1)!;
  const rows = await query<any>(
    `SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m-%d') AS d, SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
            SUM(link_clicks) AS link_clicks, SUM(leads) AS leads, SUM(calls) AS calls, SUM(messages) AS messages
       FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date BETWEEN ? AND ? GROUP BY ad_account_row_id, date`,
    [ids, earliest, latest],
  );
  const results = await query<any>(
    `SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m-%d') AS d, result_type, SUM(results) AS n
       FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date BETWEEN ? AND ? AND result_type IS NOT NULL
      GROUP BY ad_account_row_id, date, result_type`,
    [ids, earliest, latest],
  );
  return { rows, results };
}

export async function accountSummaries(user: User, period: AiPeriod | { since: string; until: string }, groupId?: number): Promise<AccountSummary[]> {
  const accounts = await managedAccounts(user, undefined, groupId);
  const ids = accounts.map((a) => Number(a.id));
  const ranges = new Map(accounts.map((a) => [Number(a.id), typeof period === 'string' ? periodRange(period as Preset, a.timezone_name) : period]));
  const { rows, results } = await totalsFor(ids, ranges);
  const counts = ids.length
    ? await query<any>(
        `SELECT ad_account_row_id AS id, 'c' AS k, SUM(effective_status='ACTIVE') AS active, 0 AS disapproved FROM meta_campaigns WHERE ad_account_row_id IN (?) GROUP BY ad_account_row_id
         UNION ALL SELECT ad_account_row_id, 'a', SUM(effective_status='ACTIVE'), SUM(effective_status='DISAPPROVED') FROM meta_ads WHERE ad_account_row_id IN (?) GROUP BY ad_account_row_id`,
        [ids, ids],
      )
    : [];
  return accounts.map((a, i) => {
    const id = Number(a.id);
    const range = ranges.get(id)!;
    const inRange = (d: string) => d >= range.since && d <= range.until;
    const t = { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, calls: 0, messages: 0 };
    for (const r of rows) {
      if (Number(r.id) !== id || !inRange(r.d)) continue;
      t.spend += Number(r.spend); t.impressions += Number(r.impressions); t.clicks += Number(r.clicks); t.linkClicks += Number(r.link_clicks);
      t.leads += Number(r.leads); t.calls += Number(r.calls); t.messages += Number(r.messages);
    }
    const res = new Map<string, number>();
    for (const r of results) if (Number(r.id) === id && inRange(r.d)) res.set(r.result_type, (res.get(r.result_type) ?? 0) + Number(r.n));
    const c = counts.find((x) => Number(x.id) === id && x.k === 'c');
    const ad = counts.find((x) => Number(x.id) === id && x.k === 'a');
    return {
      id, accountId: a.account_id, name: a.name, currency: a.currency, position: i + 1, synced: !!a.live_full_synced_at, syncedAt: a.live_synced_at, range,
      spend: r2(t.spend), impressions: t.impressions, clicks: t.clicks, linkClicks: t.linkClicks, leads: t.leads, calls: t.calls, messages: t.messages,
      results: [...res.entries()].map(([type, count]) => ({ type, label: RESULT_LABELS[type] ?? type, count, costPer: count > 0 ? r2(t.spend / count) : null })).sort((x, y) => y.count - x.count),
      ctr: t.impressions > 0 ? r2((t.clicks / t.impressions) * 100) : null,
      cpc: t.clicks > 0 ? r2(t.spend / t.clicks) : null,
      activeCampaigns: Number(c?.active ?? 0), activeAds: Number(ad?.active ?? 0), disapprovedAds: Number(ad?.disapproved ?? 0),
      syncError: a.live_sync_error ?? null,
    };
  });
}

export interface CampaignSummary {
  accountRowId: number;
  accountName: string;
  currency: string;
  campaignId: string;
  name: string;
  effectiveStatus: string | null;
  objective: string | null;
  budget: { kind: 'daily' | 'lifetime'; amount: number; level: 'campaign' | 'adset' } | null;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  calls: number;
  messages: number;
  results: { type: string; label: string; count: number; costPer: number | null }[];
}

export async function campaignSummaries(user: User, period: AiPeriod | { since: string; until: string }, opts: { groupId?: number; accountRowId?: number; onlyWithSpendOrActive?: boolean } = {}): Promise<CampaignSummary[]> {
  const accounts = (await managedAccounts(user, opts.accountRowId, opts.groupId)) as any[];
  const ids = accounts.map((a) => Number(a.id));
  if (!ids.length) return [];
  const ranges = new Map(accounts.map((a) => [Number(a.id), typeof period === 'string' ? periodRange(period as Preset, a.timezone_name) : period]));
  const earliest = [...ranges.values()].map((r) => r.since).sort()[0];
  const latest = [...ranges.values()].map((r) => r.until).sort().at(-1)!;
  const camps = await query<any>(`SELECT * FROM meta_campaigns WHERE ad_account_row_id IN (?)`, [ids]);
  const adsets = await query<any>(`SELECT ad_account_row_id, campaign_id, daily_budget_minor, lifetime_budget_minor FROM meta_adsets WHERE ad_account_row_id IN (?)`, [ids]);
  const ins = await query<any>(
    `SELECT ad_account_row_id AS id, object_id, DATE_FORMAT(date,'%Y-%m-%d') AS d, spend, impressions, clicks, leads, calls, messages, result_type, results
       FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date BETWEEN ? AND ?`,
    [ids, earliest, latest],
  );
  const out: CampaignSummary[] = [];
  for (const a of accounts) {
    const id = Number(a.id);
    const range = ranges.get(id)!;
    for (const c of camps.filter((x) => Number(x.ad_account_row_id) === id)) {
      const t = { spend: 0, impressions: 0, clicks: 0, leads: 0, calls: 0, messages: 0 };
      const res = new Map<string, number>();
      for (const r of ins) {
        if (Number(r.id) !== id || r.object_id !== c.campaign_id || r.d < range.since || r.d > range.until) continue;
        t.spend += Number(r.spend); t.impressions += Number(r.impressions); t.clicks += Number(r.clicks); t.leads += Number(r.leads); t.calls += Number(r.calls); t.messages += Number(r.messages);
        if (r.result_type) res.set(r.result_type, (res.get(r.result_type) ?? 0) + Number(r.results ?? 0));
      }
      const sets = adsets.filter((s) => Number(s.ad_account_row_id) === id && s.campaign_id === c.campaign_id);
      const cur = a.currency;
      const budget: CampaignSummary['budget'] = c.daily_budget_minor != null ? { kind: 'daily', amount: minorToMajor(c.daily_budget_minor, cur)!, level: 'campaign' }
        : c.lifetime_budget_minor != null ? { kind: 'lifetime', amount: minorToMajor(c.lifetime_budget_minor, cur)!, level: 'campaign' }
        : sets.some((s) => s.daily_budget_minor != null) ? { kind: 'daily', amount: minorToMajor(sets.reduce((n, s) => n + Number(s.daily_budget_minor ?? 0), 0), cur)!, level: 'adset' }
        : sets.some((s) => s.lifetime_budget_minor != null) ? { kind: 'lifetime', amount: minorToMajor(sets.reduce((n, s) => n + Number(s.lifetime_budget_minor ?? 0), 0), cur)!, level: 'adset' }
        : null;
      if (opts.onlyWithSpendOrActive && t.spend <= 0 && c.effective_status !== 'ACTIVE') continue;
      out.push({
        accountRowId: id, accountName: a.name, currency: cur, campaignId: c.campaign_id, name: c.name, effectiveStatus: c.effective_status, objective: c.objective, budget,
        spend: r2(t.spend), impressions: t.impressions, clicks: t.clicks, leads: t.leads, calls: t.calls, messages: t.messages,
        results: [...res.entries()].map(([type, count]) => ({ type, label: RESULT_LABELS[type] ?? type, count, costPer: count > 0 ? r2(t.spend / count) : null })).sort((x, y) => y.count - x.count),
      });
    }
  }
  return out;
}

export interface BalanceSummary {
  id: number;
  name: string;
  currency: string;
  kind: string;
  available: number | null;
  owed: number | null;
  capLeft: number | null;
  remaining: number | null;
  avgDailySpend: number | null;
  daysLeft: number | null;
  spentToday: number;
}

export async function balanceSummaries(user: User, groupId?: number): Promise<BalanceSummary[]> {
  const accounts = (await managedAccounts(user, undefined, groupId)) as any[];
  const ids = accounts.map((a) => Number(a.id));
  if (!ids.length) return [];
  const rows = await query<any>(`SELECT * FROM meta_ad_accounts WHERE id IN (?)`, [ids]);
  const today = accountToday(accounts[0].timezone_name);
  const avg = await avgDailySpend(ids, today);
  const spentToday = await query<any>(`SELECT ad_account_row_id AS id, SUM(spend) AS s FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date=? GROUP BY ad_account_row_id`, [ids, today]);
  return accounts.map((a) => {
    const row = rows.find((r) => Number(r.id) === Number(a.id));
    const f = fundsInfo(row, avg.get(Number(a.id)) ?? null) as any;
    return { id: Number(a.id), name: a.name, currency: a.currency, kind: f.kind, available: f.available, owed: f.owed, capLeft: f.capLeft, remaining: f.remaining, avgDailySpend: f.avgDailySpend ?? avg.get(Number(a.id)) ?? null, daysLeft: f.daysLeft, spentToday: r2(Number(spentToday.find((s) => Number(s.id) === Number(a.id))?.s ?? 0)) };
  });
}

/** Daily spend per account for the last `days` full days plus today, for spike detection. */
export async function dailySpendSeries(ids: number[], days = 14): Promise<Map<number, { date: string; spend: number; results: number }[]>> {
  const out = new Map<number, { date: string; spend: number; results: number }[]>();
  if (!ids.length) return out;
  const today = new Date().toISOString().slice(0, 10);
  const rows = await query<any>(
    `SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m-%d') AS d, SUM(spend) AS spend, SUM(COALESCE(results,0)) AS results
       FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date >= ? GROUP BY ad_account_row_id, date ORDER BY date`,
    [ids, addDays(today, -days - 1)],
  );
  for (const r of rows) {
    const list = out.get(Number(r.id)) ?? [];
    list.push({ date: r.d, spend: r2(Number(r.spend)), results: Number(r.results) });
    out.set(Number(r.id), list);
  }
  return out;
}

export async function recentLaunches(user: User) {
  const rows = await query<any>(
    `SELECT l.id, l.name, l.goal, l.created_at, COUNT(i.id) AS items, SUM(i.status='done') AS done, SUM(i.status IN ('failed','needs_review')) AS failed, SUM(i.status IN ('queued','working')) AS pending
       FROM launches l LEFT JOIN launch_items i ON i.launch_id=l.id WHERE l.org_id=? GROUP BY l.id ORDER BY l.id DESC LIMIT 10`,
    [user.orgId],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, goal: r.goal, createdAt: r.created_at, accounts: Number(r.items), done: Number(r.done ?? 0), failed: Number(r.failed ?? 0), pending: Number(r.pending ?? 0) }));
}

export async function recentNotifications(user: User, limit = 20) {
  const rows = await query<any>(`SELECT id, severity, category, title, body, created_at FROM notifications WHERE org_id=? ORDER BY id DESC LIMIT ?`, [user.orgId, limit]);
  return rows.map((r) => ({ id: Number(r.id), severity: r.severity, category: r.category, title: r.title, body: r.body, at: r.created_at }));
}

import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { PRESETS, managedAccounts, periodRange, type Preset } from '../routes/live.js';

type User = Express.Request['user'] & {};

/**
 * Custom Reports: any working accounts, any period, rows by account, campaign, ad or day, the metrics you pick.
 * Everything comes from meta_insights_daily (what the live sync stored), so a report never shows a number the
 * panel has not synced. No limit on accounts or rows beyond what was synced.
 */
export const METRICS = {
  spend: { label: 'Spend', kind: 'money' },
  impressions: { label: 'Impressions', kind: 'int' },
  clicks: { label: 'Clicks (all)', kind: 'int' },
  linkClicks: { label: 'Link clicks', kind: 'int' },
  leads: { label: 'Leads', kind: 'int' },
  calls: { label: 'Calls', kind: 'int' },
  messages: { label: 'Messages', kind: 'int' },
  results: { label: 'Results', kind: 'int' },
  ctr: { label: 'CTR %', kind: 'pct' },
  cpc: { label: 'CPC', kind: 'money' },
  cpm: { label: 'CPM', kind: 'money' },
  costPerLead: { label: 'Cost per lead', kind: 'money' },
  costPerCall: { label: 'Cost per call', kind: 'money' },
  costPerMessage: { label: 'Cost per message', kind: 'money' },
  costPerResult: { label: 'Cost per result', kind: 'money' },
} as const;
export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];
export const LEVELS = ['account', 'campaign', 'ad', 'day', 'month'] as const;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const reportConfig = z.object({
  group: z.number().int().positive().optional(),
  accountIds: z.array(z.number().int().positive()).max(500).default([]),
  period: z.enum(PRESETS).default('7d'),
  since: dateStr.optional(),
  until: dateStr.optional(),
  level: z.enum(LEVELS).default('account'),
  metrics: z.array(z.enum(METRIC_KEYS as [MetricKey, ...MetricKey[]])).min(1, 'Pick at least one metric.').default(['spend', 'results', 'costPerResult']),
  sort: z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
}).superRefine((c, ctx) => {
  if (c.period === 'custom' && (!c.since || !c.until)) ctx.addIssue({ code: 'custom', path: ['since'], message: 'Choose a start and an end date.' });
  if (c.since && c.until && c.since > c.until) ctx.addIssue({ code: 'custom', path: ['until'], message: 'The end date is before the start date.' });
});
export type ReportConfig = z.infer<typeof reportConfig>;

const r2 = (n: number) => Math.round(n * 100) / 100;
function derive(t: { spend: number; impressions: number; clicks: number; linkClicks: number; leads: number; calls: number; messages: number; results: number }) {
  const per = (n: number) => (n > 0 ? r2(t.spend / n) : null);
  return {
    ...t, spend: r2(t.spend),
    ctr: t.impressions > 0 ? r2((t.clicks / t.impressions) * 100) : null,
    cpc: per(t.clicks), cpm: t.impressions > 0 ? r2((t.spend / t.impressions) * 1000) : null,
    costPerLead: per(t.leads), costPerCall: per(t.calls), costPerMessage: per(t.messages), costPerResult: per(t.results),
  };
}

export async function buildReport(user: User, cfg: ReportConfig) {
  let accounts = await managedAccounts(user, undefined, cfg.group);
  if (cfg.accountIds.length) accounts = accounts.filter((a) => cfg.accountIds.includes(Number(a.id)));
  const ids = accounts.map((a) => Number(a.id));
  const ranges = new Map(accounts.map((a) => [Number(a.id), cfg.period === 'custom' ? { since: cfg.since!, until: cfg.until! } : periodRange(cfg.period as Preset, a.timezone_name)]));
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));
  if (!ids.length) return { rows: [], columns: cfg.metrics, level: cfg.level, accounts: 0, ranges: [] };
  const earliest = [...ranges.values()].map((r) => r.since).sort()[0];
  const latest = [...ranges.values()].map((r) => r.until).sort().at(-1)!;
  const level = cfg.level === 'ad' ? 'ad' : 'campaign';
  const keyExpr = cfg.level === 'day' ? `DATE_FORMAT(i.date,'%Y-%m-%d')` : cfg.level === 'month' ? `DATE_FORMAT(i.date,'%Y-%m')` : cfg.level === 'account' ? `'all'` : 'i.object_id';
  const rows = await query<any>(
    `SELECT i.ad_account_row_id AS id, ${keyExpr} AS k, DATE_FORMAT(i.date,'%Y-%m-%d') AS d, i.objective, SUM(i.spend) AS spend, SUM(i.impressions) AS impressions, SUM(i.clicks) AS clicks,
            SUM(i.link_clicks) AS link_clicks, SUM(i.leads) AS leads, SUM(i.calls) AS calls, SUM(i.messages) AS messages, SUM(COALESCE(i.results,0)) AS results
       FROM meta_insights_daily i WHERE i.level=? AND i.ad_account_row_id IN (?) AND i.date BETWEEN ? AND ?
      GROUP BY i.ad_account_row_id, k, d, i.objective`,
    [level, ids, earliest, latest],
  );
  const names = new Map<string, { name: string; status: string | null; parent?: string }>();
  if (cfg.level === 'campaign') for (const c of await query<any>(`SELECT campaign_id, name, effective_status FROM meta_campaigns WHERE ad_account_row_id IN (?)`, [ids])) names.set(c.campaign_id, { name: c.name, status: c.effective_status });
  if (cfg.level === 'ad') for (const c of await query<any>(`SELECT a.ad_id, a.name, a.effective_status, c.name AS campaign FROM meta_ads a LEFT JOIN meta_campaigns c ON c.campaign_id=a.campaign_id AND c.ad_account_row_id=a.ad_account_row_id WHERE a.ad_account_row_id IN (?)`, [ids])) names.set(c.ad_id, { name: c.name, status: c.effective_status, parent: c.campaign });

  const agg = new Map<string, any>();
  for (const r of rows) {
    const id = Number(r.id);
    const range = ranges.get(id)!;
    if (r.d < range.since || r.d > range.until) continue;
    const key = cfg.level === 'day' || cfg.level === 'month' ? r.k : `${id}:${r.k}`;
    const a = byId.get(id);
    const cur = agg.get(key) ?? {
      key, accountRowId: cfg.level === 'day' || cfg.level === 'month' ? null : id, account: cfg.level === 'day' || cfg.level === 'month' ? null : a.name, position: accounts.indexOf(a) + 1,
      currency: cfg.level === 'day' || cfg.level === 'month' ? [...new Set(accounts.map((x) => x.currency))].join('/') : a.currency,
      name: cfg.level === 'account' ? a.name : cfg.level === 'day' || cfg.level === 'month' ? r.k : (names.get(r.k)?.name ?? r.k), status: names.get(r.k)?.status ?? null, parent: names.get(r.k)?.parent ?? null, objective: r.objective ?? null,
      spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, calls: 0, messages: 0, results: 0,
    };
    cur.spend += Number(r.spend); cur.impressions += Number(r.impressions); cur.clicks += Number(r.clicks); cur.linkClicks += Number(r.link_clicks);
    cur.leads += Number(r.leads); cur.calls += Number(r.calls); cur.messages += Number(r.messages); cur.results += Number(r.results);
    agg.set(key, cur);
  }
  let out = [...agg.values()].map((x) => ({ ...x, ...derive(x) }));
  if (cfg.level === 'account') for (const a of accounts) if (!agg.has(`${Number(a.id)}:all`)) out.push({ key: `${a.id}:all`, accountRowId: Number(a.id), account: a.name, position: accounts.indexOf(a) + 1, currency: a.currency, name: a.name, status: null, parent: null, objective: null, ...derive({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, calls: 0, messages: 0, results: 0 }) });
  const sortKey = cfg.sort?.key ?? (cfg.level === 'day' || cfg.level === 'month' ? 'name' : 'position');
  const dir = cfg.sort?.dir ?? 'asc';
  out.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; const c = x == null ? 1 : y == null ? -1 : typeof x === 'number' ? x - y : String(x).localeCompare(String(y)); return dir === 'asc' ? c : -c; });
  const totals = new Map<string, any>();
  for (const r of out) { const t = totals.get(r.currency) ?? { currency: r.currency, spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, calls: 0, messages: 0, results: 0 }; for (const k of ['spend', 'impressions', 'clicks', 'linkClicks', 'leads', 'calls', 'messages', 'results']) t[k] += r[k]; totals.set(r.currency, t); }
  return { rows: out, columns: cfg.metrics, level: cfg.level, accounts: ids.length, ranges: accounts.map((a) => ({ account: a.name, ...ranges.get(Number(a.id))! })), totals: [...totals.values()].map((t) => ({ ...t, ...derive(t) })) };
}

export function reportCsv(report: Awaited<ReturnType<typeof buildReport>>) {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = [report.level === 'day' ? 'Day' : report.level === 'month' ? 'Month' : 'Name', ...(report.level === 'campaign' || report.level === 'ad' ? ['Account', 'Status'] : []), ...(report.level === 'ad' ? ['Campaign'] : []), 'Currency', ...report.columns.map((c) => METRICS[c].label)];
  const lines = report.rows.map((r) => [r.name, ...(report.level === 'campaign' || report.level === 'ad' ? [r.account, r.status ?? ''] : []), ...(report.level === 'ad' ? [r.parent ?? ''] : []), r.currency, ...report.columns.map((c) => r[c] ?? '')].map(esc).join(','));
  return '﻿' + [head.map(esc).join(','), ...lines].join('\n') + '\n';
}

// ---------------------------------------------------------------- templates

export const templateInput = z.object({ name: z.string().trim().min(1, 'Give the report a name.').max(120), config: reportConfig });

export async function listTemplates(orgId: number) {
  const rows = await query<any>(`SELECT t.*, u.name AS user_name FROM report_templates t LEFT JOIN users u ON u.id=t.created_by WHERE t.org_id=? ORDER BY t.name`, [orgId]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config, by: r.user_name ?? null, updatedAt: r.updated_at }));
}
export async function saveTemplate(user: User, input: z.infer<typeof templateInput>, id?: number) {
  const dup = await queryOne<any>(`SELECT id FROM report_templates WHERE org_id=? AND name=? ${id ? 'AND id<>?' : ''}`, id ? [user.orgId, input.name, id] : [user.orgId, input.name]);
  if (dup) throw new AppError({ code: 'REPORT_NAME_TAKEN', message: 'A saved report with this name already exists.', status: 409, category: 'validation' });
  if (id) {
    const r = await execute(`UPDATE report_templates SET name=?, config=? WHERE id=? AND org_id=?`, [input.name, JSON.stringify(input.config), id, user.orgId]);
    if (!r.affectedRows) throw new AppError({ code: 'NOT_FOUND', message: 'Saved report was not found.', status: 404, category: 'not_found' });
    return id;
  }
  return (await execute(`INSERT INTO report_templates (org_id, name, config, created_by) VALUES (?,?,?,?)`, [user.orgId, input.name, JSON.stringify(input.config), user.id])).insertId;
}
export async function deleteTemplate(orgId: number, id: number) {
  const r = await execute(`DELETE FROM report_templates WHERE id=? AND org_id=?`, [id, orgId]);
  if (!r.affectedRows) throw new AppError({ code: 'NOT_FOUND', message: 'Saved report was not found.', status: 404, category: 'not_found' });
}

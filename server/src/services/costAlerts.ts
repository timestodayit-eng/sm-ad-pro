import { execute, query, queryOne } from '../db/pool.js';
import { accountToday, addDays } from '../meta/live.js';
import { fundsInfo } from './funds.js';

/**
 * Cost alerts, checked after every live sync of an account, on today's numbers in the account's time zone.
 * - Daily spend: the whole account.
 * - Cost per lead / call / message / result: each campaign that spent today, judged on the kind of result it
 *   is getting, so a messaging campaign never raises a "cost per lead" alert.
 * - Low balance: fewer days of funds (or spending limit) left than the limit, at the last 7 days' average spend.
 * One notification per account or campaign, metric and day.
 */

export const METRICS = ['daily_spend_limit', 'max_cost_per_lead', 'max_cost_per_call', 'max_cost_per_message', 'max_cost_per_result', 'min_days_left'] as const;
export type Metric = (typeof METRICS)[number];
export type Limits = Partial<Record<Metric | 'min_spend', number | null>>;

const LEAD_TYPES = new Set(['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
const CALL_TYPES = new Set(['click_to_call_native_call_placed', 'click_to_call_call_confirm']);
const MESSAGE_TYPES = new Set(['onsite_conversion.messaging_conversation_started_7d']);

const n = (v: unknown) => (v == null ? null : Number(v));

/** Account values override the default for the currency; NULL on the account means "use the default". 0 means off. */
export function effectiveLimits(def: any | null, acc: any | null): Required<Limits> {
  const out = {} as Required<Limits>;
  for (const k of [...METRICS, 'min_spend'] as const) {
    const a = acc ? n(acc[k]) : null;
    const v = a != null ? a : def ? n(def[k]) : null;
    out[k] = v && v > 0 ? v : null;
  }
  return out;
}

export interface Breach {
  key: string;
  title: string;
  body: string;
}

/** Pure decision logic, separated so it can be tested without a database. */
export function findBreaches(input: {
  accountName: string;
  currency: string;
  limits: Required<Limits>;
  account: { spend: number };
  funds?: { remaining: number | null; daysLeft: number | null; avgDailySpend: number | null; limitedBy: string | null };
  campaigns: { id: string; name: string; spend: number; leads: number; calls: number; messages: number; results: number; resultType: string | null }[];
}): Breach[] {
  const { limits: L, currency } = input;
  const fmt = (v: number) => `${currency} ${v.toLocaleString('en', { maximumFractionDigits: 2 })}`;
  const out: Breach[] = [];
  if (L.daily_spend_limit != null && input.account.spend > L.daily_spend_limit) {
    out.push({
      key: 'spend:account',
      title: `Daily spend over limit: ${input.accountName}`,
      body: `${input.accountName} has spent ${fmt(input.account.spend)} today. Your daily limit is ${fmt(L.daily_spend_limit)}.`,
    });
  }
  const f = input.funds;
  if (L.min_days_left != null && f?.daysLeft != null && f.daysLeft < L.min_days_left) {
    out.push({
      key: 'funds:account',
      title: `Low balance: ${input.accountName}`,
      body: `${input.accountName} has ${fmt(f.remaining!)} ${f.limitedBy === 'spend_cap' ? 'left before its spending limit' : 'of funds left'}, about ${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'} at ${fmt(f.avgDailySpend!)} a day. Your alert is set at ${L.min_days_left} days.`,
    });
  }
  const minSpend = L.min_spend ?? 0;
  for (const c of input.campaigns) {
    if (c.spend <= 0 || c.spend < minSpend) continue;
    const checks: { metric: Metric; label: string; unit: string; count: number }[] = [];
    if (c.resultType && LEAD_TYPES.has(c.resultType)) checks.push({ metric: 'max_cost_per_lead', label: 'cost per lead', unit: 'leads', count: c.leads });
    if (c.resultType && CALL_TYPES.has(c.resultType)) checks.push({ metric: 'max_cost_per_call', label: 'cost per call', unit: 'calls', count: c.calls });
    if (c.resultType && MESSAGE_TYPES.has(c.resultType)) checks.push({ metric: 'max_cost_per_message', label: 'cost per message', unit: 'conversations', count: c.messages });
    if (c.resultType) checks.push({ metric: 'max_cost_per_result', label: 'cost per result', unit: 'results', count: c.results });
    for (const ch of checks) {
      const limit = L[ch.metric];
      if (limit == null) continue;
      // With no results yet, the cost per result is at least the spend so far.
      const breached = ch.count === 0 ? c.spend > limit : c.spend / ch.count > limit;
      if (!breached) continue;
      const now = ch.count === 0 ? `${fmt(c.spend)} spent and no ${ch.unit} yet` : `${fmt(c.spend / ch.count)} (${fmt(c.spend)} spent, ${ch.count} ${ch.unit})`;
      out.push({
        key: `${ch.metric}:${c.id}`,
        title: `High ${ch.label}: ${c.name}`,
        body: `Today in ${input.accountName}: ${now}. Your limit is ${fmt(limit)}.`,
      });
    }
  }
  return out;
}

export async function evaluateCostAlerts(rowId: number, now = new Date()): Promise<Breach[]> {
  const acc = await queryOne(
    `SELECT id, org_id, name, currency, timezone_name, is_prepay, prepaid_funds_minor, balance_minor, spend_cap_minor, amount_spent_minor FROM meta_ad_accounts WHERE id=?`,
    [rowId],
  );
  if (!acc) return [];
  const def = await queryOne(`SELECT * FROM cost_alert_settings WHERE org_id=? AND scope_key=?`, [acc.org_id, `default:${acc.currency}`]);
  const own = await queryOne(`SELECT * FROM cost_alert_settings WHERE org_id=? AND scope_key=?`, [acc.org_id, `account:${rowId}`]);
  const limits = effectiveLimits(def, own);
  if (METRICS.every((m) => limits[m] == null)) return [];
  const today = accountToday(acc.timezone_name, now);
  const rows = await query<any>(
    `SELECT i.object_id, c.name, i.spend, i.leads, i.calls, i.messages, i.results, i.result_type
       FROM meta_insights_daily i LEFT JOIN meta_campaigns c ON c.ad_account_row_id=i.ad_account_row_id AND c.campaign_id=i.object_id
      WHERE i.ad_account_row_id=? AND i.level='campaign' AND i.date=?`,
    [rowId, today],
  );
  const avg = await avgDailySpend([rowId], today);
  const breaches = findBreaches({
    accountName: acc.name,
    currency: acc.currency,
    limits,
    funds: fundsInfo(acc as any, avg.get(rowId) ?? null),
    account: { spend: rows.reduce((s, r) => s + Number(r.spend), 0) },
    campaigns: rows.map((r) => ({
      id: r.object_id, name: r.name ?? `Campaign ${r.object_id}`, spend: Number(r.spend), leads: Number(r.leads), calls: Number(r.calls),
      messages: Number(r.messages), results: Number(r.results ?? 0), resultType: r.result_type,
    })),
  });
  for (const b of breaches) {
    await execute(
      `INSERT INTO notifications (org_id, severity, category, title, body, link, dedupe_key) VALUES (?, 'warning', 'cost', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id=id`,
      [acc.org_id, b.title.slice(0, 255), b.body, `/live/${rowId}`, `cost:${rowId}:${b.key}:${today}`.slice(0, 190)],
    );
  }
  return breaches;
}

/** Today's cost alerts per account, for badges on the dashboard. */
export async function costAlertsToday(accounts: { id: number; timezone_name: string | null }[], now = new Date()): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const a of accounts) {
    const r = await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE ?`, [`cost:${a.id}:%:${accountToday(a.timezone_name, now)}`]);
    if (Number(r?.n)) out.set(a.id, Number(r!.n));
  }
  return out;
}

/** Average daily spend over the last 7 full days (yesterday and the six days before), per account. */
export async function avgDailySpend(ids: number[], today: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const rows = await query<any>(
    `SELECT ad_account_row_id AS id, SUM(spend) AS s FROM meta_insights_daily
      WHERE level='campaign' AND ad_account_row_id IN (?) AND date BETWEEN ? AND ? GROUP BY ad_account_row_id`,
    [ids, addDays(today, -7), addDays(today, -1)],
  );
  for (const r of rows) out.set(Number(r.id), Math.round((Number(r.s) / 7) * 100) / 100);
  return out;
}

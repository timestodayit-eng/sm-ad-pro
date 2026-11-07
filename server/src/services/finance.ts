import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { majorToMinor, minorToMajor } from '../meta/live.js';
import { balanceSummaries } from '../ai/data.js';
import { PRESETS, managedAccounts, periodRange, type Preset } from '../routes/live.js';

type User = Express.Request['user'] & {};

/**
 * Finance: spend by account, currency and period from synced insights; money left from Meta (same as the
 * Balance page); top-ups and other entries logged by hand (Meta does not report payments); BDT totals only at a
 * rate the team typed in, shown with its date. The panel never invents an exchange rate.
 */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const financeQuery = z.object({ group: z.coerce.number().int().positive().optional(), period: z.enum(PRESETS).default('this_month'), since: dateStr.optional(), until: dateStr.optional() });

export const rateInput = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), rateToBdt: z.number().positive().max(1_000_000), asOf: dateStr, note: z.string().trim().max(255).default('') });
export const entryInput = z.object({ accountRowId: z.number().int().positive(), kind: z.enum(['topup', 'refund', 'fee', 'adjustment']), amount: z.number().finite().min(-10_000_000).max(10_000_000), onDate: dateStr, note: z.string().trim().max(255).default('') });

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function listRates(orgId: number) {
  const rows = await query<any>(`SELECT r.*, u.name AS user_name FROM finance_rates r LEFT JOIN users u ON u.id=r.updated_by WHERE r.org_id=? ORDER BY r.currency`, [orgId]);
  return rows.map((r) => ({ currency: r.currency, rateToBdt: Number(r.rate_to_bdt), asOf: typeof r.as_of === 'string' ? r.as_of.slice(0, 10) : new Date(r.as_of).toISOString().slice(0, 10), note: r.note ?? '', by: r.user_name ?? null, updatedAt: r.updated_at }));
}
export async function saveRate(user: User, input: z.infer<typeof rateInput>) {
  await execute(`INSERT INTO finance_rates (org_id, currency, rate_to_bdt, as_of, note, updated_by) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE rate_to_bdt=VALUES(rate_to_bdt), as_of=VALUES(as_of), note=VALUES(note), updated_by=VALUES(updated_by)`, [user.orgId, input.currency, input.rateToBdt, input.asOf, input.note || null, user.id]);
}
export async function deleteRate(orgId: number, currency: string) {
  await execute(`DELETE FROM finance_rates WHERE org_id=? AND currency=?`, [orgId, currency]);
}

export async function addEntry(user: User, input: z.infer<typeof entryInput>) {
  const a = await queryOne<any>(`SELECT id, currency FROM meta_ad_accounts WHERE id=? AND org_id=?`, [input.accountRowId, user.orgId]);
  if (!a) throw new AppError({ code: 'NOT_FOUND', message: 'Account was not found.', status: 404, category: 'not_found' });
  return (await execute(`INSERT INTO finance_entries (org_id, ad_account_row_id, kind, amount_minor, currency, on_date, note, created_by) VALUES (?,?,?,?,?,?,?,?)`, [user.orgId, a.id, input.kind, majorToMinor(input.amount, a.currency), a.currency, input.onDate, input.note || null, user.id])).insertId;
}
export async function deleteEntry(orgId: number, id: number) {
  const r = await execute(`DELETE FROM finance_entries WHERE id=? AND org_id=?`, [id, orgId]);
  if (!r.affectedRows) throw new AppError({ code: 'NOT_FOUND', message: 'Entry was not found.', status: 404, category: 'not_found' });
}

export async function financeSummary(user: User, q: z.infer<typeof financeQuery>) {
  const accounts = await managedAccounts(user, undefined, q.group);
  const ids = accounts.map((a) => Number(a.id));
  const ranges = new Map(accounts.map((a) => [Number(a.id), q.period === 'custom' ? { since: q.since!, until: q.until! } : periodRange(q.period as Preset, a.timezone_name)]));
  const rates = await listRates(user.orgId);
  const rateOf = (c: string) => rates.find((r) => r.currency === c) ?? (c === 'BDT' ? { currency: 'BDT', rateToBdt: 1, asOf: null as string | null, note: '' } : null);
  if (!ids.length) return { accounts: [], totals: [], months: [], entries: [], rates, bdt: null };
  const earliest = [...ranges.values()].map((r) => r.since).sort()[0];
  const latest = [...ranges.values()].map((r) => r.until).sort().at(-1)!;
  const spend = await query<any>(`SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m-%d') AS d, SUM(spend) AS spend, SUM(COALESCE(results,0)) AS results FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date BETWEEN ? AND ? GROUP BY ad_account_row_id, date`, [ids, earliest, latest]);
  const months = await query<any>(`SELECT ad_account_row_id AS id, DATE_FORMAT(date,'%Y-%m') AS m, SUM(spend) AS spend FROM meta_insights_daily WHERE level='campaign' AND ad_account_row_id IN (?) AND date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) GROUP BY ad_account_row_id, m ORDER BY m`, [ids]);
  const entries = await query<any>(`SELECT e.*, u.name AS user_name, a.name AS account_name FROM finance_entries e JOIN meta_ad_accounts a ON a.id=e.ad_account_row_id LEFT JOIN users u ON u.id=e.created_by WHERE e.org_id=? AND e.ad_account_row_id IN (?) ORDER BY e.on_date DESC, e.id DESC LIMIT 500`, [user.orgId, ids]);
  const balances = await balanceSummaries(user, q.group);
  const inPeriod = (id: number, d: string) => { const r = ranges.get(id)!; return d >= r.since && d <= r.until; };
  const dateOf = (v: any) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

  const rows = accounts.map((a, i) => {
    const id = Number(a.id);
    let s = 0, res = 0;
    for (const r of spend) if (Number(r.id) === id && inPeriod(id, r.d)) { s += Number(r.spend); res += Number(r.results); }
    let topups = 0;
    for (const e of entries) if (Number(e.ad_account_row_id) === id && e.kind === 'topup' && inPeriod(id, dateOf(e.on_date))) topups += minorToMajor(Number(e.amount_minor), e.currency) ?? 0;
    const b = balances.find((x) => x.id === id);
    const rate = rateOf(a.currency);
    return {
      id, position: i + 1, name: a.name, accountId: a.account_id, currency: a.currency, range: ranges.get(id),
      spend: r2(s), results: res, costPerResult: res > 0 ? r2(s / res) : null, topups: r2(topups),
      remaining: b?.remaining ?? null, owed: b?.owed ?? null, kind: b?.kind ?? null, daysLeft: b?.daysLeft ?? null,
      spendBdt: rate ? r2(s * rate.rateToBdt) : null,
      months: months.filter((m) => Number(m.id) === id).map((m) => ({ month: m.m, spend: r2(Number(m.spend)) })),
    };
  });
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const totals = currencies.map((c) => {
    const rs = rows.filter((r) => r.currency === c);
    const rate = rateOf(c);
    const sum = (k: 'spend' | 'topups') => r2(rs.reduce((n, r) => n + r[k], 0));
    const remaining = rs.some((r) => r.remaining != null) ? r2(rs.reduce((n, r) => n + (r.remaining ?? 0), 0)) : null;
    return { currency: c, accounts: rs.length, spend: sum('spend'), topups: sum('topups'), remaining, rate: rate ? { rateToBdt: rate.rateToBdt, asOf: rate.asOf } : null, spendBdt: rate ? r2(sum('spend') * rate.rateToBdt) : null };
  });
  const missing = currencies.filter((c) => !rateOf(c));
  const bdt = missing.length ? null : { spend: r2(totals.reduce((n, t) => n + (t.spendBdt ?? 0), 0)), ratesAsOf: [...new Set(totals.map((t) => t.rate?.asOf).filter(Boolean))] };
  const monthKeys = [...new Set(months.map((m) => m.m))].sort();
  return {
    accounts: rows, totals, bdt, missingRates: missing, rates,
    months: monthKeys.map((m) => ({ month: m, byCurrency: currencies.map((c) => ({ currency: c, spend: r2(rows.filter((r) => r.currency === c).reduce((n, r) => n + (r.months.find((x) => x.month === m)?.spend ?? 0), 0)) })) })),
    entries: entries.map((e) => ({ id: Number(e.id), accountRowId: Number(e.ad_account_row_id), account: e.account_name, kind: e.kind, amount: minorToMajor(Number(e.amount_minor), e.currency), currency: e.currency, onDate: dateOf(e.on_date), note: e.note ?? '', by: e.user_name ?? null })),
  };
}

export function financeCsv(s: Awaited<ReturnType<typeof financeSummary>>) {
  const esc = (v: unknown) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const head = ['#', 'Account', 'Account ID', 'Currency', 'From', 'To', 'Spend', 'Results', 'Cost per result', 'Top-ups', 'Money left', 'Spend in BDT'];
  const lines = s.accounts.map((r) => [r.position, r.name, `act_${r.accountId}`, r.currency, r.range?.since, r.range?.until, r.spend, r.results, r.costPerResult ?? '', r.topups, r.remaining ?? '', r.spendBdt ?? ''].map(esc).join(','));
  return '﻿' + [head.join(','), ...lines].join('\n') + '\n';
}

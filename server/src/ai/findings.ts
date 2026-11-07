import { accountSummaries, balanceSummaries, campaignSummaries, dailySpendSeries, type AiPeriod, type User } from './data.js';
import { query } from '../db/pool.js';

/**
 * AI Analytics: every finding is computed by code from synced data, with the numbers that prove it.
 * The model only explains findings (see copilot.ts); it never decides them and never invents one.
 */

export type Severity = 'critical' | 'warning' | 'info' | 'good';
export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  key: string;
  kind: string;
  severity: Severity;
  confidence: Confidence;
  accountRowId: number | null;
  accountName: string | null;
  title: string;
  /** Plain-language explanation with the numbers. */
  detail: string;
  /** The evidence as numbers, for the UI and for the model. */
  evidence: Record<string, number | string | null>;
  /** The likely cause(s), in order. */
  causes: string[];
  /** What to do, as a sentence; never applied automatically. */
  suggestion: string | null;
  link: string | null;
}

const money = (n: number | null | undefined, c: string) => (n == null ? '—' : `${c} ${n.toLocaleString('en', { maximumFractionDigits: 2 })}`);
const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Pure: findings from already-loaded data. Exported for tests. */
export function computeFindings(input: {
  accounts: Awaited<ReturnType<typeof accountSummaries>>;
  campaigns: Awaited<ReturnType<typeof campaignSummaries>>;
  balances: Awaited<ReturnType<typeof balanceSummaries>>;
  daily: Map<number, { date: string; spend: number; results: number }[]>;
  launches: { id: number; name: string; failed: number; pending: number }[];
  today: string;
  minSpend?: number;
}): Finding[] {
  const out: Finding[] = [];
  const minSpend = input.minSpend ?? 5;

  for (const a of input.accounts) {
    const c = a.currency;
    if (!a.synced) {
      out.push({ key: `nosync:${a.id}`, kind: 'not_synced', severity: 'info', confidence: 'high', accountRowId: a.id, accountName: a.name, title: `${a.name} has not been synced yet`, detail: 'No numbers from Meta yet. The first sync of a new working account takes up to 15 minutes.', evidence: {}, causes: ['The account was added to the working accounts recently', 'Background jobs are paused'], suggestion: 'Check System Health if it stays like this for more than 30 minutes.', link: '/health' });
      continue;
    }
    if (a.syncError) {
      out.push({ key: `syncerr:${a.id}`, kind: 'sync_error', severity: 'warning', confidence: 'high', accountRowId: a.id, accountName: a.name, title: `Sync problem: ${a.name}`, detail: `The last sync reported: ${a.syncError}`, evidence: { error: a.syncError }, causes: ['Meta token or permission problem', 'Meta rate limit'], suggestion: 'Open Ad Accounts and reconnect Meta if the error mentions the token.', link: `/live/${a.id}` });
    }
    if (a.disapprovedAds > 0) {
      out.push({ key: `rejected:${a.id}`, kind: 'rejected_ads', severity: 'warning', confidence: 'high', accountRowId: a.id, accountName: a.name, title: `${a.disapprovedAds} rejected ad${a.disapprovedAds === 1 ? '' : 's'} in ${a.name}`, detail: `Meta rejected ${a.disapprovedAds} ad${a.disapprovedAds === 1 ? '' : 's'}. They do not run until fixed.`, evidence: { rejectedAds: a.disapprovedAds, activeAds: a.activeAds }, causes: ['Ad policy (text, image or landing page)', 'Special ad category rules'], suggestion: 'Open the account in Ads Manager, read the rejection reason, and edit or appeal.', link: `/live/${a.id}` });
    }
    // Spend spike or stall: today vs the average of the previous 7 full days.
    const series = input.daily.get(a.id) ?? [];
    const prior = series.filter((d) => d.date < input.today).slice(-7);
    const todayRow = series.find((d) => d.date === input.today);
    const avg = prior.length >= 3 ? prior.reduce((n, d) => n + d.spend, 0) / prior.length : null;
    if (avg != null && avg >= minSpend && todayRow && todayRow.spend > avg * 2) {
      out.push({ key: `spike:${a.id}`, kind: 'spend_spike', severity: 'warning', confidence: prior.length >= 7 ? 'high' : 'medium', accountRowId: a.id, accountName: a.name, title: `Spend spike today in ${a.name}`, detail: `${money(todayRow.spend, c)} spent today so far against an average of ${money(Math.round(avg * 100) / 100, c)} a day over the last ${prior.length} days (${pct(todayRow.spend, avg)}% more).`, evidence: { today: todayRow.spend, avgPerDay: Math.round(avg * 100) / 100, days: prior.length }, causes: ['A budget was raised', 'A new campaign or ad set started', 'A lifetime budget is catching up'], suggestion: 'Check the Budgets page and the campaign list for what changed today.', link: `/live/${a.id}` });
    }
    if (avg != null && avg >= minSpend && a.activeCampaigns > 0 && todayRow && todayRow.spend === 0 && prior.at(-1) && prior.at(-1)!.spend > 0) {
      out.push({ key: `stall:${a.id}`, kind: 'stalled_delivery', severity: 'warning', confidence: 'medium', accountRowId: a.id, accountName: a.name, title: `No spend today in ${a.name}`, detail: `${a.activeCampaigns} active campaign${a.activeCampaigns === 1 ? '' : 's'}, but nothing spent today, after ${money(prior.at(-1)!.spend, c)} yesterday.`, evidence: { yesterday: prior.at(-1)!.spend, activeCampaigns: a.activeCampaigns }, causes: ['Payment or balance problem', 'Ads rejected or in review', 'Ad schedule hours have not started yet', 'Sync is behind'], suggestion: 'Check the Balance page first, then the ads in Ads Manager.', link: '/balance' });
    }
    // Spend with no results in the period.
    const resultCount = a.results.reduce((n, r) => n + r.count, 0);
    if (a.spend >= Math.max(minSpend * 4, 20) && resultCount === 0 && a.leads + a.calls + a.messages === 0) {
      out.push({ key: `noresults:${a.id}`, kind: 'spend_no_results', severity: 'warning', confidence: 'high', accountRowId: a.id, accountName: a.name, title: `${money(a.spend, c)} spent with no results in ${a.name}`, detail: `No leads, calls, messages or other results in this period, with ${a.clicks} clicks and ${a.impressions.toLocaleString('en')} impressions.`, evidence: { spend: a.spend, clicks: a.clicks, impressions: a.impressions }, causes: ['Wrong objective or destination for what you count as a result', 'Landing page or Page problem', 'Audience too broad or too narrow'], suggestion: 'Compare with an account that gets results on the same ad; if the ad is the same, the difference is usually the Page or the audience.', link: `/live/${a.id}` });
    }
  }

  // Cost per result compared with the other accounts (same currency, same result type).
  const byKey = new Map<string, { a: (typeof input.accounts)[number]; costPer: number; count: number; label: string }[]>();
  for (const a of input.accounts) {
    const top = a.results[0];
    if (!a.synced || !top || top.costPer == null || top.count < 3 || a.spend < minSpend * 2) continue;
    const key = `${a.currency}:${top.type}`;
    byKey.set(key, [...(byKey.get(key) ?? []), { a, costPer: top.costPer, count: top.count, label: top.label }]);
  }
  for (const [key, list] of byKey) {
    if (list.length < 3) continue;
    const med = median(list.map((x) => x.costPer))!;
    const c = key.split(':')[0];
    for (const x of list) {
      if (x.costPer > med * 1.6) {
        out.push({ key: `costhigh:${x.a.id}`, kind: 'cost_per_result_high', severity: 'warning', confidence: list.length >= 5 ? 'high' : 'medium', accountRowId: x.a.id, accountName: x.a.name, title: `Expensive ${x.label.toLowerCase()} in ${x.a.name}`, detail: `${money(x.costPer, c)} per ${x.label.toLowerCase()} (${x.count} so far) against a typical ${money(Math.round(med * 100) / 100, c)} across ${list.length} accounts running the same kind of ad.`, evidence: { costPer: x.costPer, typical: Math.round(med * 100) / 100, results: x.count, accountsCompared: list.length }, causes: ['Audience or placement difference', 'Page or phone number quality', 'Ad fatigue in this account'], suggestion: `Consider moving budget from this account to the cheaper ones on the Budgets page (step down here, step up there).`, link: '/budgets' });
      } else if (x.costPer < med * 0.6 && x.count >= 5) {
        out.push({ key: `costlow:${x.a.id}`, kind: 'cost_per_result_low', severity: 'good', confidence: list.length >= 5 ? 'high' : 'medium', accountRowId: x.a.id, accountName: x.a.name, title: `Cheap ${x.label.toLowerCase()} in ${x.a.name}`, detail: `${money(x.costPer, c)} per ${x.label.toLowerCase()} (${x.count}) against a typical ${money(Math.round(med * 100) / 100, c)}.`, evidence: { costPer: x.costPer, typical: Math.round(med * 100) / 100, results: x.count, accountsCompared: list.length }, causes: [], suggestion: 'This account can probably take more budget. Raise it on the Budgets page and watch the cost for two days.', link: '/budgets' });
      }
    }
  }

  for (const b of input.balances) {
    if (b.daysLeft != null && b.daysLeft < 3) {
      out.push({ key: `balance:${b.id}`, kind: 'low_balance', severity: b.daysLeft < 1 ? 'critical' : 'warning', confidence: 'high', accountRowId: b.id, accountName: b.name, title: `Money runs out in ${b.daysLeft < 1 ? 'under a day' : `${b.daysLeft} days`}: ${b.name}`, detail: `${money(b.remaining, b.currency)} left at ${money(b.avgDailySpend, b.currency)} a day.`, evidence: { remaining: b.remaining, avgDailySpend: b.avgDailySpend, daysLeft: b.daysLeft }, causes: [b.kind === 'prepaid' ? 'Prepaid funds are nearly used up' : 'The spending limit is nearly reached'], suggestion: 'Add funds or raise the spending limit on Meta’s billing page before the ads stop.', link: '/balance' });
    }
  }

  for (const l of input.launches) {
    if (l.failed > 0) out.push({ key: `launch:${l.id}`, kind: 'launch_failed', severity: 'warning', confidence: 'high', accountRowId: null, accountName: null, title: `${l.failed} account${l.failed === 1 ? '' : 's'} failed in launch “${l.name}”`, detail: `${l.failed} row${l.failed === 1 ? '' : 's'} stopped with an error from Meta${l.pending ? `, ${l.pending} still in progress` : ''}.`, evidence: { failed: l.failed, pending: l.pending }, causes: ['Page permission', 'Meta rejected the creative', 'Token or rate limit'], suggestion: 'Open Publishing, read the error on each row and press Retry.', link: `/publishing?launch=${l.id}` });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || (a.accountName ?? '').localeCompare(b.accountName ?? ''));
}

export async function findings(user: User, period: AiPeriod, groupId?: number): Promise<{ findings: Finding[]; period: AiPeriod; accounts: number }> {
  const accounts = await accountSummaries(user, period, groupId);
  const campaigns = await campaignSummaries(user, period, { groupId, onlyWithSpendOrActive: true });
  const balances = await balanceSummaries(user, groupId);
  const daily = await dailySpendSeries(accounts.map((a) => a.id));
  const launches = await query<any>(
    `SELECT l.id, l.name, SUM(i.status IN ('failed','needs_review')) AS failed, SUM(i.status IN ('queued','working')) AS pending
       FROM launches l LEFT JOIN launch_items i ON i.launch_id=l.id WHERE l.org_id=? AND l.created_at > NOW() - INTERVAL 7 DAY GROUP BY l.id`,
    [user.orgId],
  );
  const today = new Date().toISOString().slice(0, 10);
  return {
    findings: computeFindings({ accounts, campaigns, balances, daily, launches: launches.map((l) => ({ id: Number(l.id), name: l.name, failed: Number(l.failed ?? 0), pending: Number(l.pending ?? 0) })), today }),
    period,
    accounts: accounts.length,
  };
}

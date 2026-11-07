import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { asyncHandler, parse } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { requirePermission } from '../auth/sessions.js';
import { decryptConnectionToken } from '../meta/connections.js';
import { graph, MetaApiError } from '../meta/graph.js';
import { majorToMinor, minorToMajor } from '../meta/live.js';
import { audit } from '../services/audit.js';
import { managedAccounts } from './live.js';

/**
 * Ad set budget changes down the panel's account order ("stepped budgets": start 20, step 2 gives 20, 22, 24 …).
 * Plan is read-only and uses synced data. Apply writes to Meta one ad set at a time, in order, and reads each
 * budget back from Meta before calling it done. Nothing is written without an explicit confirm.
 */
export const budgetsRouter = Router();

type RowStatus = 'ready' | 'choose' | 'cbo' | 'lifetime' | 'none' | 'skipped';

const money = z.number().finite().min(0).max(1_000_000_000);
const planInput = z.object({
  group: z.number().int().positive().optional(),
  mode: z.enum(['stepped', 'same', 'add']).default('stepped'),
  start: money.default(0),
  step: z.number().finite().min(-1_000_000).max(1_000_000).default(0),
  /** accountRowId -> adsetId, for accounts with more than one ad set. */
  choices: z.record(z.string(), z.string().regex(/^\d+$/)).default({}),
  /** Accounts left out of this change. Later accounts move up and take the next amounts. */
  skip: z.array(z.number().int().positive()).max(5000).default([]),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function planBudgets(user: Express.Request['user'] & {}, input: z.infer<typeof planInput>) {
  if (input.group) {
    const g = await queryOne(`SELECT id FROM account_groups WHERE id=? AND org_id=?`, [input.group, user.orgId]);
    if (!g) throw new AppError({ code: 'NOT_FOUND', message: 'Account group was not found.', status: 404, category: 'not_found' });
  }
  const accounts = await managedAccounts(user, undefined, input.group);
  const ids = accounts.map((a) => Number(a.id));
  const adsets = ids.length
    ? await query<any>(
        `SELECT s.ad_account_row_id, s.adset_id, s.name, s.status, s.effective_status, s.daily_budget_minor, s.lifetime_budget_minor,
                c.campaign_id, c.name AS campaign_name, c.effective_status AS campaign_status, c.daily_budget_minor AS c_daily, c.lifetime_budget_minor AS c_life
           FROM meta_adsets s JOIN meta_campaigns c ON c.ad_account_row_id=s.ad_account_row_id AND c.campaign_id=s.campaign_id
          WHERE s.ad_account_row_id IN (?)
          ORDER BY s.effective_status='ACTIVE' DESC, s.name`,
        [ids],
      )
    : [];
  const skip = new Set(input.skip);
  let pos = 0;
  const rows = accounts.map((a) => {
    const id = Number(a.id);
    const mine = adsets.filter((s) => Number(s.ad_account_row_id) === id);
    const abo = mine.filter((s) => s.c_daily == null && s.c_life == null && s.daily_budget_minor != null);
    const options = abo.map((s) => ({
      adsetId: s.adset_id, name: s.name, campaignName: s.campaign_name, effectiveStatus: s.effective_status,
      dailyBudget: minorToMajor(s.daily_budget_minor, a.currency),
    }));
    const active = abo.filter((s) => s.effective_status === 'ACTIVE');
    const chosenId = input.choices[String(id)];
    const chosen = abo.find((s) => s.adset_id === chosenId) ?? (active.length === 1 ? active[0] : undefined);
    let status: RowStatus;
    if (skip.has(id)) status = 'skipped';
    else if (chosen) status = 'ready';
    else if (abo.length) status = 'choose';
    else if (mine.some((s) => s.c_daily != null || s.c_life != null)) status = 'cbo';
    else if (mine.some((s) => s.lifetime_budget_minor != null)) status = 'lifetime';
    else status = 'none';
    const current = chosen ? minorToMajor(chosen.daily_budget_minor, a.currency) : null;
    let next: number | null = null;
    let position: number | null = null;
    if (status === 'ready') {
      position = ++pos;
      next = input.mode === 'stepped' ? input.start + input.step * (position - 1) : input.mode === 'same' ? input.start : (current ?? 0) + input.step;
      next = round2(next);
    }
    return {
      accountRowId: id, accountId: a.account_id, name: a.name, currency: a.currency, status, position,
      adsetId: chosen?.adset_id ?? null, adsetName: chosen?.name ?? null, campaignName: chosen?.campaign_name ?? null,
      adsetStatus: chosen?.effective_status ?? null, current, next,
      problem: next != null && next <= 0 ? 'The new budget must be more than zero.' : null,
      options,
    };
  });
  const ready = rows.filter((r) => r.status === 'ready');
  const currencies = [...new Set(ready.map((r) => r.currency))];
  return {
    rows,
    summary: {
      ready: ready.length,
      needChoice: rows.filter((r) => r.status === 'choose').length,
      cannot: rows.filter((r) => r.status === 'cbo' || r.status === 'lifetime' || r.status === 'none').length,
      currencies,
      totals: currencies.map((c) => ({
        currency: c,
        current: round2(ready.filter((r) => r.currency === c).reduce((n, r) => n + (r.current ?? 0), 0)),
        next: round2(ready.filter((r) => r.currency === c).reduce((n, r) => n + (r.next ?? 0), 0)),
      })),
    },
  };
}

budgetsRouter.post(
  '/budgets/plan',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    res.json(await planBudgets(req.user!, parse(planInput, req.body ?? {})));
  }),
);

const applyInput = z.object({
  confirm: z.literal(true, { message: 'Confirm the change first.' }),
  items: z
    .array(z.object({ accountRowId: z.number().int().positive(), adsetId: z.string().regex(/^\d+$/), dailyBudget: z.number().finite().positive().max(1_000_000_000) }))
    .min(1)
    .max(500),
});

type ItemStatus = 'done' | 'mismatch' | 'failed' | 'not_attempted';

budgetsRouter.post(
  '/budgets/apply',
  requirePermission('campaigns.manage', 'change budgets on Meta'),
  asyncHandler(async (req, res) => {
    const input = parse(applyInput, req.body);
    const user = req.user!;
    const seen = new Set<string>();
    for (const it of input.items) {
      if (seen.has(it.adsetId)) throw new AppError({ code: 'DUPLICATE_ADSET', message: 'The same ad set appears twice.', status: 400, category: 'validation' });
      seen.add(it.adsetId);
    }
    const accounts = new Map((await managedAccounts(user)).map((a) => [Number(a.id), a]));
    const rows = await query<any>(
      `SELECT a.id AS account_row_id, a.currency, c.token_ciphertext, c.status AS connection_status, s.adset_id, s.name, s.daily_budget_minor
         FROM meta_adsets s JOIN meta_ad_accounts a ON a.id=s.ad_account_row_id JOIN meta_connections c ON c.id=a.connection_id
        WHERE a.org_id=? AND s.adset_id IN (?)`,
      [user.orgId, input.items.map((i) => i.adsetId)],
    );
    // Check everything before the first write, so a bad item cannot leave a half-done batch.
    const plan = input.items.map((it, i) => {
      const r = rows.find((x) => x.adset_id === it.adsetId && Number(x.account_row_id) === it.accountRowId);
      if (!accounts.has(it.accountRowId) || !r)
        throw new AppError({ code: 'ADSET_NOT_IN_WORKING_ACCOUNT', message: `Item ${i + 1}: the ad set is not in one of your working accounts. Refresh the preview and try again.`, status: 400, category: 'validation' });
      return { ...it, position: i + 1, row: r, newMinor: majorToMinor(it.dailyBudget, r.currency) };
    });

    const batchId = randomUUID();
    const results: any[] = [];
    let stopReason: string | null = null;
    for (const p of plan) {
      const base = { accountRowId: p.accountRowId, accountName: accounts.get(p.accountRowId)!.name, adsetId: p.adsetId, adsetName: p.row.name, currency: p.row.currency, position: p.position, requested: p.dailyBudget };
      if (stopReason) {
        results.push({ ...base, status: 'not_attempted' as ItemStatus, error: stopReason });
        await record(p, 'not_attempted', null, null, null, 'STOPPED', stopReason);
        continue;
      }
      let before: number | null = null;
      try {
        const token = decryptConnectionToken(p.row);
        const read = async () =>
          (await graph<any>({ path: p.adsetId, params: { fields: 'daily_budget,lifetime_budget,effective_status,campaign{daily_budget,lifetime_budget}' }, accessToken: token, operation: 'meta.budget.read' })).data;
        const cur = await read();
        before = cur.daily_budget != null ? Number(cur.daily_budget) : null;
        if (cur.campaign?.daily_budget || cur.campaign?.lifetime_budget)
          throw new AppError({ code: 'CAMPAIGN_BUDGET', message: 'This ad set’s campaign now uses a campaign budget, so the ad set has no budget of its own.', status: 409, category: 'validation' });
        if (before == null)
          throw new AppError({ code: 'NO_DAILY_BUDGET', message: 'This ad set has no daily budget on Meta (it may use a lifetime budget).', status: 409, category: 'validation' });
        try {
          await graph({ method: 'POST', path: p.adsetId, params: { daily_budget: p.newMinor }, accessToken: token, operation: 'meta.budget.update' });
        } catch (err) {
          // A timeout after sending may still have changed the budget: the read-back below decides.
          if (!(err instanceof MetaApiError && err.meta.class === 'ambiguous')) throw err;
        }
        const after = await read();
        const confirmed = after.daily_budget != null ? Number(after.daily_budget) : null;
        const status: ItemStatus = confirmed === p.newMinor ? 'done' : 'mismatch';
        if (confirmed != null) await execute(`UPDATE meta_adsets SET daily_budget_minor=? WHERE ad_account_row_id=? AND adset_id=?`, [confirmed, p.accountRowId, p.adsetId]);
        await record(p, status, before, confirmed, batchId, status === 'mismatch' ? 'READBACK_MISMATCH' : null, status === 'mismatch' ? 'Meta reports a different budget after the change.' : null);
        results.push({ ...base, status, before: minorToMajor(before, p.row.currency), confirmed: minorToMajor(confirmed, p.row.currency) });
      } catch (err: any) {
        const msg = String(err?.message ?? err).slice(0, 1000);
        const code = err?.code ?? 'UNKNOWN';
        await record(p, 'failed', before, null, batchId, code, msg);
        results.push({ ...base, status: 'failed' as ItemStatus, before: minorToMajor(before, p.row.currency), error: msg, code, hint: err?.hint });
        if (err instanceof MetaApiError && (err.meta.class === 'rate_limited' || err.meta.class === 'auth'))
          stopReason = err.meta.class === 'auth' ? 'Stopped: the Meta login needs reconnecting.' : 'Stopped: Meta is rate-limiting. Try the rest again in a few minutes.';
        logger.warn({ adsetId: p.adsetId, code }, 'budget change failed');
      }
    }

    async function record(p: (typeof plan)[number], status: string, before: number | null, confirmed: number | null, _b: string | null, code: string | null, message: string | null) {
      await execute(
        `INSERT INTO budget_changes (org_id, batch_id, user_id, ad_account_row_id, adset_id, adset_name, position, currency, old_daily_budget_minor, new_daily_budget_minor, confirmed_daily_budget_minor, status, error_code, error_message)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [user.orgId, batchId, user.id, p.accountRowId, p.adsetId, p.row.name, p.position, p.row.currency, before, p.newMinor, confirmed, status, code, message],
      );
    }

    const count = (s: ItemStatus) => results.filter((r) => r.status === s).length;
    await audit({ orgId: user.orgId, actorUserId: user.id, action: 'budgets.changed', targetType: 'org', details: { batchId, items: results.length, done: count('done'), failed: count('failed'), mismatch: count('mismatch'), notAttempted: count('not_attempted') }, ip: req.ip });
    res.json({ batchId, results, summary: { done: count('done'), failed: count('failed'), mismatch: count('mismatch'), notAttempted: count('not_attempted') } });
  }),
);

budgetsRouter.get(
  '/budgets/history',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT b.batch_id, b.created_at, b.position, b.adset_id, b.adset_name, b.currency, b.old_daily_budget_minor, b.new_daily_budget_minor,
              b.confirmed_daily_budget_minor, b.status, b.error_message, a.name AS account_name, u.name AS user_name
         FROM budget_changes b JOIN meta_ad_accounts a ON a.id=b.ad_account_row_id LEFT JOIN users u ON u.id=b.user_id
        WHERE b.org_id=? ORDER BY b.created_at DESC, b.position LIMIT 300`,
      [req.user!.orgId],
    );
    const batches = new Map<string, any>();
    for (const r of rows) {
      const b = batches.get(r.batch_id) ?? { batchId: r.batch_id, at: r.created_at, by: r.user_name, items: [] as any[] };
      b.items.push({
        position: r.position, accountName: r.account_name, adsetId: r.adset_id, adsetName: r.adset_name, currency: r.currency, status: r.status, error: r.error_message,
        before: minorToMajor(r.old_daily_budget_minor, r.currency), requested: minorToMajor(r.new_daily_budget_minor, r.currency), confirmed: minorToMajor(r.confirmed_daily_budget_minor, r.currency),
      });
      batches.set(r.batch_id, b);
    }
    res.json({ batches: [...batches.values()].map((b) => ({ ...b, items: b.items.sort((x: any, y: any) => x.position - y.position) })) });
  }),
);

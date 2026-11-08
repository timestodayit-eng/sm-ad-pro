import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { asyncHandler, parse } from '../lib/http.js';
import { requirePermission } from '../auth/sessions.js';
import { minorToMajor } from '../meta/live.js';
import { audit } from '../services/audit.js';
import {
  BUYING_TYPES, DEFAULT_PLACEMENTS, GOALS, OBJECTIVES, PLACEMENTS, SEARCH_TYPES, STAGE_LABEL, WEBSITE_CTAS, cancelItem, createLaunch, customAudiencesFor, launchInput, pagesFor, planLaunch, retryItem, searchTargeting, sheetTemplate, sheetToRows,
} from '../services/launch.js';
import { managedAccounts } from './live.js';

/** Easy Ads: plan (read-only), launch (after an explicit confirm), and live progress per account. */
export const launchesRouter = Router();

async function readyVideos(orgId: number) {
  return query<any>(`SELECT id, original_name, kind, status, duration_ms FROM media_assets WHERE org_id=? AND kind='video' AND status='ready' ORDER BY id DESC LIMIT 500`, [orgId]);
}

launchesRouter.get(
  '/launch/setup',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const accounts = await managedAccounts(user);
    const ids = accounts.map((a) => Number(a.id));
    const defaults = ids.length ? await query<any>(`SELECT * FROM account_defaults WHERE ad_account_row_id IN (?)`, [ids]) : [];
    const conns = ids.length ? await query<any>(`SELECT id, connection_id FROM meta_ad_accounts WHERE id IN (?)`, [ids]) : [];
    const pages = await pagesFor(user.orgId);
    const groups = await query<any>(
      `SELECT g.id, g.name, GROUP_CONCAT(m.ad_account_row_id) AS members FROM account_groups g LEFT JOIN account_group_members m ON m.group_id=g.id WHERE g.org_id=? GROUP BY g.id ORDER BY g.name`,
      [user.orgId],
    );
    res.json({
      groups: groups.map((g) => ({ id: Number(g.id), name: g.name, accountIds: String(g.members ?? '').split(',').filter(Boolean).map(Number).filter((id) => ids.includes(id)) })),
      accounts: accounts.map((a, i) => {
        const d = defaults.find((x) => Number(x.ad_account_row_id) === Number(a.id));
        const connectionId = Number(conns.find((c) => Number(c.id) === Number(a.id))?.connection_id);
        return {
          id: Number(a.id), position: i + 1, accountId: a.account_id, name: a.name, currency: a.currency, connectionStatus: a.connection_status,
          pageId: d?.page_id ?? null, phone: d?.phone_number ?? null, website: d?.website_url ?? null, connectionId,
        };
      }),
      pages: pages.map((p) => ({ id: p.page_id, name: p.name, connectionId: Number(p.connection_id), canAdvertise: !p.tasks || String(p.tasks).includes('ADVERTISE') })),
      videos: (await readyVideos(user.orgId)).map((v) => ({ id: Number(v.id), name: v.original_name, durationMs: v.duration_ms })),
      goals: Object.fromEntries(Object.entries(GOALS).map(([k, v]) => [k, Object.entries(v).map(([o, g]) => ({ value: o, label: g.label }))])),
      buyingTypes: BUYING_TYPES,
      objectives: Object.entries(OBJECTIVES).map(([value, o]) => ({ value, label: o.label, note: o.note ?? null, call: o.call ? Object.entries(o.call).map(([k, v]) => ({ value: k, label: v.label })) : null, website: o.website ? Object.entries(o.website).map(([k, v]) => ({ value: k, label: v.label })) : null })),
      ctas: WEBSITE_CTAS,
      placements: Object.entries(PLACEMENTS).map(([value, p]) => ({ value, label: p.label })),
      defaultPlacements: DEFAULT_PLACEMENTS,
    });
  }),
);

launchesRouter.get(
  '/launch/sheet-template.csv',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const accounts = await managedAccounts(user);
    const ids = accounts.map((a) => Number(a.id));
    const defaults = ids.length ? await query<any>(`SELECT * FROM account_defaults WHERE ad_account_row_id IN (?)`, [ids]) : [];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="easy-ads-sheet.csv"');
    res.send(sheetTemplate(accounts, await pagesFor(user.orgId), defaults));
  }),
);

/** Reads an uploaded sheet and returns launch rows, or the lines that could not be read. Nothing is saved. */
launchesRouter.post(
  '/launch/sheet',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const { csv } = parse(z.object({ csv: z.string().min(1, 'The file is empty.').max(500_000, 'The file is too large.') }), req.body ?? {});
    const user = req.user!;
    res.json(sheetToRows(csv, await managedAccounts(user), await pagesFor(user.orgId), await readyVideos(user.orgId)));
  }),
);

/** Advanced Ads: Meta's own lists of places, interests, behaviours and languages. Read-only. */
launchesRouter.get(
  '/launch/search',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const { type, q } = parse(z.object({ type: z.enum(SEARCH_TYPES), q: z.string().trim().max(100).default('') }), req.query ?? {});
    if (!q && type !== 'behavior') return res.json({ items: [] });
    res.json({ items: await searchTargeting(req.user!.orgId, type, q) });
  }),
);

/** Advanced Ads: one account's custom and lookalike audiences, read live from Meta. */
launchesRouter.get(
  '/launch/accounts/:id/audiences',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await customAudiencesFor(req.user!.orgId, Number(req.params.id)) });
  }),
);

launchesRouter.post(
  '/launch/plan',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    res.json(await planLaunch(user, parse(launchInput, req.body ?? {}), await managedAccounts(user)));
  }),
);

launchesRouter.post(
  '/launches',
  requirePermission('campaigns.publish', 'create ads on Meta'),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if (body.confirm !== true) throw new AppError({ code: 'CONFIRM_REQUIRED', message: 'Review the plan and confirm it first.', status: 400, category: 'validation' });
    const user = req.user!;
    const input = parse(launchInput, body);
    const plan = await planLaunch(user, input, await managedAccounts(user));
    if (!plan.ready)
      throw new AppError({ code: 'PLAN_NOT_READY', message: plan.problems[0] ?? 'Some accounts still have problems. Fix them in the review and try again.', status: 400, category: 'validation', details: { problems: plan.problems } });
    const launchId = await createLaunch(user, input, plan);
    await audit({ orgId: user.orgId, actorUserId: user.id, action: 'launch.created', targetType: 'launch', targetId: String(launchId), details: { accounts: plan.rows.length, goal: input.goal, totals: plan.totals }, ip: req.ip });
    res.status(201).json({ id: launchId });
  }),
);

function publicItem(r: any, ads: any[] = []) {
  return {
    ads: ads.map((a) => ({ position: a.position, videoId: a.video_id, creativeId: a.creative_id, adId: a.ad_id, adStatus: a.ad_status, warning: a.warning })),
    id: Number(r.id), position: r.position, accountRowId: Number(r.ad_account_row_id), accountName: r.account_name, accountId: r.account_id,
    pageId: r.page_id, currency: r.currency, budget: minorToMajor(r.budget_minor, r.currency), budgetKind: r.budget_kind,
    status: r.status, stage: r.stage, stageLabel: STAGE_LABEL[r.stage] ?? r.stage,
    videoId: r.video_id, campaignId: r.campaign_id, adsetId: r.adset_id, creativeId: r.creative_id, adId: r.ad_id, adStatus: r.ad_status,
    error: r.error_message ? { code: r.error_code, message: r.error_message, hint: r.error_hint } : null,
    warning: (() => { try { return (typeof r.content === 'string' ? JSON.parse(r.content) : r.content)?.warning ?? null; } catch { return null; } })(),
    updatedAt: r.updated_at,
  };
}

launchesRouter.get(
  '/launches',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT l.id, l.name, l.goal, l.created_at, u.name AS user_name, COUNT(i.id) AS items,
              SUM(i.status='done') AS done, SUM(i.status IN ('failed','needs_review')) AS failed, SUM(i.status IN ('queued','working')) AS pending
         FROM launches l LEFT JOIN launch_items i ON i.launch_id=l.id LEFT JOIN users u ON u.id=l.user_id
        WHERE l.org_id=? GROUP BY l.id ORDER BY l.id DESC LIMIT 100`,
      [req.user!.orgId],
    );
    res.json({
      items: rows.map((r) => ({ id: Number(r.id), name: r.name, goal: r.goal, createdAt: r.created_at, by: r.user_name, items: Number(r.items), done: Number(r.done ?? 0), failed: Number(r.failed ?? 0), pending: Number(r.pending ?? 0) })),
    });
  }),
);

launchesRouter.get(
  '/launches/:id',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const l = await queryOne<any>(`SELECT l.*, u.name AS user_name FROM launches l LEFT JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.org_id=?`, [id, req.user!.orgId]);
    if (!l) throw new AppError({ code: 'NOT_FOUND', message: 'Launch was not found.', status: 404, category: 'not_found' });
    const items = await query<any>(
      `SELECT i.*, a.name AS account_name, a.account_id FROM launch_items i JOIN meta_ad_accounts a ON a.id=i.ad_account_row_id WHERE i.launch_id=? ORDER BY i.position`,
      [id],
    );
    const ads = items.length ? await query<any>(`SELECT * FROM launch_item_ads WHERE launch_item_id IN (?) ORDER BY launch_item_id, position`, [items.map((i) => Number(i.id))]) : [];
    const settings = typeof l.settings === 'string' ? JSON.parse(l.settings) : l.settings;
    res.json({ id, name: l.name, goal: l.goal, createdAt: l.created_at, by: l.user_name, settings, items: items.map((i) => publicItem(i, ads.filter((a) => Number(a.launch_item_id) === Number(i.id)))) });
  }),
);

launchesRouter.post(
  '/launches/:id/items/:itemId/retry',
  requirePermission('campaigns.publish', 'create ads on Meta'),
  asyncHandler(async (req, res) => {
    await retryItem(req.user!.orgId, Number(req.params.itemId));
    res.json({ ok: true });
  }),
);

launchesRouter.post(
  '/launches/:id/items/:itemId/cancel',
  requirePermission('campaigns.publish', 'create ads on Meta'),
  asyncHandler(async (req, res) => {
    await cancelItem(req.user!.orgId, Number(req.params.itemId));
    res.json({ ok: true });
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { execute, query, queryOne, transaction } from '../db/pool.js';
import { AppError, errors } from '../lib/errors.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { requirePermission } from '../auth/sessions.js';
import { enqueue } from '../jobs/queue.js';
import { buildAuthorizeUrl, handleCallback, listConnections } from '../meta/connections.js';
import { audit } from '../services/audit.js';

export const metaRouter = Router();

metaRouter.get(
  '/meta/connect-url',
  requirePermission('meta.connect', 'connect Meta accounts'),
  asyncHandler(async (req, res) => res.json({ url: await buildAuthorizeUrl(req.user!.id) })),
);

/**
 * Meta redirects the browser here. We always answer with a redirect back into the app,
 * carrying either success or a readable error code, never a raw JSON page.
 */
export const metaCallbackRouter = Router();
metaCallbackRouter.get('/meta/callback', async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const back = new URL('/accounts', env().APP_ORIGIN);
  try {
    const out = await handleCallback({ code: q.code, state: q.state, error: q.error, errorDescription: q.error_description }, req.ip);
    await enqueue({ queue: 'sync', type: 'meta.sync_accounts', payload: { connectionId: out.connectionId }, priority: 20 });
    back.searchParams.set('connected', out.metaUserName);
    if (out.missingScopes.length) back.searchParams.set('missing', out.missingScopes.join(','));
  } catch (err: any) {
    logger.warn({ err: err?.message, code: err?.code }, 'meta oauth callback failed');
    back.searchParams.set('error', err instanceof AppError ? err.code : 'META_OAUTH_FAILED');
    back.searchParams.set('message', (err?.message ?? 'Meta connection failed').slice(0, 300));
  }
  res.redirect(302, back.toString());
});

metaRouter.get(
  '/meta/connections',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => res.json({ items: await listConnections(req.user!.orgId) })),
);

metaRouter.post(
  '/meta/connections/:id/sync',
  requirePermission('accounts.manage', 'sync Meta accounts'),
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const c = await queryOne(`SELECT id FROM meta_connections WHERE id=? AND org_id=?`, [id, req.user!.orgId]);
    if (!c) throw errors.notFound('Meta connection');
    const jobId = await enqueue({ queue: 'sync', type: 'meta.sync_accounts', payload: { connectionId: id }, priority: 20 });
    await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'meta.sync_requested', targetType: 'meta_connection', targetId: id, ip: req.ip });
    res.status(202).json({ jobId });
  }),
);

/** Which accounts may this user see? Admins and all-accounts users see the whole org. */
export function accountScope(u: Express.Request['user'] & {}) {
  const all = u.allAccounts || ['super_admin', 'admin'].includes(u.role);
  return all
    ? { sql: 'a.org_id = ?', params: [u.orgId] as unknown[] }
    : { sql: 'a.org_id = ? AND a.id IN (SELECT ad_account_row_id FROM user_account_access WHERE user_id = ?)', params: [u.orgId, u.id] as unknown[] };
}

/** POST so large selections and filters never go into a URL (bug 14). No page-size cap beyond 500 rows per page. */
const searchSchema = z.object({
  q: z.string().trim().max(190).optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  managed: z.enum(['all', 'managed', 'unmanaged']).default('all'),
  groupId: z.number().int().positive().optional(),
  brandId: z.number().int().positive().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(50),
  sort: z.enum(['order', 'name', 'last_synced_at', 'currency']).default('order'),
});

metaRouter.post(
  '/accounts/search',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const f = parse(searchSchema, req.body ?? {});
    const scope = accountScope(req.user!);
    const where = [scope.sql, 'a.is_enabled = 1'];
    const params = [...scope.params];
    if (f.q) {
      where.push('(a.name LIKE ? OR a.account_id LIKE ? OR a.business_name LIKE ?)');
      const like = `%${f.q.replace(/[%_]/g, '\\$&')}%`;
      params.push(like, like, like);
    }
    if (f.managed === 'managed') where.push('a.is_managed = 1');
    if (f.managed === 'unmanaged') where.push('a.is_managed = 0');
    if (f.status === 'active') where.push('a.account_status = 1');
    if (f.status === 'inactive') where.push('(a.account_status IS NULL OR a.account_status <> 1)');
    if (f.groupId) {
      where.push('a.id IN (SELECT ad_account_row_id FROM account_group_members WHERE group_id = ?)');
      params.push(f.groupId);
    }
    if (f.brandId) {
      where.push('a.brand_id = ?');
      params.push(f.brandId);
    }
    if (f.currency) {
      where.push('a.currency = ?');
      params.push(f.currency);
    }
    const whereSql = where.join(' AND ');
    const total = await queryOne(`SELECT COUNT(*) AS n FROM meta_ad_accounts a WHERE ${whereSql}`, params);
    const order = f.sort === 'last_synced_at' ? 'a.last_synced_at DESC' : f.sort === 'currency' ? 'a.currency, a.name' : f.sort === 'name' ? 'a.name' : 'a.is_managed DESC, a.display_order IS NULL, a.display_order, a.name';
    const rows = await query(
      `SELECT a.id, a.account_id, a.name, a.currency, a.timezone_name, a.account_status, a.disable_reason, a.amount_spent_minor, a.spend_cap_minor,
              a.business_name, a.last_synced_at, a.last_sync_error, a.is_managed, a.live_synced_at, a.live_sync_error, b.name AS brand_name,
              c.status AS connection_status, c.meta_user_name, d.page_id, d.phone_number, d.website_url
         FROM meta_ad_accounts a
         JOIN meta_connections c ON c.id = a.connection_id
         LEFT JOIN brands b ON b.id = a.brand_id
         LEFT JOIN account_defaults d ON d.ad_account_row_id = a.id
        WHERE ${whereSql}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    );
    res.json({
      items: rows.map((r) => ({
        ...r,
        readiness: readiness(r),
      })),
      total: Number(total?.n ?? 0),
      page: f.page,
      pageSize: f.pageSize,
    });
  }),
);

/** Publishing readiness as far as it can be known in Phase 2. Never guesses; lists what is missing. */
function readiness(r: any): { level: 'ready' | 'warning' | 'blocked'; issues: string[] } {
  const issues: string[] = [];
  let blocked = false;
  if (r.connection_status !== 'active') {
    issues.push('Meta connection needs reconnecting');
    blocked = true;
  }
  if (r.account_status !== 1) {
    issues.push(`Account status ${r.account_status ?? 'unknown'} (not active)`);
    blocked = true;
  }
  if (!r.page_id) issues.push('No Facebook Page mapped');
  if (!r.last_synced_at) issues.push('Never synced');
  return { level: blocked ? 'blocked' : issues.length ? 'warning' : 'ready', issues };
}

metaRouter.get(
  '/accounts/pages',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    res.json({ items: await query(`SELECT page_id, name, ig_account_id, ig_username, tasks FROM meta_pages WHERE org_id=? ORDER BY name`, [req.user!.orgId]) });
  }),
);

const defaultsSchema = z.object({
  pageId: z.string().regex(/^\d+$/).nullable().optional(),
  igAccountId: z.string().regex(/^\d+$/).nullable().optional(),
  phoneNumber: z.string().regex(/^\+?[0-9 ()-]{6,20}$/, 'use international format, e.g. +8801XXXXXXXXX').nullable().optional(),
  websiteUrl: z.string().url().max(1024).nullable().optional(),
  brandId: z.number().int().positive().nullable().optional(),
});

metaRouter.put(
  '/accounts/:id/defaults',
  requirePermission('accounts.manage', 'change account defaults'),
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(defaultsSchema, req.body);
    const acc = await queryOne(`SELECT id, org_id FROM meta_ad_accounts WHERE id=? AND org_id=?`, [id, req.user!.orgId]);
    if (!acc) throw errors.notFound('Ad account');
    if (input.pageId) {
      // Never map a Page the connected Meta users cannot access (spec part 7).
      const page = await queryOne(`SELECT page_id FROM meta_pages WHERE org_id=? AND page_id=?`, [req.user!.orgId, input.pageId]);
      if (!page) throw errors.validation('That Facebook Page is not accessible through any connected Meta login.', { fields: { pageId: 'not accessible' } });
    }
    await transaction(async (conn) => {
      await execute(
        `INSERT INTO account_defaults (ad_account_row_id, page_id, ig_account_id, phone_number, website_url) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE page_id=VALUES(page_id), ig_account_id=VALUES(ig_account_id), phone_number=VALUES(phone_number), website_url=VALUES(website_url)`,
        [id, input.pageId ?? null, input.igAccountId ?? null, input.phoneNumber ?? null, input.websiteUrl ?? null],
        conn,
      );
      if (input.brandId !== undefined) await execute(`UPDATE meta_ad_accounts SET brand_id=? WHERE id=?`, [input.brandId, id], conn);
      await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'account.defaults_updated', targetType: 'ad_account', targetId: id, details: input, ip: req.ip }, conn);
    });
    res.json({ ok: true });
  }),
);

metaRouter.get(
  '/account-groups',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT g.id, g.name, g.description, g.brand_id, COUNT(a.id) AS members, COALESCE(SUM(a.is_managed=1 AND a.is_enabled=1), 0) AS managed
         FROM account_groups g LEFT JOIN account_group_members m ON m.group_id=g.id LEFT JOIN meta_ad_accounts a ON a.id=m.ad_account_row_id
        WHERE g.org_id=? GROUP BY g.id ORDER BY g.name`,
      [req.user!.orgId],
    );
    res.json({ items: rows.map((r) => ({ ...r, members: Number(r.members), managed: Number(r.managed) })) });
  }),
);

metaRouter.post(
  '/account-groups',
  requirePermission('accounts.manage', 'create account groups'),
  asyncHandler(async (req, res) => {
    const input = parse(z.object({ name: z.string().trim().min(2).max(190), description: z.string().max(512).optional(), accountIds: z.array(z.number().int().positive()).max(10000).default([]) }), req.body);
    const id = await transaction(async (conn) => {
      const dup = await queryOne(`SELECT id FROM account_groups WHERE org_id=? AND name=?`, [req.user!.orgId, input.name], conn);
      if (dup) throw new AppError({ code: 'GROUP_EXISTS', message: 'A group with this name already exists.', status: 409, category: 'conflict' });
      const g = await execute(`INSERT INTO account_groups (org_id, name, description, created_by) VALUES (?,?,?,?)`, [req.user!.orgId, input.name, input.description ?? null, req.user!.id], conn);
      if (input.accountIds.length) {
        const valid = await query(`SELECT id FROM meta_ad_accounts WHERE org_id=? AND id IN (?)`, [req.user!.orgId, input.accountIds], conn);
        for (const v of valid) await execute(`INSERT INTO account_group_members (group_id, ad_account_row_id) VALUES (?,?)`, [g.insertId, v.id], conn);
      }
      await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'account_group.created', targetType: 'account_group', targetId: g.insertId, details: { name: input.name, members: input.accountIds.length }, ip: req.ip }, conn);
      return g.insertId;
    });
    res.status(201).json({ id });
  }),
);

async function ownGroup(orgId: number, id: number, conn?: any) {
  const g = await queryOne<any>(`SELECT id, name, description FROM account_groups WHERE id=? AND org_id=?`, [id, orgId], conn);
  if (!g) throw errors.notFound('Account group');
  return g;
}

metaRouter.get(
  '/account-groups/:id',
  requirePermission('accounts.read'),
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const g = await ownGroup(req.user!.orgId, id);
    const members = await query<any>(
      `SELECT a.id, a.account_id, a.name, a.currency, a.is_managed, a.is_enabled FROM account_group_members m
         JOIN meta_ad_accounts a ON a.id=m.ad_account_row_id WHERE m.group_id=? ORDER BY a.name`,
      [id],
    );
    res.json({ id: Number(g.id), name: g.name, description: g.description, members: members.map((m) => ({ id: Number(m.id), accountId: m.account_id, name: m.name, currency: m.currency, managed: !!m.is_managed && !!m.is_enabled })) });
  }),
);

metaRouter.put(
  '/account-groups/:id',
  requirePermission('accounts.manage', 'edit account groups'),
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(z.object({ name: z.string().trim().min(2).max(190), description: z.string().max(512).nullable().optional(), accountIds: z.array(z.number().int().positive()).max(10000) }), req.body);
    await transaction(async (conn) => {
      await ownGroup(req.user!.orgId, id, conn);
      const dup = await queryOne(`SELECT id FROM account_groups WHERE org_id=? AND name=? AND id<>?`, [req.user!.orgId, input.name, id], conn);
      if (dup) throw new AppError({ code: 'GROUP_EXISTS', message: 'A group with this name already exists.', status: 409, category: 'conflict' });
      await execute(`UPDATE account_groups SET name=?, description=? WHERE id=?`, [input.name, input.description ?? null, id], conn);
      await execute(`DELETE FROM account_group_members WHERE group_id=?`, [id], conn);
      const valid = input.accountIds.length ? await query(`SELECT id FROM meta_ad_accounts WHERE org_id=? AND id IN (?)`, [req.user!.orgId, input.accountIds], conn) : [];
      for (const v of valid) await execute(`INSERT INTO account_group_members (group_id, ad_account_row_id) VALUES (?,?)`, [id, v.id], conn);
      await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'account_group.updated', targetType: 'account_group', targetId: id, details: { name: input.name, members: valid.length }, ip: req.ip }, conn);
    });
    res.json({ ok: true });
  }),
);

metaRouter.delete(
  '/account-groups/:id',
  requirePermission('accounts.manage', 'delete account groups'),
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const g = await ownGroup(req.user!.orgId, id);
    await execute(`DELETE FROM account_groups WHERE id=?`, [id]);
    await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'account_group.deleted', targetType: 'account_group', targetId: id, details: { name: g.name }, ip: req.ip });
    res.json({ ok: true });
  }),
);


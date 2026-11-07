import { Router } from 'express';
import { z } from 'zod';
import { db, execute, query, queryOne } from '../db/pool.js';
import { migrate, schemaStatus } from '../db/migrations.js';
import { hashPassword } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { requirePermission } from '../auth/sessions.js';
import { ROLES, ROLE_LABELS } from '../auth/rbac.js';
import { audit } from '../services/audit.js';
import { brandingSchema, getBranding, updateBranding } from '../services/settings.js';
export const adminRouter = Router();
adminRouter.get('/settings/branding', asyncHandler(async (req, res) => res.json(await getBranding(req.user.orgId))));
adminRouter.put('/settings/branding', requirePermission('settings.manage', 'change branding'), asyncHandler(async (req, res) => {
    const input = parse(brandingSchema, req.body);
    res.json(await updateBranding(req.user.orgId, req.user.id, input, req.ip));
}));
adminRouter.get('/admin/schema', requirePermission('schema.migrate', 'view database migrations'), asyncHandler(async (_req, res) => res.json(await schemaStatus(db()))));
adminRouter.post('/admin/schema/migrate', requirePermission('schema.migrate', 'apply database migrations'), asyncHandler(async (req, res) => {
    const out = await migrate(db(), req.user.email);
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'schema.migrated', details: { applied: out.applied }, ip: req.ip, correlationId: req.correlationId });
    res.json(out);
}));
adminRouter.get('/users', requirePermission('users.manage', 'manage users'), asyncHandler(async (req, res) => {
    const base = `SELECT id, email, name, role, ai_level, all_accounts, is_active, last_login_at, created_at`;
    // The two-step column exists only after migration 0003; keep this list working during an upgrade.
    const rows = await query(`${base}, totp_enabled_at IS NOT NULL AS mfa_enabled FROM users WHERE org_id=? ORDER BY created_at`, [req.user.orgId]).catch((err) => err?.code === 'ER_BAD_FIELD_ERROR' ? query(`${base}, NULL AS mfa_enabled FROM users WHERE org_id=? ORDER BY created_at`, [req.user.orgId]) : Promise.reject(err));
    res.json({ users: rows.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.role] ?? r.role })), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })) });
}));
const userInput = z.object({
    email: z.string().trim().toLowerCase().email().max(190),
    name: z.string().trim().min(2).max(190),
    role: z.enum(ROLES),
    password: z.string().min(12, 'use at least 12 characters').max(200),
    aiLevel: z.coerce.number().int().min(1).max(4).default(1),
    allAccounts: z.boolean().default(false),
});
adminRouter.post('/users', requirePermission('users.manage', 'create users'), asyncHandler(async (req, res) => {
    const input = parse(userInput, req.body);
    if (input.role === 'super_admin' && req.user.role !== 'super_admin')
        throw new AppError({ code: 'FORBIDDEN', message: 'Only a Super Admin can create another Super Admin.', status: 403, category: 'permission' });
    const exists = await queryOne(`SELECT id FROM users WHERE email=?`, [input.email]);
    if (exists)
        throw new AppError({ code: 'EMAIL_IN_USE', message: 'A user with this email already exists.', status: 409, category: 'conflict' });
    const r = await execute(`INSERT INTO users (org_id, email, name, password_hash, role, ai_level, all_accounts) VALUES (?,?,?,?,?,?,?)`, [req.user.orgId, input.email, input.name, await hashPassword(input.password), input.role, input.aiLevel, input.allAccounts ? 1 : 0]);
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'user.created', targetType: 'user', targetId: r.insertId, details: { email: input.email, role: input.role }, ip: req.ip });
    res.status(201).json({ id: r.insertId });
}));
adminRouter.patch('/users/:id', requirePermission('users.manage', 'change users'), asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const input = parse(z.object({ role: z.enum(ROLES).optional(), isActive: z.boolean().optional(), aiLevel: z.number().int().min(1).max(4).optional(), allAccounts: z.boolean().optional() }), req.body);
    if (id === req.user.id && (input.isActive === false || (input.role && input.role !== req.user.role))) {
        throw new AppError({ code: 'CANNOT_CHANGE_SELF', message: 'You cannot deactivate yourself or change your own role.', status: 400, category: 'validation' });
    }
    const target = await queryOne(`SELECT id, role FROM users WHERE id=? AND org_id=?`, [id, req.user.orgId]);
    if (!target)
        throw new AppError({ code: 'NOT_FOUND', message: 'User not found.', status: 404, category: 'not_found' });
    if ((target.role === 'super_admin' || input.role === 'super_admin') && req.user.role !== 'super_admin') {
        throw new AppError({ code: 'FORBIDDEN', message: 'Only a Super Admin can change a Super Admin.', status: 403, category: 'permission' });
    }
    await execute(`UPDATE users SET role=COALESCE(?, role), is_active=COALESCE(?, is_active), ai_level=COALESCE(?, ai_level), all_accounts=COALESCE(?, all_accounts) WHERE id=?`, [input.role ?? null, input.isActive == null ? null : input.isActive ? 1 : 0, input.aiLevel ?? null, input.allAccounts == null ? null : input.allAccounts ? 1 : 0, id]);
    if (input.isActive === false)
        await execute(`DELETE FROM sessions WHERE user_id=?`, [id]);
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'user.updated', targetType: 'user', targetId: id, details: input, ip: req.ip });
    res.json({ ok: true });
}));
adminRouter.get('/audit', requirePermission('audit.read', 'read the audit log'), asyncHandler(async (req, res) => {
    const { page, action } = parse(z.object({ page: z.coerce.number().int().min(1).default(1), action: z.string().max(100).optional() }), req.query);
    const size = 50;
    const rows = await query(`SELECT a.id, a.action, a.actor_kind, a.target_type, a.target_id, a.details, a.correlation_id, a.ip, a.created_at, u.name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
        WHERE (a.org_id=? OR a.org_id IS NULL) AND (? IS NULL OR a.action LIKE CONCAT(?, '%'))
        ORDER BY a.id DESC LIMIT ? OFFSET ?`, [req.user.orgId, action ?? null, action ?? null, size + 1, (page - 1) * size]);
    res.json({ items: rows.slice(0, size), hasMore: rows.length > size, page });
}));
//# sourceMappingURL=admin.js.map
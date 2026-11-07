import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, features } from '../config/env.js';
import { db, execute, queryOne, transaction } from '../db/pool.js';
import { migrate, schemaStatus } from '../db/migrations.js';
import { hashPassword, safeEqual, verifyPassword } from '../lib/crypto.js';
import { AppError, errors } from '../lib/errors.js';
import { asyncHandler, parse } from '../lib/http.js';
import { createSession, destroySession, MFA_REQUIRED_ROLES, requireAuth } from '../auth/sessions.js';
import { permissionsFor, ROLE_LABELS } from '../auth/rbac.js';
import { audit } from '../services/audit.js';
import { startChallenge } from './security.js';
import { getBranding, DEFAULT_BRANDING } from '../services/settings.js';
export const authRouter = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
async function userCount() {
    try {
        const r = await queryOne(`SELECT COUNT(*) AS n FROM users`);
        return Number(r?.n ?? 0);
    }
    catch (err) {
        if (err?.code === 'ER_NO_SUCH_TABLE')
            return null; // schema not installed yet
        throw err;
    }
}
/** Public: what the login/setup screens need before anyone signs in. Leaks nothing sensitive. */
authRouter.get('/public/bootstrap', asyncHandler(async (_req, res) => {
    const schema = await schemaStatus(db());
    const users = schema.current > 0 ? await userCount() : null;
    const branding = schema.current > 0 ? await getBranding().catch(() => DEFAULT_BRANDING) : DEFAULT_BRANDING;
    res.json({
        branding,
        schema: { current: schema.current, required: schema.required, upToDate: schema.upToDate, pending: schema.pending.length },
        setupRequired: !users,
        setupTokenRequired: env().NODE_ENV === 'production' || Boolean(env().SETUP_TOKEN),
    });
}));
function checkSetupToken(token) {
    const e = env();
    if (!e.SETUP_TOKEN) {
        if (e.NODE_ENV === 'production') {
            throw new AppError({ code: 'SETUP_TOKEN_NOT_SET', message: 'First-time setup is locked.', status: 403, category: 'configuration', hint: 'Set SETUP_TOKEN (16+ random characters) in the hosting environment, restart, and enter it here.' });
        }
        return;
    }
    if (!token || !safeEqual(token, e.SETUP_TOKEN)) {
        throw new AppError({ code: 'SETUP_TOKEN_INVALID', message: 'The setup token is not correct.', status: 403, category: 'auth' });
    }
}
/** First-time database install. Only allowed while no user exists; afterwards Super Admins use /api/admin/schema/migrate. */
authRouter.post('/setup/migrate', loginLimiter, asyncHandler(async (req, res) => {
    const { setupToken } = parse(z.object({ setupToken: z.string().optional() }), req.body ?? {});
    const users = await userCount();
    if (users)
        throw new AppError({ code: 'SETUP_ALREADY_DONE', message: 'Setup is already complete. Sign in as a Super Admin to apply upgrades.', status: 409, category: 'conflict' });
    checkSetupToken(setupToken);
    const out = await migrate(db(), 'setup');
    res.json({ applied: out.applied, schema: { current: out.status.current, required: out.status.required, upToDate: out.status.upToDate } });
}));
const setupSchema = z.object({
    setupToken: z.string().optional(),
    orgName: z.string().trim().min(2).max(190),
    name: z.string().trim().min(2).max(190),
    email: z.string().trim().toLowerCase().email().max(190),
    password: z.string().min(12, 'use at least 12 characters').max(200),
});
authRouter.post('/setup/admin', loginLimiter, asyncHandler(async (req, res) => {
    const input = parse(setupSchema, req.body);
    checkSetupToken(input.setupToken);
    const status = await schemaStatus(db());
    if (!status.upToDate)
        throw new AppError({ code: 'SCHEMA_NOT_READY', message: 'Install the database first.', status: 409, category: 'schema' });
    const hash = await hashPassword(input.password);
    const userId = await transaction(async (conn) => {
        const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM users FOR UPDATE`);
        if (Number(n) > 0)
            throw new AppError({ code: 'SETUP_ALREADY_DONE', message: 'Setup is already complete.', status: 409, category: 'conflict' });
        const org = await execute(`INSERT INTO orgs (name) VALUES (?)`, [input.orgName], conn);
        await execute(`INSERT INTO brands (org_id, name) VALUES (?,?)`, [org.insertId, input.orgName], conn);
        await execute(`INSERT INTO branding_settings (org_id) VALUES (?)`, [org.insertId], conn);
        const u = await execute(`INSERT INTO users (org_id, email, name, password_hash, role, ai_level, all_accounts) VALUES (?,?,?,?, 'super_admin', 1, 1)`, [org.insertId, input.email, input.name, hash], conn);
        await audit({ orgId: org.insertId, actorUserId: u.insertId, action: 'setup.completed', targetType: 'user', targetId: u.insertId, ip: req.ip }, conn);
        return u.insertId;
    });
    const csrf = await createSession(res, req, userId);
    res.status(201).json({ ok: true, csrfToken: csrf });
}));
authRouter.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
    const user = await queryOne(`SELECT * FROM users WHERE email=?`, [email]);
    const fail = new AppError({ code: 'LOGIN_FAILED', message: 'Email or password is incorrect.', status: 401, category: 'auth' });
    if (!user || !user.is_active) {
        await hashPassword(password); // equalise timing
        throw fail;
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw new AppError({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.', status: 429, category: 'auth' });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
        await execute(`UPDATE users SET failed_logins=failed_logins+1, locked_until=IF(failed_logins+1 >= 8, CURRENT_TIMESTAMP(3) + INTERVAL 15 MINUTE, NULL) WHERE id=?`, [user.id]);
        await audit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login_failed', ip: req.ip });
        throw fail;
    }
    if (user.totp_enabled_at) {
        // Password is right; the session is created only after the authenticator or recovery code (step 2).
        await execute(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?`, [user.id]);
        return res.json({ ok: true, mfaRequired: true, challenge: await startChallenge(Number(user.id)) });
    }
    await execute(`UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [user.id]);
    const csrf = await createSession(res, req, Number(user.id));
    await audit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login', ip: req.ip });
    res.json({ ok: true, csrfToken: csrf });
}));
authRouter.post('/auth/logout', asyncHandler(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
}));
authRouter.get('/auth/me', requireAuth, asyncHandler(async (req, res) => {
    const u = req.user;
    res.json({
        user: { ...u, roleLabel: ROLE_LABELS[u.role] ?? u.role },
        permissions: permissionsFor(u.role),
        csrfToken: req.csrfToken,
        branding: await getBranding(u.orgId),
        features: features(),
        mfa: { enabled: u.mfaEnabled, required: MFA_REQUIRED_ROLES.includes(u.role), setupRequired: u.mfaEnabled === false && MFA_REQUIRED_ROLES.includes(u.role) },
    });
}));
export function assertSelfOrAdmin(userId, targetId, role) {
    if (userId !== targetId && !['super_admin', 'admin'].includes(role))
        throw errors.forbidden('change other users');
}
//# sourceMappingURL=auth.js.map
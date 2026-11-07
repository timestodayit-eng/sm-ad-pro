import type { Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { execute, queryOne } from '../db/pool.js';
import { decryptSecret, encryptSecret, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { AppError, errors } from '../lib/errors.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { createSession, MFA_REQUIRED_ROLES, requireAuth, requireMfaSetup, requirePermission } from '../auth/sessions.js';
import { hashRecovery, newRecoveryCodes, newSecret, otpauthUrl, qrSvg, verifyTotp } from '../auth/totp.js';
import { audit } from '../services/audit.js';
import { getBranding } from '../services/settings.js';

/** Two-step login (TOTP) and recovery codes. */
export const securityRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

const CHALLENGE_MINUTES = 5;
const CHALLENGE_ATTEMPTS = 5;

const enc = (s: string) => encryptSecret(s, env().TOKEN_ENCRYPTION_KEY);
const dec = (s: string) => decryptSecret(s, env().TOKEN_ENCRYPTION_KEY);
const codeSchema = z.string().trim().min(6).max(20);

function codesOf(u: any): string[] {
  const v = u?.recovery_codes;
  return typeof v === 'string' ? JSON.parse(v) : (v ?? []);
}

/** Called by /auth/login after the password is accepted, for users with two-step login on. */
export async function startChallenge(userId: number): Promise<string> {
  const raw = randomToken(32);
  await execute(`DELETE FROM login_challenges WHERE user_id=? OR expires_at < UTC_TIMESTAMP(3)`, [userId]);
  await execute(`INSERT INTO login_challenges (id, user_id, expires_at) VALUES (?,?, UTC_TIMESTAMP(3) + INTERVAL ${CHALLENGE_MINUTES} MINUTE)`, [sha256(raw), userId]);
  return raw;
}

/**
 * Accepts a 6-digit authenticator code or a recovery code. Returns how it matched, or null.
 * Authenticator codes cannot be reused (replay); recovery codes are single use.
 */
async function checkCode(user: any, code: string): Promise<'totp' | 'recovery' | null> {
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    if (!user.totp_secret_enc) return null;
    const step = verifyTotp(dec(user.totp_secret_enc), digits, user.totp_last_step != null ? Number(user.totp_last_step) : null);
    if (step == null) return null;
    // Conditional update: two requests racing with the same code cannot both win.
    const r = await execute(`UPDATE users SET totp_last_step=? WHERE id=? AND (totp_last_step IS NULL OR totp_last_step < ?)`, [step, user.id, step]);
    return r.affectedRows ? 'totp' : null;
  }
  const codes = codesOf(user);
  const h = hashRecovery(code);
  if (!codes.includes(h)) return null;
  await execute(`UPDATE users SET recovery_codes=? WHERE id=?`, [JSON.stringify(codes.filter((c) => c !== h)), user.id]);
  return 'recovery';
}

/** Step 2 of sign-in. */
securityRouter.post(
  '/auth/login/verify',
  limiter,
  asyncHandler(async (req, res) => {
    const { challenge, code } = parse(z.object({ challenge: z.string().length(64), code: codeSchema }), req.body);
    const ch = await queryOne(`SELECT * FROM login_challenges WHERE id=? AND expires_at > UTC_TIMESTAMP(3)`, [sha256(challenge)]);
    if (!ch) throw new AppError({ code: 'MFA_CHALLENGE_EXPIRED', message: 'This sign-in attempt expired. Enter your password again.', status: 401, category: 'auth' });
    if (ch.attempts >= CHALLENGE_ATTEMPTS) {
      await execute(`DELETE FROM login_challenges WHERE id=?`, [ch.id]);
      throw new AppError({ code: 'MFA_TOO_MANY_ATTEMPTS', message: 'Too many wrong codes. Enter your password again.', status: 429, category: 'auth' });
    }
    const user = await queryOne(`SELECT * FROM users WHERE id=? AND is_active=1`, [ch.user_id]);
    if (!user) throw errors.unauthenticated();
    const how = await checkCode(user, code);
    if (!how) {
      await execute(`UPDATE login_challenges SET attempts=attempts+1 WHERE id=?`, [ch.id]);
      await audit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.mfa_failed', ip: req.ip });
      throw new AppError({ code: 'MFA_CODE_INVALID', message: 'That code is not correct.', status: 401, category: 'auth', hint: 'Use the 6-digit code shown now in your authenticator app, or one of your recovery codes.', details: { attemptsLeft: CHALLENGE_ATTEMPTS - ch.attempts - 1 } });
    }
    await execute(`DELETE FROM login_challenges WHERE id=?`, [ch.id]);
    await execute(`UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [user.id]);
    const csrf = await createSession(res, req, Number(user.id));
    const recoveryLeft = how === 'recovery' ? codesOf(await queryOne(`SELECT recovery_codes FROM users WHERE id=?`, [user.id])).length : null;
    await audit({ orgId: user.org_id, actorUserId: user.id, action: 'auth.login', details: { mfa: how }, ip: req.ip });
    res.json({ ok: true, csrfToken: csrf, usedRecoveryCode: how === 'recovery', recoveryCodesLeft: recoveryLeft });
  }),
);

async function me(req: Request) {
  const u = await queryOne(`SELECT * FROM users WHERE id=?`, [req.user!.id]);
  if (!u) throw errors.unauthenticated();
  return u;
}

securityRouter.get(
  '/auth/2fa',
  requireAuth,
  asyncHandler(async (req, res) => {
    const u = await me(req);
    const codes = codesOf(u);
    res.json({ enabled: Boolean(u.totp_enabled_at), enabledAt: u.totp_enabled_at, required: MFA_REQUIRED_ROLES.includes(u.role), recoveryCodesLeft: codes.length });
  }),
);

/** Starts setup: a new secret, kept as "pending" until the user proves their app shows the right codes. */
securityRouter.post(
  '/auth/2fa/setup',
  requireAuth,
  limiter,
  asyncHandler(async (req, res) => {
    const u = await me(req);
    if (u.totp_enabled_at) throw new AppError({ code: 'MFA_ALREADY_ON', message: 'Two-step login is already on.', status: 409, category: 'conflict' });
    const secret = newSecret();
    await execute(`UPDATE users SET totp_pending_enc=? WHERE id=?`, [enc(secret), u.id]);
    const issuer = (await getBranding(u.org_id)).panelName;
    const url = otpauthUrl(secret, u.email, issuer);
    res.json({ secret: secret.match(/.{1,4}/g)!.join(' '), otpauthUrl: url, qrSvg: await qrSvg(url) });
  }),
);

securityRouter.post(
  '/auth/2fa/enable',
  requireAuth,
  limiter,
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const u = await me(req);
    if (!u.totp_pending_enc) throw new AppError({ code: 'MFA_SETUP_NOT_STARTED', message: 'Start setup first.', status: 409, category: 'conflict' });
    const secret = dec(u.totp_pending_enc);
    const step = verifyTotp(secret, code, null);
    if (step == null) throw new AppError({ code: 'MFA_CODE_INVALID', message: 'That code does not match.', status: 400, category: 'validation', hint: 'Check the phone’s clock is set automatically, then enter the code currently shown.' });
    const rc = newRecoveryCodes();
    await execute(
      `UPDATE users SET totp_secret_enc=?, totp_pending_enc=NULL, totp_enabled_at=UTC_TIMESTAMP(3), totp_last_step=?, recovery_codes=? WHERE id=?`,
      [enc(secret), step, JSON.stringify(rc.hashed), u.id],
    );
    await audit({ orgId: u.org_id, actorUserId: u.id, action: 'auth.mfa_enabled', ip: req.ip, correlationId: req.correlationId });
    res.json({ enabled: true, recoveryCodes: rc.plain });
  }),
);

securityRouter.post(
  '/auth/2fa/recovery-codes',
  requireAuth,
  limiter,
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const u = await me(req);
    if (!u.totp_enabled_at) throw new AppError({ code: 'MFA_OFF', message: 'Two-step login is off.', status: 409, category: 'conflict' });
    if ((await checkCode(u, code)) !== 'totp') throw new AppError({ code: 'MFA_CODE_INVALID', message: 'Enter the 6-digit code from your authenticator app.', status: 400, category: 'validation' });
    const rc = newRecoveryCodes();
    await execute(`UPDATE users SET recovery_codes=? WHERE id=?`, [JSON.stringify(rc.hashed), u.id]);
    await audit({ orgId: u.org_id, actorUserId: u.id, action: 'auth.mfa_recovery_regenerated', ip: req.ip });
    res.json({ recoveryCodes: rc.plain });
  }),
);

securityRouter.post(
  '/auth/2fa/disable',
  requireAuth,
  limiter,
  asyncHandler(async (req, res) => {
    const { password, code } = parse(z.object({ password: z.string().min(1).max(200), code: codeSchema }), req.body);
    const u = await me(req);
    if (MFA_REQUIRED_ROLES.includes(u.role)) throw new AppError({ code: 'MFA_REQUIRED_FOR_ROLE', message: 'Admins must keep two-step login on.', status: 403, category: 'permission', hint: 'To move to a new phone, use "Get new recovery codes", or ask another Super Admin to reset it for you.' });
    if (!(await verifyPassword(password, u.password_hash)) || !(await checkCode(u, code))) throw new AppError({ code: 'MFA_CODE_INVALID', message: 'Password or code is not correct.', status: 400, category: 'validation' });
    await execute(`UPDATE users SET totp_secret_enc=NULL, totp_pending_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL, recovery_codes=NULL WHERE id=?`, [u.id]);
    await audit({ orgId: u.org_id, actorUserId: u.id, action: 'auth.mfa_disabled', ip: req.ip });
    res.json({ enabled: false });
  }),
);

/** A Super Admin resets someone's two-step login (lost phone). Their sessions end; they set it up again at next sign-in. */
securityRouter.post(
  '/users/:id/reset-2fa',
  requireAuth,
  requireMfaSetup,
  requirePermission('users.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    if (id === req.user!.id) throw new AppError({ code: 'MFA_RESET_SELF', message: 'Ask another Super Admin to reset your own two-step login.', status: 400, category: 'validation' });
    const target = await queryOne(`SELECT id, role FROM users WHERE id=? AND org_id=?`, [id, req.user!.orgId]);
    if (!target) throw errors.notFound('User');
    if (target.role === 'super_admin' && req.user!.role !== 'super_admin') throw errors.forbidden('reset a Super Admin');
    await execute(`UPDATE users SET totp_secret_enc=NULL, totp_pending_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL, recovery_codes=NULL WHERE id=?`, [id]);
    await execute(`DELETE FROM sessions WHERE user_id=?`, [id]);
    await audit({ orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'user.mfa_reset', targetType: 'user', targetId: id, ip: req.ip, correlationId: req.correlationId });
    res.json({ ok: true });
  }),
);

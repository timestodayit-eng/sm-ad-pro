import { env } from '../config/env.js';
import { execute, queryOne } from '../db/pool.js';
import { hmac, randomToken, safeEqual } from '../lib/crypto.js';
import { AppError, errors } from '../lib/errors.js';
import { can } from './rbac.js';
export const SESSION_COOKIE = 'acc_sid';
/** Roles that must use two-step login. */
export const MFA_REQUIRED_ROLES = ['super_admin', 'admin'];
/** The cookie holds a random id; the database stores its HMAC so a leaked DB dump cannot be replayed. */
const storedId = (raw) => hmac(env().SESSION_SECRET, raw);
export async function createSession(res, req, userId) {
    const raw = randomToken(32);
    const csrf = randomToken(32);
    const ttlMs = env().SESSION_TTL_HOURS * 3600_000;
    await execute(`INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, expires_at) VALUES (?,?,?,?,?,?)`, [storedId(raw), userId, csrf, req.ip ?? null, (req.get('user-agent') ?? '').slice(0, 255), new Date(Date.now() + ttlMs)]);
    res.cookie(SESSION_COOKIE, raw, {
        httpOnly: true,
        // Always Secure in production; elsewhere follow the actual request scheme (behind a proxy via trust proxy).
        secure: env().NODE_ENV === 'production' || req.secure,
        sameSite: 'lax',
        path: '/',
        maxAge: ttlMs,
    });
    return csrf;
}
export async function destroySession(req, res) {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw)
        await execute(`DELETE FROM sessions WHERE id=?`, [storedId(raw)]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
}
/** Loads the session (if any) on every request. Does not reject; use requireAuth for that. */
export async function loadSession(req, _res, next) {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (!raw || typeof raw !== 'string' || raw.length !== 64)
        return next();
    try {
        const row = await queryOne(`SELECT s.id AS sid, s.csrf_token, s.last_seen_at, u.id, u.org_id, u.email, u.name, u.role, u.ai_level, u.all_accounts
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id=? AND s.expires_at > CURRENT_TIMESTAMP(3) AND u.is_active=1`, [storedId(raw)]);
        if (row) {
            req.user = {
                id: Number(row.id),
                orgId: Number(row.org_id),
                email: row.email,
                name: row.name,
                role: row.role,
                aiLevel: Number(row.ai_level),
                allAccounts: Boolean(row.all_accounts),
                mfaEnabled: await queryOne(`SELECT totp_enabled_at FROM users WHERE id=?`, [row.id]).then((r) => Boolean(r?.totp_enabled_at), () => null),
            };
            req.sessionId = row.sid;
            req.csrfToken = row.csrf_token;
            if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
                execute(`UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [row.sid]).catch(() => undefined);
            }
        }
        next();
    }
    catch (err) {
        next(err);
    }
}
export function requireAuth(req, _res, next) {
    if (!req.user)
        return next(errors.unauthenticated());
    next();
}
/**
 * Admins without two-step login can only reach the endpoints needed to set it up (and to apply schema upgrades,
 * so an upgrade can never lock everyone out).
 */
const MFA_SETUP_ALLOWED = [/^\/auth\//, /^\/admin\/schema/, /^\/public\//];
export function requireMfaSetup(req, _res, next) {
    const u = req.user;
    if (u && u.mfaEnabled === false && MFA_REQUIRED_ROLES.includes(u.role) && !MFA_SETUP_ALLOWED.some((r) => r.test(req.path))) {
        return next(new AppError({
            code: 'MFA_SETUP_REQUIRED',
            message: 'Set up two-step login before using the panel.',
            status: 403,
            category: 'auth',
            hint: 'Open Settings → Security and scan the QR code with an authenticator app.',
        }));
    }
    next();
}
export function requirePermission(perm, what) {
    return (req, _res, next) => {
        if (!req.user)
            return next(errors.unauthenticated());
        if (!can(req.user.role, perm))
            return next(errors.forbidden(what ?? perm.replace('.', ' ')));
        next();
    };
}
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Origin + CSRF protection for state-changing requests (bug 15: never disabled to "fix" errors).
 * - Origin (or Referer) must equal APP_ORIGIN exactly.
 * - Signed-in requests must carry the session's CSRF token in X-CSRF-Token.
 */
export function originAndCsrf(req, _res, next) {
    if (SAFE_METHODS.has(req.method))
        return next();
    const origin = req.get('origin') ?? (req.get('referer') ? new URL(req.get('referer')).origin : undefined);
    if (origin !== env().APP_ORIGIN) {
        return next(Object.assign(errors.forbidden('send requests from this origin'), {
            code: 'ORIGIN_MISMATCH',
            message: `Request origin ${origin ?? '(none)'} does not match APP_ORIGIN.`,
            hint: `Open the app at ${env().APP_ORIGIN}. If that is the wrong address, fix APP_ORIGIN in the hosting environment.`,
        }));
    }
    if (req.user) {
        const sent = req.get('x-csrf-token') ?? '';
        if (!req.csrfToken || !safeEqual(sent, req.csrfToken)) {
            return next(Object.assign(errors.forbidden('submit this form'), {
                code: 'CSRF_INVALID',
                message: 'Security token missing or expired.',
                hint: 'Refresh the page and try again.',
            }));
        }
    }
    next();
}
//# sourceMappingURL=sessions.js.map
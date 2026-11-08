import { env, features } from '../config/env.js';
import { execute, query, queryOne, transaction } from '../db/pool.js';
import { decryptSecret, encryptSecret, randomToken } from '../lib/crypto.js';
import { AppError, errors } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { graph, graphBase, graphPaged, MetaApiError } from './graph.js';
/** Facebook Login for Business + account import. Tokens are encrypted at rest and never sent to the browser. */
export const REQUESTED_SCOPES = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement'];
function requireMeta() {
    if (!features().meta) {
        throw errors.notConfigured('Meta integration', ['META_APP_ID', 'META_APP_SECRET', 'META_API_VERSION', 'META_REDIRECT_URI']);
    }
}
export async function buildAuthorizeUrl(userId) {
    requireMeta();
    const e = env();
    const state = randomToken(32);
    await execute(`INSERT INTO oauth_states (state, user_id, expires_at) VALUES (?,?, CURRENT_TIMESTAMP(3) + INTERVAL 10 MINUTE)`, [state, userId]);
    const u = new URL(`https://www.facebook.com/${e.META_API_VERSION}/dialog/oauth`);
    u.searchParams.set('client_id', e.META_APP_ID);
    u.searchParams.set('redirect_uri', e.META_REDIRECT_URI);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    if (e.META_CONFIG_ID) {
        // Facebook Login for Business: permissions come from the configuration.
        u.searchParams.set('config_id', e.META_CONFIG_ID);
        u.searchParams.set('override_default_response_type', 'true');
    }
    else {
        u.searchParams.set('scope', REQUESTED_SCOPES.join(','));
    }
    return u.toString();
}
async function exchangeCode(code) {
    const e = env();
    const base = graphBase();
    const short = await fetch(`${base}/oauth/access_token?${new URLSearchParams({ client_id: e.META_APP_ID, client_secret: e.META_APP_SECRET, redirect_uri: e.META_REDIRECT_URI, code })}`, { signal: AbortSignal.timeout(20_000) });
    const sj = await short.json();
    if (!short.ok || sj.error) {
        throw new AppError({
            code: 'META_OAUTH_EXCHANGE_FAILED',
            message: sj?.error?.message ?? 'Meta did not accept the login code.',
            status: 502,
            category: 'external_meta',
            hint: 'Check that META_REDIRECT_URI exactly matches the Valid OAuth Redirect URI in the Meta app (same scheme, host, path, no trailing slash).',
        });
    }
    // Try to upgrade to a long-lived token; Login for Business tokens may already be long-lived.
    const long = await fetch(`${base}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: e.META_APP_ID, client_secret: e.META_APP_SECRET, fb_exchange_token: sj.access_token })}`, { signal: AbortSignal.timeout(20_000) });
    const lj = await long.json().catch(() => ({}));
    const token = long.ok && lj.access_token ? lj.access_token : sj.access_token;
    const expiresIn = long.ok && lj.access_token ? lj.expires_in : sj.expires_in;
    return { token, expiresAt: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null };
}
export async function inspectToken(token) {
    const e = env();
    const { data } = await graph({
        path: 'debug_token',
        params: { input_token: token },
        accessToken: `${e.META_APP_ID}|${e.META_APP_SECRET}`,
        operation: 'meta.debug_token',
    });
    const d = data?.data ?? {};
    return {
        valid: Boolean(d.is_valid),
        expiresAt: d.expires_at ? new Date(Number(d.expires_at) * 1000) : null,
        scopes: Array.isArray(d.scopes) ? d.scopes : [],
    };
}
/** OAuth callback: validates state, stores the encrypted token, then queues an account import. */
export async function handleCallback(params, ip) {
    requireMeta();
    if (params.error) {
        throw new AppError({ code: 'META_OAUTH_DENIED', message: params.errorDescription || 'Meta login was cancelled or denied.', status: 400, category: 'external_meta', hint: 'Try Connect Meta again and approve all requested permissions.' });
    }
    if (!params.code || !params.state)
        throw errors.validation('Missing code or state from Meta.');
    const st = await queryOne(`SELECT * FROM oauth_states WHERE state=? AND expires_at > CURRENT_TIMESTAMP(3)`, [params.state]);
    await execute(`DELETE FROM oauth_states WHERE state=?`, [params.state]);
    if (!st)
        throw new AppError({ code: 'META_OAUTH_STATE_INVALID', message: 'The login link expired or was already used.', status: 400, category: 'auth', hint: 'Start Connect Meta again from Ad Accounts.' });
    const user = await queryOne(`SELECT id, org_id FROM users WHERE id=? AND is_active=1`, [st.user_id]);
    if (!user)
        throw errors.unauthenticated();
    const { token, expiresAt } = await exchangeCode(params.code);
    const me = (await graph({ path: 'me', params: { fields: 'id,name' }, accessToken: token, operation: 'meta.me' })).data;
    let scopes = [];
    let tokenExpiry = expiresAt;
    try {
        const info = await inspectToken(token);
        scopes = info.scopes;
        tokenExpiry = info.expiresAt ?? expiresAt;
    }
    catch {
        /* debug_token is diagnostic only */
    }
    const e = env();
    const connectionId = await transaction(async (conn) => {
        await execute(`INSERT INTO meta_connections (org_id, connected_by, meta_user_id, meta_user_name, token_ciphertext, token_key_id, token_expires_at, scopes, status, last_checked_at, last_error)
       VALUES (?,?,?,?,?,?,?,?, 'active', CURRENT_TIMESTAMP(3), NULL)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), connected_by=VALUES(connected_by), meta_user_name=VALUES(meta_user_name),
         token_ciphertext=VALUES(token_ciphertext), token_key_id=VALUES(token_key_id), token_expires_at=VALUES(token_expires_at),
         scopes=VALUES(scopes), status='active', last_checked_at=CURRENT_TIMESTAMP(3), last_error=NULL`, [user.org_id, user.id, me.id, me.name, encryptSecret(token, e.TOKEN_ENCRYPTION_KEY), e.TOKEN_ENCRYPTION_KEY_ID, tokenExpiry, scopes.join(','),], conn);
        const [[row]] = await conn.query(`SELECT LAST_INSERT_ID() AS id`);
        await audit({ orgId: user.org_id, actorUserId: user.id, action: 'meta.connected', targetType: 'meta_connection', targetId: row.id, details: { metaUser: me.name, scopes }, ip }, conn);
        return Number(row.id);
    });
    const missing = REQUESTED_SCOPES.filter((s) => scopes.length && !scopes.includes(s));
    return { connectionId, metaUserName: me.name, missingScopes: missing };
}
export function decryptConnectionToken(row) {
    return decryptSecret(row.token_ciphertext, env().TOKEN_ENCRYPTION_KEY, 'the Meta login');
}
/** Imports every ad account and Page the connection can reach. No account-count limit (bug 14). */
export const MISSING_BUSINESS_MANAGEMENT = 'Imported without business names: this login did not grant business_management. Add business_management to your Facebook Login for Business configuration, then press Connect Meta again.';
function isMissingPermission(err, scope) {
    return err instanceof MetaApiError && (err.meta.class === 'permission' || err.meta.code === 100) && `${err.message} ${err.meta.message ?? ''}`.includes(scope);
}
export async function syncConnection(connectionId) {
    const conn = await queryOne(`SELECT * FROM meta_connections WHERE id=?`, [connectionId]);
    if (!conn)
        throw errors.notFound('Meta connection');
    const token = decryptConnectionToken(conn);
    const warnings = [];
    try {
        const baseFields = 'account_id,name,currency,timezone_name,account_status,disable_reason,amount_spent,spend_cap';
        let accounts;
        try {
            accounts = await graphPaged({
                path: 'me/adaccounts',
                params: { fields: `${baseFields},business{id,name}` },
                accessToken: token,
                operation: 'meta.list_ad_accounts',
            });
        }
        catch (err) {
            // Without business_management Meta refuses the business{} field. Import the accounts anyway, without business names.
            if (!isMissingPermission(err, 'business_management'))
                throw err;
            warnings.push(MISSING_BUSINESS_MANAGEMENT);
            accounts = await graphPaged({
                path: 'me/adaccounts',
                params: { fields: baseFields },
                accessToken: token,
                operation: 'meta.list_ad_accounts',
            });
        }
        for (const a of accounts) {
            await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status, disable_reason,
                                       amount_spent_minor, spend_cap_minor, business_id, business_name, last_synced_at, last_sync_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP(3), NULL)
         ON DUPLICATE KEY UPDATE connection_id=VALUES(connection_id), name=VALUES(name), currency=VALUES(currency), timezone_name=VALUES(timezone_name),
           account_status=VALUES(account_status), disable_reason=VALUES(disable_reason), amount_spent_minor=VALUES(amount_spent_minor),
           spend_cap_minor=VALUES(spend_cap_minor), business_id=VALUES(business_id), business_name=VALUES(business_name),
           last_synced_at=CURRENT_TIMESTAMP(3), last_sync_error=NULL`, [
                conn.org_id, connectionId, a.account_id, a.name, a.currency, a.timezone_name ?? null, a.account_status ?? null, a.disable_reason ?? null,
                a.amount_spent != null ? Number(a.amount_spent) : null,
                a.spend_cap != null && a.spend_cap !== '0' ? Number(a.spend_cap) : null,
                a.business?.id ?? null, a.business?.name ?? null,
            ]);
        }
        let pages = [];
        try {
            pages = await graphPaged({
                path: 'me/accounts',
                params: { fields: 'id,name,tasks,instagram_business_account{id,username}' },
                accessToken: token,
                operation: 'meta.list_pages',
            });
        }
        catch (err) {
            if (!(err instanceof MetaApiError) || (err.meta.class !== 'permission' && err.meta.code !== 100))
                throw err;
            warnings.push(`Pages were not imported: ${err.message}`);
        }
        for (const p of pages) {
            await execute(`INSERT INTO meta_pages (org_id, connection_id, page_id, name, ig_account_id, ig_username, tasks, last_synced_at)
         VALUES (?,?,?,?,?,?,?, CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE connection_id=VALUES(connection_id), name=VALUES(name), ig_account_id=VALUES(ig_account_id),
           ig_username=VALUES(ig_username), tasks=VALUES(tasks), last_synced_at=CURRENT_TIMESTAMP(3)`, [conn.org_id, connectionId, p.id, p.name, p.instagram_business_account?.id ?? null, p.instagram_business_account?.username ?? null, (p.tasks ?? []).join(',')]);
        }
        const warning = warnings.length ? warnings.join(' ').slice(0, 1000) : null;
        await execute(`UPDATE meta_connections SET status='active', last_checked_at=CURRENT_TIMESTAMP(3), last_error=? WHERE id=?`, [warning, connectionId]);
        return { accounts: accounts.length, pages: pages.length, warnings };
    }
    catch (err) {
        if (err instanceof MetaApiError) {
            const status = err.meta.class === 'auth' ? 'expired' : 'error';
            await execute(`UPDATE meta_connections SET status=?, last_checked_at=CURRENT_TIMESTAMP(3), last_error=? WHERE id=?`, [status, err.message.slice(0, 1000), connectionId]);
        }
        throw err;
    }
}
export async function listConnections(orgId) {
    const rows = await query(`SELECT id, meta_user_id, meta_user_name, token_expires_at, scopes, status, last_checked_at, last_error, created_at
       FROM meta_connections WHERE org_id=? ORDER BY created_at`, [orgId]);
    // Granted scopes come from debug_token at connect time; empty means we could not read them, so claim nothing.
    return rows.map((r) => {
        const granted = String(r.scopes ?? '').split(',').filter(Boolean);
        return { ...r, missing_scopes: granted.length ? REQUESTED_SCOPES.filter((x) => !granted.includes(x)) : [] };
    });
}
//# sourceMappingURL=connections.js.map
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execute, query, queryOne } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { listConnections, MISSING_BUSINESS_MANAGEMENT, syncConnection } from '../src/meta/connections.js';
import { setFetchForTests } from '../src/meta/graph.js';
import { closePool, freshDb } from './helpers.js';

let orgId: number;
let connectionId: number;

beforeAll(async () => {
  await freshDb({ META_API_VERSION: 'v24.0' });
  const org = await execute(`INSERT INTO orgs (name) VALUES ('Test org')`);
  orgId = org.insertId;
  const u = await execute(`INSERT INTO users (org_id, email, name, role, password_hash) VALUES (?,?,?,?,?)`, [orgId, 'a@example.test', 'A', 'super_admin', await hashPassword('x'.repeat(12))]);
  const c = await execute(
    `INSERT INTO meta_connections (org_id, connected_by, meta_user_id, token_ciphertext, token_key_id, scopes) VALUES (?,?,?,?,?,?)`,
    [orgId, u.insertId, 'mu1', encryptSecret('tok', env().TOKEN_ENCRYPTION_KEY), 'k1', 'ads_management,ads_read,pages_show_list,pages_read_engagement'],
  );
  connectionId = c.insertId;
});
afterEach(() => setFetchForTests((...a) => fetch(...a)));
afterAll(closePool);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Meta sync without business_management', () => {
  it('imports ad accounts without business names and records a warning instead of failing', async () => {
    const calls: string[] = [];
    setFetchForTests(async (url: any) => {
      const u = new URL(String(url));
      calls.push(`${u.pathname}?fields=${u.searchParams.get('fields')}`);
      if (u.pathname.endsWith('/me/adaccounts') && u.searchParams.get('fields')!.includes('business')) {
        return json(400, { error: { message: '(#100) Requires business_management permission to access the field.', type: 'OAuthException', code: 100 } });
      }
      if (u.pathname.endsWith('/me/adaccounts')) return json(200, { data: [{ account_id: '111', name: 'Shop', currency: 'BDT', account_status: 1 }] });
      return json(200, { data: [{ id: 'p1', name: 'Page One', tasks: ['ADVERTISE'] }] });
    });
    const out = await syncConnection(connectionId);
    expect(out).toMatchObject({ accounts: 1, pages: 1, warnings: [MISSING_BUSINESS_MANAGEMENT] });
    expect(calls.filter((c) => c.includes('adaccounts'))).toHaveLength(2);
    const row = await queryOne(`SELECT status, last_error FROM meta_connections WHERE id=?`, [connectionId]);
    expect(row).toMatchObject({ status: 'active', last_error: MISSING_BUSINESS_MANAGEMENT });
    const accts = await query(`SELECT account_id, business_id FROM meta_ad_accounts WHERE connection_id=?`, [connectionId]);
    expect(accts).toEqual([{ account_id: '111', business_id: null }]);
    const [c] = await listConnections(orgId);
    expect(c.missing_scopes).toEqual(['business_management', 'pages_read_user_content', 'pages_manage_engagement']);
  });

  it('still fails on other errors', async () => {
    setFetchForTests(async () => json(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } }));
    await expect(syncConnection(connectionId)).rejects.toThrow();
    const row = await queryOne(`SELECT status FROM meta_connections WHERE id=?`, [connectionId]);
    expect(row!.status).toBe('expired');
  });
});

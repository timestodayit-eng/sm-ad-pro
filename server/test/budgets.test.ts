import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { execute, query } from '../src/db/pool.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { setFetchForTests } from '../src/meta/graph.js';
import { closePool, freshDb, signIn, TEST_ORIGIN } from './helpers.js';

const META_ENV = { META_APP_ID: '123', META_APP_SECRET: 'app-secret-for-tests', META_API_VERSION: 'v24.0', META_REDIRECT_URI: `${TEST_ORIGIN}/api/meta/callback` };

describe('stepped ad set budgets down the account order', () => {
  let app: ReturnType<typeof createApp>;
  const pw = 'super admin password 1';
  const acc: Record<string, number> = {};
  /** Ad set budgets as Meta holds them, in minor units. */
  const meta: Record<string, { daily_budget?: string; lifetime_budget?: string; campaign?: any }> = {};
  const writes: string[] = [];
  let failPost: Record<string, any> = {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeAll(async () => {
    await freshDb(META_ENV);
    app = createApp();
    const org = (await execute(`INSERT INTO orgs (name) VALUES ('O')`)).insertId;
    const u = await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [org, 'boss@example.test', 'Boss', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'analyst')`, [org, 'analyst@example.test', 'An', await hashPassword(pw)]);
    const c = (await execute(`INSERT INTO meta_connections (org_id, connected_by, meta_user_id, token_ciphertext, token_key_id, status) VALUES (?,?,?,?,?, 'active')`,
      [org, u.insertId, 'mu1', encryptSecret('tok', env().TOKEN_ENCRYPTION_KEY), 'k1'])).insertId;
    // Order on purpose differs from the alphabet: DE 168 first.
    const accounts: [string, string, number][] = [['DE 168', '168', 1], ['DE 154', '154', 2], ['DE 179', '179', 3], ['DE 157', '157', 4], ['DE 162', '162', 5]];
    for (const [name, id, order] of accounts)
      acc[name] = (await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status, is_managed, display_order, live_full_synced_at) VALUES (?,?,?,?, 'USD', 'Asia/Dhaka', 1, 1, ?, NOW(3))`, [org, c, id, name, order])).insertId;
    const camp = (a: number, id: string, cbo = false) => execute(`INSERT INTO meta_campaigns (ad_account_row_id, campaign_id, name, status, effective_status, objective, daily_budget_minor, synced_at) VALUES (?,?,?, 'ACTIVE','ACTIVE','OUTCOME_ENGAGEMENT', ?, NOW(3))`, [a, id, `Camp ${id}`, cbo ? 5000 : null]);
    const set = (a: number, id: string, campaign: string, budget: number | null, st = 'ACTIVE') => {
      meta[id] = { daily_budget: budget == null ? undefined : String(budget) };
      return execute(`INSERT INTO meta_adsets (ad_account_row_id, adset_id, campaign_id, name, status, effective_status, daily_budget_minor, synced_at) VALUES (?,?,?,?,?,?,?,NOW(3))`, [a, id, campaign, `Set ${id}`, st, st, budget]);
    };
    await camp(acc['DE 168'], '9168'); await set(acc['DE 168'], '1680', '9168', 1500);
    await camp(acc['DE 154'], '9154'); await set(acc['DE 154'], '1540', '9154', 1500); await set(acc['DE 154'], '1541', '9154', 900, 'PAUSED');
    await camp(acc['DE 179'], '9179'); await set(acc['DE 179'], '1790', '9179', 1500); await set(acc['DE 179'], '1791', '9179', 1500);
    await camp(acc['DE 157'], '9157', true); await set(acc['DE 157'], '1570', '9157', null);
    await camp(acc['DE 162'], '9162'); await set(acc['DE 162'], '1620', '9162', 1500);

    setFetchForTests(async (url: any, init: any) => {
      const u = new URL(String(url));
      const id = u.pathname.replace('/v24.0/', '');
      if (!meta[id]) return json({ error: { message: 'Unsupported get request', code: 100 } }, 400);
      if (init?.method === 'POST') {
        const body = new URLSearchParams(String(init.body));
        writes.push(`${id}=${body.get('daily_budget')}`);
        if (failPost[id]) return json(failPost[id], 400);
        meta[id].daily_budget = body.get('daily_budget')!;
        return json({ success: true });
      }
      return json({ id, ...meta[id] });
    });
  });
  afterAll(async () => {
    setFetchForTests((...a) => fetch(...a));
    await closePool();
  });

  it('plans 20, 22, 24 … in the account order and says why an account is left out', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const plan = (await agent.post('/api/budgets/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ start: 20, step: 2 })).body;
    expect(plan.rows.map((r: any) => [r.name, r.status, r.adsetId, r.current, r.next])).toEqual([
      ['DE 168', 'ready', '1680', 15, 20],
      ['DE 154', 'ready', '1540', 15, 22], // the only running ad set is picked
      ['DE 179', 'choose', null, null, null], // two running ad sets: the user picks
      ['DE 157', 'cbo', null, null, null], // campaign budget: no ad set budget to change
      ['DE 162', 'ready', '1620', 15, 24],
    ]);
    expect(plan.summary).toMatchObject({ ready: 3, needChoice: 1, cannot: 1, totals: [{ currency: 'USD', current: 45, next: 66 }] });

    const chosen = (await agent.post('/api/budgets/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ start: 20, step: 2, choices: { [acc['DE 179']]: '1791' }, skip: [acc['DE 168']] })).body;
    expect(chosen.rows.filter((r: any) => r.status === 'ready').map((r: any) => [r.name, r.adsetId, r.next])).toEqual([['DE 154', '1540', 20], ['DE 179', '1791', 22], ['DE 162', '1620', 24]]);
    expect(chosen.rows[0].status).toBe('skipped');
    const add = (await agent.post('/api/budgets/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ mode: 'add', step: 2.5 })).body;
    expect(add.rows[0].next).toBe(17.5);
    expect(writes).toEqual([]); // planning never writes to Meta
  });

  it('needs an explicit confirm and the campaigns.manage permission', async () => {
    const analyst = await signIn(app, 'analyst@example.test', pw);
    const items = [{ accountRowId: acc['DE 168'], adsetId: '1680', dailyBudget: 20 }];
    expect((await analyst.agent.post('/api/budgets/apply').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', analyst.csrf).send({ confirm: true, items })).status).toBe(403);
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    expect((await agent.post('/api/budgets/apply').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ items })).status).toBe(400);
    // An ad set from another account is refused before anything is written.
    const wrong = await agent.post('/api/budgets/apply').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ confirm: true, items: [...items, { accountRowId: acc['DE 168'], adsetId: '1620', dailyBudget: 22 }] });
    expect(wrong.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('writes in order, reads each budget back from Meta, and reports failures as they are', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    meta['1790'].campaign = { daily_budget: '9000' }; // switched to CBO on Meta since the last sync
    failPost = { '1620': { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'The budget is below the minimum for this ad set.' } } };
    const items = [
      { accountRowId: acc['DE 168'], adsetId: '1680', dailyBudget: 20 },
      { accountRowId: acc['DE 154'], adsetId: '1540', dailyBudget: 22 },
      { accountRowId: acc['DE 179'], adsetId: '1790', dailyBudget: 24 },
      { accountRowId: acc['DE 162'], adsetId: '1620', dailyBudget: 26 },
    ];
    const r = (await agent.post('/api/budgets/apply').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ confirm: true, items })).body;
    expect(writes).toEqual(['1680=2000', '1540=2200', '1620=2600']);
    expect(r.results.map((x: any) => [x.accountName, x.status, x.before, x.confirmed ?? null])).toEqual([
      ['DE 168', 'done', 15, 20],
      ['DE 154', 'done', 15, 22],
      ['DE 179', 'failed', 15, null],
      ['DE 162', 'failed', 15, null],
    ]);
    expect(r.results[3].error).toBe('The budget is below the minimum for this ad set.');
    expect(r.summary).toEqual({ done: 2, failed: 2, mismatch: 0, notAttempted: 0 });
    const local = await query<any>(`SELECT adset_id, daily_budget_minor FROM meta_adsets WHERE adset_id IN ('1680','1620') ORDER BY adset_id`);
    expect(local.map((x) => Number(x.daily_budget_minor))).toEqual([1500, 2000]); // 1620 unchanged, 1680 updated
    const hist = (await agent.get('/api/budgets/history')).body.batches[0];
    expect(hist.items.map((i: any) => [i.position, i.accountName, i.status, i.requested])).toEqual([[1, 'DE 168', 'done', 20], [2, 'DE 154', 'done', 22], [3, 'DE 179', 'failed', 24], [4, 'DE 162', 'failed', 26]]);
  });

  it('stops the rest when the Meta login is no longer valid', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    writes.length = 0;
    failPost = { '1680': { error: { message: 'Error validating access token', code: 190 } } };
    const r = (await agent.post('/api/budgets/apply').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ confirm: true, items: [
      { accountRowId: acc['DE 168'], adsetId: '1680', dailyBudget: 30 },
      { accountRowId: acc['DE 154'], adsetId: '1540', dailyBudget: 32 },
    ] })).body;
    expect(writes).toEqual(['1680=3000']);
    expect(r.results.map((x: any) => x.status)).toEqual(['failed', 'not_attempted']);
    expect(r.results[1].error).toMatch(/reconnecting/);
  });
});

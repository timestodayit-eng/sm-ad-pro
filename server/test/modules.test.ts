import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { execute, query, queryOne } from '../src/db/pool.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { setFetchForTests } from '../src/meta/graph.js';
import { setAiFetchForTests } from '../src/ai/openai.js';
import { scanOrg } from '../src/services/monitoring.js';
import { closePool, freshDb, signIn, TEST_ORIGIN } from './helpers.js';

const ENV = {
  META_APP_ID: '123', META_APP_SECRET: 'app-secret-for-tests', META_API_VERSION: 'v24.0', META_REDIRECT_URI: `${TEST_ORIGIN}/api/meta/callback`,
  OPENAI_API_KEY: 'sk-test-not-real', OPENAI_MODEL: 'gpt-test', OPENAI_BASE_URL: 'https://openai.example.test/v1',
};

describe('Audiences, Placements, Reports, Finance, Monitoring and Comments', () => {
  let app: ReturnType<typeof createApp>;
  const pw = 'super admin password 1';
  const acc: Record<string, number> = {};
  let org = 0;
  let conn = 0;
  const meta: { method: string; path: string; params: Record<string, string> }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const post = (agent: any, csrf: string, path: string, body: unknown) => agent.post(`/api${path}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body);
  const put = (agent: any, csrf: string, path: string, body: unknown) => agent.put(`/api${path}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body);

  beforeAll(async () => {
    await freshDb(ENV);
    app = createApp();
    org = (await execute(`INSERT INTO orgs (name) VALUES ('O')`)).insertId;
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [org, 'boss@example.test', 'Boss', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'viewer')`, [org, 'viewer@example.test', 'V', await hashPassword(pw)]);
    conn = (await execute(`INSERT INTO meta_connections (org_id, connected_by, meta_user_id, meta_user_name, token_ciphertext, token_key_id, status, scopes, token_expires_at) VALUES (?,1,'mu1','Jamil',?,'k1','active',?, NOW() + INTERVAL 2 DAY)`,
      [org, encryptSecret('tok', env().TOKEN_ENCRYPTION_KEY), 'ads_management,pages_show_list,pages_read_user_content,pages_manage_engagement'])).insertId;
    await execute(`INSERT INTO meta_pages (org_id, connection_id, page_id, name, tasks) VALUES (?,?,?,?,?)`, [org, conn, '501', 'Page A', 'ADVERTISE,MODERATE']);
    for (const [name, id, order, cur] of [['DE 168', '168', 1, 'USD'], ['DE 154', '154', 2, 'USD'], ['BD 1', '301', 3, 'BDT']] as const) {
      const a = (await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status, is_managed, display_order, live_full_synced_at, live_synced_at) VALUES (?,?,?,?,?, 'UTC', 1, 1, ?, NOW(3), ?)`, [org, conn, id, name, cur, order, order === 3 ? new Date(Date.now() - 5 * 3600_000) : new Date()])).insertId;
      acc[name] = a;
      await execute(`INSERT INTO meta_campaigns (ad_account_row_id, campaign_id, name, status, effective_status, objective, synced_at) VALUES (?,?,?, 'ACTIVE','ACTIVE','OUTCOME_ENGAGEMENT', NOW(3))`, [a, `9${id}`, `Calls ${name}`]);
      await execute(`INSERT INTO meta_ads (ad_account_row_id, ad_id, adset_id, campaign_id, name, status, effective_status, synced_at) VALUES (?,?,?,?,?, 'ACTIVE','ACTIVE', NOW(3))`, [a, `7${id}`, `8${id}`, `9${id}`, `Ad ${name}`]);
      for (let d = 1; d <= 8; d++) {
        await execute(`INSERT INTO meta_insights_daily (ad_account_row_id, level, object_id, date, spend, impressions, clicks, link_clicks, leads, calls, messages, result_type, results, synced_at) VALUES (?, 'campaign', ?, CURRENT_DATE - INTERVAL ? DAY, ?, 1000, 40, 30, 0, ?, 0, 'click_to_call_native_call_placed', ?, NOW(3))`, [a, `9${id}`, d, order === 1 ? 20 : 10, 4, 4]);
        await execute(`INSERT INTO meta_insights_daily (ad_account_row_id, level, object_id, date, spend, impressions, clicks, link_clicks, leads, calls, messages, result_type, results, synced_at) VALUES (?, 'ad', ?, CURRENT_DATE - INTERVAL ? DAY, ?, 1000, 40, 30, 0, ?, 0, 'click_to_call_native_call_placed', ?, NOW(3))`, [a, `7${id}`, d, order === 1 ? 20 : 10, 4, 4]);
      }
    }
    setFetchForTests(async (url: any, init: any) => {
      const u = new URL(String(url));
      const path = u.pathname.replace('/v24.0/', '');
      const method = init?.method ?? 'GET';
      const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(String(init.body)));
      meta.push({ method, path, params });
      if (path.endsWith('/delivery_estimate')) return json({ data: [{ estimate_mau_lower_bound: 120_000, estimate_mau_upper_bound: 140_000, estimate_ready: true }] });
      if (path === '501' && params.fields?.includes('access_token')) return json({ access_token: 'page-token', name: 'Page A' });
      if (path === '501/posts') return json({ data: [{ id: '501_1', message: 'Big sale', created_time: '2026-11-01T00:00:00+0000', permalink_url: 'https://fb.example/p1', comments: { data: [{ id: '501_1_9', message: 'Price?', from: { name: 'Rita', id: '77' }, created_time: '2026-11-02T00:00:00+0000', is_hidden: false, comment_count: 0, like_count: 1, can_comment: true, can_hide: true }] } }] });
      if (method === 'POST' && path === '501_1_9/comments') return json({ id: '501_1_9_reply' });
      if (method === 'POST' && path === '501_1_9') return json({ success: true });
      return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
    });
    setAiFetchForTests(async () => json({ choices: [{ message: { role: 'assistant', content: 'Thanks Rita! Please send us a message and we will share the price.' }, finish_reason: 'stop' }] }));
  });
  afterAll(async () => {
    setFetchForTests((...a) => fetch(...a));
    setAiFetchForTests((...a) => fetch(...a));
    await closePool();
  });

  it('saves audiences with the launch rules, lists them, and asks Meta for the reach estimate', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const spec = { countries: ['BD'], ageMin: 25, ageMax: 45, genders: 'male', advanced: { interests: [{ key: '6003139266461', name: 'Movies' }], locations: { include: [{ key: '2420379', name: 'Dhaka', type: 'city', radius: 20 }], exclude: [], types: ['home', 'recent'] } } };
    // job ads: ages and genders fixed by Meta
    const bad = await post(agent, csrf, '/audiences', { name: 'Jobs', specialCategory: 'EMPLOYMENT', spec });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/18–65/);
    const ok = await post(agent, csrf, '/audiences', { name: 'Dhaka men 25-45', description: 'Movie fans', spec });
    expect(ok.status).toBe(201);
    expect((await post(agent, csrf, '/audiences', { name: 'Dhaka men 25-45', spec })).status).toBe(409);
    const list = (await agent.get('/api/audiences')).body.items;
    expect(list.map((a: any) => [a.name, a.spec.ageMin, a.spec.advanced.interests[0].name])).toEqual([['Dhaka men 25-45', 25, 'Movies']]);
    const est = (await post(agent, csrf, '/audiences/estimate', { spec, accountRowIds: [acc['DE 168']] })).body.items;
    expect(est).toEqual([{ accountRowId: acc['DE 168'], accountName: 'DE 168', low: 120_000, high: 140_000, ready: true, error: null }]);
    const sent = JSON.parse(meta.find((m) => m.path === 'act_168/delivery_estimate')!.params.targeting_spec);
    expect(sent).toMatchObject({ geo_locations: { countries: ['BD'], cities: [{ key: '2420379', radius: 20, distance_unit: 'mile' }] }, age_min: 25, age_max: 45, genders: [1], flexible_spec: [{ interests: [{ id: '6003139266461', name: 'Movies' }] }] });
    // viewers can read, not write
    const v = await signIn(app, 'viewer@example.test', pw);
    expect((await post(v.agent, v.csrf, '/audiences', { name: 'x', spec })).status).toBe(403);
    expect((await agent.delete(`/api/audiences/${ok.body.id}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(200);
  });

  it('saves placement sets of known placements only', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    expect((await post(agent, csrf, '/placement-sets', { name: 'Reels only', placements: ['fb_reels', 'ig_reels'] })).status).toBe(201);
    expect((await post(agent, csrf, '/placement-sets', { name: 'Bad', placements: ['tiktok'] })).status).toBe(400);
    const r = (await agent.get('/api/placement-sets')).body;
    expect(r.items.map((s: any) => [s.name, s.placements])).toEqual([['Reels only', ['fb_reels', 'ig_reels']]]);
    expect(r.placements.length).toBe(10);
  });

  it('builds reports by account, campaign, ad and day from synced data, exports CSV and saves templates', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const byAccount = (await post(agent, csrf, '/reports/run', { period: '7d', level: 'account', metrics: ['spend', 'calls', 'costPerCall', 'ctr'] })).body;
    expect(byAccount.rows.map((r: any) => [r.name, r.spend, r.calls, r.costPerCall, r.ctr])).toEqual([['DE 168', 140, 28, 5, 4], ['DE 154', 70, 28, 2.5, 4], ['BD 1', 70, 28, 2.5, 4]]);
    expect(byAccount.totals.map((t: any) => [t.currency, t.spend])).toEqual([['USD', 210], ['BDT', 70]]);
    const byCampaign = (await post(agent, csrf, '/reports/run', { period: '7d', level: 'campaign', metrics: ['spend'], accountIds: [acc['DE 168']] })).body;
    expect(byCampaign.rows.map((r: any) => [r.name, r.account, r.status, r.spend])).toEqual([['Calls DE 168', 'DE 168', 'ACTIVE', 140]]);
    const byAd = (await post(agent, csrf, '/reports/run', { period: '7d', level: 'ad', metrics: ['spend'], accountIds: [acc['DE 154']] })).body;
    expect(byAd.rows.map((r: any) => [r.name, r.parent, r.spend])).toEqual([['Ad DE 154', 'Calls DE 154', 70]]);
    const byDay = (await post(agent, csrf, '/reports/run', { period: '7d', level: 'day', metrics: ['spend'], sort: { key: 'name', dir: 'desc' } })).body;
    expect(byDay.rows).toHaveLength(7);
    expect(byDay.rows[0].spend).toBe(40);
    const csv = await post(agent, csrf, '/reports/export.csv', { period: '7d', level: 'account', metrics: ['spend', 'calls'] });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('﻿Name,Currency,Spend,Calls\nDE 168,USD,140,28\n');
    expect((await post(agent, csrf, '/reports/templates', { name: 'Weekly calls', config: { period: '7d', level: 'account', metrics: ['spend', 'calls'] } })).status).toBe(201);
    expect((await agent.get('/api/reports/options')).body.templates.map((t: any) => t.name)).toEqual(['Weekly calls']);
  });

  it('finance: spend per account and currency, top-ups logged by hand, BDT only at a dated rate', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    let f = (await agent.get('/api/finance?period=7d')).body;
    expect(f.totals.map((t: any) => [t.currency, t.spend, t.spendBdt])).toEqual([['USD', 210, null], ['BDT', 70, 70]]);
    expect(f.bdt).toBeNull();
    expect(f.missingRates).toEqual(['USD']);
    expect((await put(agent, csrf, '/finance/rates', { currency: 'USD', rateToBdt: 120.5, asOf: '2026-11-07', note: 'Bank rate' })).status).toBe(200);
    expect((await post(agent, csrf, '/finance/entries', { accountRowId: acc['DE 168'], kind: 'topup', amount: 500, onDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10), note: 'Card' })).status).toBe(201);
    f = (await agent.get('/api/finance?period=7d')).body;
    expect(f.totals.find((t: any) => t.currency === 'USD')).toMatchObject({ spend: 210, topups: 500, spendBdt: 25305, rate: { rateToBdt: 120.5, asOf: '2026-11-07' } });
    expect(f.bdt).toEqual({ spend: 25375, ratesAsOf: ['2026-11-07'] });
    expect(f.accounts[0]).toMatchObject({ name: 'DE 168', spend: 140, topups: 500, spendBdt: 16870 });
    expect(f.entries[0]).toMatchObject({ account: 'DE 168', kind: 'topup', amount: 500, note: 'Card', by: 'Boss' });
    expect((await agent.get('/api/finance/export.csv?period=7d')).text).toContain('DE 168,act_168,USD');
    const v = await signIn(app, 'viewer@example.test', pw);
    expect((await put(v.agent, v.csrf, '/finance/rates', { currency: 'USD', rateToBdt: 1, asOf: '2026-11-07' })).status).toBe(403);
  });

  it('monitoring: the scan turns findings, expiring logins and stale syncs into one notification a day', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const m = (await agent.get('/api/monitoring')).body;
    expect(m.settings).toMatchObject({ enabled: true, minSeverity: 'warning' });
    expect(m.findings.map((f: any) => f.kind)).toEqual(expect.arrayContaining(['token_expiring', 'stale_sync']));
    expect(m.connections[0]).toMatchObject({ name: 'Jamil', status: 'active' });
    const r1 = await scanOrg(org);
    expect(r1.alerts).toBeGreaterThanOrEqual(2);
    const r2 = await scanOrg(org);
    expect(r2.alerts).toBe(0); // same day: no duplicate notifications
    const notes = await query<any>(`SELECT title, severity, link FROM notifications WHERE org_id=? AND category='monitoring' ORDER BY id`, [org]);
    expect(notes.some((n) => n.title.startsWith('Meta login for Jamil expires in 2 days'))).toBe(true);
    expect(notes.some((n) => n.title === 'Sync stopped for BD 1' && n.link === '/health')).toBe(true);
    expect((await agent.get('/api/monitoring')).body.runs).toHaveLength(2);
    // switch alerts off: a scan still records a run but writes nothing
    expect((await put(agent, csrf, '/monitoring/settings', { enabled: false, minSeverity: 'critical', kinds: ['stale_sync'], staleSyncMinutes: 60, tokenDaysWarning: 3 })).status).toBe(200);
    await execute(`DELETE FROM notifications WHERE org_id=? AND category='monitoring'`, [org]);
    expect((await post(agent, csrf, '/monitoring/scan', {})).body.alerts).toBe(0);
    expect((await queryOne<any>(`SELECT COUNT(*) AS n FROM notifications WHERE org_id=? AND category='monitoring'`, [org])).n).toBe(0);
  });

  it('comments: reads a Page’s comments live, replies and hides through the Page token, drafts with the assistant', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const pages = (await agent.get('/api/comments/pages')).body;
    expect(pages.items).toEqual([{ id: '501', name: 'Page A', canModerate: true, missingScopes: [], connectionStatus: 'active' }]);
    const c = (await agent.get('/api/comments/pages/501')).body;
    expect(c.posts[0].comments[0]).toMatchObject({ id: '501_1_9', message: 'Price?', from: 'Rita', canReply: true, handled: [] });
    expect(meta.find((x) => x.path === '501/posts')!.params.access_token).toBe('page-token');
    const s = (await post(agent, csrf, '/comments/suggest', { comment: 'Price?', post: 'Big sale', pageName: 'Page A' })).body;
    expect(s.text).toMatch(/Rita/);
    expect((await post(agent, csrf, '/comments/reply', { pageId: '501', commentId: '501_1_9', message: s.text })).body).toEqual({ id: '501_1_9_reply' });
    expect((await post(agent, csrf, '/comments/hide', { pageId: '501', commentId: '501_1_9', hidden: true })).body).toEqual({ hidden: true });
    expect(meta.filter((x) => x.method === 'POST').map((x) => [x.path, x.params.message ?? x.params.is_hidden])).toEqual([['501_1_9/comments', s.text], ['501_1_9', 'true']]);
    const again = (await agent.get('/api/comments/pages/501')).body;
    expect(again.posts[0].comments[0].handled.map((h: any) => h.action)).toEqual(['hide', 'reply']);
    const v = await signIn(app, 'viewer@example.test', pw);
    expect((await post(v.agent, v.csrf, '/comments/reply', { pageId: '501', commentId: '501_1_9', message: 'x' })).status).toBe(403);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { execute, query, queryOne } from '../src/db/pool.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { setFetchForTests } from '../src/meta/graph.js';
import { accountToday, addDays, contactCounts, extractPreviewSrc, minorToMajor, primaryResult, syncAccountLive } from '../src/meta/live.js';
import { periodRange } from '../src/routes/live.js';
import { effectiveLimits, evaluateCostAlerts, findBreaches } from '../src/services/costAlerts.js';
import { closePool, freshDb, signIn, TEST_ORIGIN } from './helpers.js';

const META_ENV = {
  META_APP_ID: '123',
  META_APP_SECRET: 'app-secret-for-tests',
  META_API_VERSION: 'v24.0',
  META_REDIRECT_URI: `${TEST_ORIGIN}/api/meta/callback`,
};

describe('live data helpers', () => {
  it('picks the result by objective and treats "no actions" as zero, not unknown', () => {
    const actions = [
      { action_type: 'link_click', value: '40' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '12' },
    ];
    expect(primaryResult('OUTCOME_ENGAGEMENT', actions)).toEqual({ type: 'onsite_conversion.messaging_conversation_started_7d', count: 12 });
    expect(primaryResult('OUTCOME_TRAFFIC', actions)).toEqual({ type: 'link_click', count: 40 });
    expect(primaryResult('OUTCOME_LEADS', [])).toEqual({ type: 'lead', count: 0 });
    expect(primaryResult('OUTCOME_AWARENESS', actions)).toBeNull();
  });

  it('counts leads, calls and messages without double counting', () => {
    expect(contactCounts([
      { action_type: 'lead', value: '7' },
      { action_type: 'onsite_conversion.lead_grouped', value: '5' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
      { action_type: 'click_to_call_native_call_placed', value: '3' },
      { action_type: 'click_to_call_call_confirm', value: '9' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '11' },
    ])).toEqual({ leads: 7, calls: 3, messages: 11 });
    expect(contactCounts([{ action_type: 'onsite_conversion.lead_grouped', value: '5' }, { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' }, { action_type: 'click_to_call_call_confirm', value: '4' }]))
      .toEqual({ leads: 7, calls: 4, messages: 0 });
    expect(contactCounts(null)).toEqual({ leads: 0, calls: 0, messages: 0 });
  });

  it('account limits override defaults; blank inherits, 0 switches off', () => {
    const def = { daily_spend_limit: '1000', max_cost_per_lead: '100', max_cost_per_message: null, min_spend: '200' };
    const acc = { daily_spend_limit: null, max_cost_per_lead: '0', max_cost_per_message: '30' };
    expect(effectiveLimits(def, acc)).toMatchObject({ daily_spend_limit: 1000, max_cost_per_lead: null, max_cost_per_message: 30, min_spend: 200 });
    expect(effectiveLimits(null, null).daily_spend_limit).toBeNull();
  });

  it('judges each campaign on its own kind of result, and waits for the minimum spend', () => {
    const limits = effectiveLimits({ max_cost_per_lead: 100, max_cost_per_message: 20, min_spend: 300 }, null);
    const base = { accountName: 'Shop', currency: 'BDT', limits, account: { spend: 0 } };
    const camp = (o: any) => ({ id: 'c', name: 'C', spend: 0, leads: 0, calls: 0, messages: 0, results: 0, resultType: 'lead', ...o });
    expect(findBreaches({ ...base, campaigns: [camp({ spend: 600, leads: 5, results: 5 })] }).map((b) => b.key)).toEqual(['max_cost_per_lead:c']);
    expect(findBreaches({ ...base, campaigns: [camp({ spend: 400, leads: 5, results: 5 })] })).toEqual([]);
    expect(findBreaches({ ...base, campaigns: [camp({ spend: 250, leads: 0 })] })).toEqual([]); // under the minimum spend
    const none = findBreaches({ ...base, campaigns: [camp({ spend: 350, leads: 0 })] });
    expect(none[0].body).toContain('BDT 350 spent and no leads yet');
    // A messaging campaign never raises a cost-per-lead alert, even with zero leads.
    expect(findBreaches({ ...base, campaigns: [camp({ spend: 600, messages: 40, resultType: 'onsite_conversion.messaging_conversation_started_7d' })] })).toEqual([]);
  });

  it('converts budgets with the currency offset', () => {
    expect(minorToMajor('50000', 'BDT')).toBe(500);
    expect(minorToMajor('5000', 'JPY')).toBe(5000);
    expect(minorToMajor(null, 'USD')).toBeNull();
  });

  it('uses the account time zone for "today"', () => {
    const now = new Date('2026-11-07T20:30:00Z'); // 02:30 on the 8th in Dhaka
    expect(accountToday('Asia/Dhaka', now)).toBe('2026-11-08');
    expect(accountToday('America/Los_Angeles', now)).toBe('2026-11-07');
    expect(periodRange('7d', 'Asia/Dhaka', now)).toEqual({ since: '2026-11-02', until: '2026-11-08' });
    expect(periodRange('yesterday', 'Asia/Dhaka', now)).toEqual({ since: '2026-11-07', until: '2026-11-07' });
  });

  it('only accepts preview iframes from facebook.com', () => {
    expect(extractPreviewSrc('<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQ&amp;t=AQ" width="540"></iframe>')).toBe(
      'https://www.facebook.com/ads/api/preview_iframe.php?d=AQ&t=AQ',
    );
    expect(extractPreviewSrc('<iframe src="https://evil.example/x"></iframe>')).toBeNull();
    expect(extractPreviewSrc('<iframe src="javascript:alert(1)"></iframe>')).toBeNull();
    expect(extractPreviewSrc('nothing here')).toBeNull();
  });
});

describe('managed accounts and the live dashboard', () => {
  let app: ReturnType<typeof createApp>;
  let orgId = 0;
  let accA = 0;
  let accB = 0;
  const pw = 'super admin password 1';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const today = accountToday('Asia/Dhaka');
  const yesterday = addDays(today, -1);
  let graphCalls: string[] = [];

  beforeAll(async () => {
    await freshDb(META_ENV);
    app = createApp();
    const org = await execute(`INSERT INTO orgs (name) VALUES ('O')`);
    orgId = org.insertId;
    const u = await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [orgId, 'boss@example.test', 'Boss', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'viewer')`, [orgId, 'viewer@example.test', 'Viewer', await hashPassword(pw)]);
    const c = await execute(
      `INSERT INTO meta_connections (org_id, connected_by, meta_user_id, token_ciphertext, token_key_id, status) VALUES (?,?,?,?,?, 'active')`,
      [orgId, u.insertId, 'mu1', encryptSecret('tok', env().TOKEN_ENCRYPTION_KEY), 'k1'],
    );
    accA = (await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status) VALUES (?,?,?,?,?,?,1)`, [orgId, c.insertId, '111', 'Shop A', 'BDT', 'Asia/Dhaka'])).insertId;
    accB = (await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status) VALUES (?,?,?,?,?,?,1)`, [orgId, c.insertId, '222', 'Shop B', 'BDT', 'Asia/Dhaka'])).insertId;

    setFetchForTests(async (url: any) => {
      const u = new URL(String(url));
      const path = u.pathname.replace('/v24.0/', '');
      graphCalls.push(path);
      if (path === 'act_111/campaigns') {
        expect(JSON.parse(u.searchParams.get('effective_status')!)).toContain('ACTIVE');
        return json({ data: [
          { id: 'c1', name: 'Messages BD', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', daily_budget: '100000' },
          { id: 'c2', name: 'Traffic', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' },
        ] });
      }
      if (path === 'act_111/adsets') return json({ data: [{ id: 's2', name: 'Traffic set', campaign_id: 'c2', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', daily_budget: '20000' }, { id: 's1', name: 'Broad', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE' }] });
      if (path === 'act_111/ads') return json({ data: [
        { id: '6001', name: 'Video 1', adset_id: 's1', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: 'cr1', thumbnail_url: 'https://scontent.xx.fbcdn.net/t.jpg', body: 'Inbox us' } },
        { id: '6002', name: 'Video 2', adset_id: 's1', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'DISAPPROVED', creative: { id: 'cr2' } },
      ] });
      if (path === 'act_111/insights') {
        const range = JSON.parse(u.searchParams.get('time_range')!);
        expect(range.until).toBe(today);
        const level = u.searchParams.get('level');
        const msg = (n: number) => [
          { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(n) },
          { action_type: 'lead', value: String(Math.floor(n / 5)) },
          { action_type: 'click_to_call_native_call_placed', value: String(Math.floor(n / 10)) },
        ];
        if (level === 'campaign') return json({ data: [
          { campaign_id: 'c1', objective: 'OUTCOME_ENGAGEMENT', spend: '500.50', impressions: '10000', clicks: '200', inline_link_clicks: '150', actions: msg(25), date_start: today },
          { campaign_id: 'c1', objective: 'OUTCOME_ENGAGEMENT', spend: '400', impressions: '8000', clicks: '100', inline_link_clicks: '90', actions: msg(20), date_start: yesterday },
          { campaign_id: 'c_old', objective: 'OUTCOME_ENGAGEMENT', spend: '99.50', impressions: '1000', clicks: '10', inline_link_clicks: '5', actions: msg(1), date_start: today },
        ] });
        return json({ data: [{ ad_id: '6001', objective: 'OUTCOME_ENGAGEMENT', spend: '500.50', impressions: '10000', clicks: '200', inline_link_clicks: '150', actions: msg(25), date_start: today }] });
      }
      if (path === '6001/previews') return json({ data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=1&amp;t=2" width="320"></iframe>' }] });
      return json({ error: { message: `unexpected ${path}`, code: 100 } }, 400);
    });
  });
  afterEach(() => { graphCalls = []; });
  afterAll(async () => {
    setFetchForTests((...a) => fetch(...a));
    await closePool();
  });

  it('shows nothing until accounts are chosen, and says so', async () => {
    const { agent } = await signIn(app, 'boss@example.test', pw);
    const r = await agent.get('/api/live/overview?period=today');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ managedCount: 0, availableCount: 2, accounts: [] });
  });

  it('only an account manager can choose accounts; choosing queues a first sync', async () => {
    const viewer = await signIn(app, 'viewer@example.test', pw);
    const denied = await viewer.agent.put('/api/accounts/managed').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', viewer.csrf).send({ accountIds: [accA], managed: true });
    expect(denied.status).toBe(403);
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const ok = await agent.put('/api/accounts/managed').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ accountIds: [accA], managed: true });
    expect(ok.body).toEqual({ updated: 1, syncQueued: 1 });
    const job = await queryOne(`SELECT type, payload FROM jobs WHERE type='meta.sync_live' ORDER BY id DESC LIMIT 1`);
    expect(job!.payload).toEqual({ accountIds: [accA] });
    const search = await agent.post('/api/accounts/search').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ managed: 'managed' });
    expect(search.body.items.map((a: any) => a.name)).toEqual(['Shop A']);
  });

  it('before the first sync the dashboard shows "not synced", never zeros', async () => {
    const { agent } = await signIn(app, 'boss@example.test', pw);
    const r = await agent.get('/api/live/overview?period=today');
    expect(r.body.managedCount).toBe(1);
    expect(r.body.accounts[0].metrics).toBeNull();
    expect(r.body.totalsByCurrency).toEqual([]);
  });

  it('syncs campaigns, ads and daily results from Meta and adds them up per period', async () => {
    const out = await syncAccountLive(accA);
    expect(out).toMatchObject({ campaigns: 2, adsets: 2, ads: 2, insightRows: 4, until: today, since: addDays(today, -29) });
    const { agent } = await signIn(app, 'boss@example.test', pw);

    const todayView = (await agent.get('/api/live/overview?period=today')).body;
    const a = todayView.accounts[0];
    expect(a.metrics.spend).toBe(600); // 500.50 + 99.50 from a campaign that is no longer listed: account spend stays complete
    expect(a.metrics.results).toEqual([{ type: 'onsite_conversion.messaging_conversation_started_7d', label: 'Messaging conversations', count: 26, costPer: 600 / 26 }]);
    expect(a.metrics.contacts).toEqual({
      leads: { count: 5, costPer: 120 }, // 25/5 + 1/5 = 5 + 0
      calls: { count: 2, costPer: 300 }, // 25/10 + 1/10 = 2 + 0
      messages: { count: 26, costPer: Math.round((600 / 26) * 10000) / 10000 },
    });
    expect(a.campaigns).toEqual({ active: 1, total: 2 });
    expect(a.ads).toEqual({ active: 1, total: 2, disapproved: 1 });
    expect(a.activeDailyBudget).toBe(1000);
    expect(a.dailySpend).toHaveLength(30);
    expect(a.dailySpend.at(-1)).toEqual({ date: today, spend: 600 });
    expect(todayView.totalsByCurrency[0]).toMatchObject({ currency: 'BDT', accounts: 1, spend: 600, impressions: 11000 });

    const week = (await agent.get('/api/live/overview?period=7d')).body.accounts[0];
    expect(week.metrics.spend).toBe(1000);
    expect(week.metrics.ctr).toBeCloseTo((310 / 19000) * 100, 3);

    const detail = (await agent.get(`/api/live/accounts/${accA}?period=today`)).body;
    expect(detail.unlistedSpend).toBe(99.5);
    expect(detail.campaigns[0]).toMatchObject({ campaignId: 'c1', budget: { kind: 'daily', amount: 1000, level: 'campaign' }, metrics: { spend: 500.5, contacts: { leads: { count: 5 }, calls: { count: 2 }, messages: { count: 25 } } } });
    expect(detail.totals.contacts.leads.count).toBe(5);
    expect(detail.campaigns[1]).toMatchObject({ campaignId: 'c2', budget: null, metrics: { spend: 0, ctr: null } });
    expect(detail.ads[0]).toMatchObject({ adId: '6001', thumbnailUrl: 'https://scontent.xx.fbcdn.net/t.jpg', campaignName: 'Messages BD', adsetName: 'Broad', metrics: { spend: 500.5 } });
  });

  it('raises cost alerts from the limits in Settings, once per day', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const put = (body: any) => agent.put('/api/alerts/cost-settings').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body);
    expect((await put({ scope: 'default', currency: 'BDT', limits: { daily_spend_limit: 550, max_cost_per_message: 15, max_cost_per_lead: 50 } })).status).toBe(200);
    const got = await evaluateCostAlerts(accA);
    expect(got.map((b) => b.key).sort()).toEqual(['max_cost_per_message:c1', 'max_cost_per_message:c_old', 'spend:account']);
    await evaluateCostAlerts(accA);
    const notes = await query<any>(`SELECT title, body, link FROM notifications WHERE category='cost' ORDER BY id`);
    expect(notes).toHaveLength(3);
    expect(notes.find((n) => n.title.includes('Messages BD'))).toMatchObject({ link: `/live/${accA}` });
    expect(notes.find((n) => n.title.includes('Messages BD')).body).toContain('BDT 20.02 (BDT 500.5 spent, 25 conversations)');
    const ov = (await agent.get('/api/live/overview?period=today')).body.accounts.find((a: any) => a.id === accA);
    expect(ov.costAlertsToday).toBe(3);

    // The account switches message alerts off for itself: only the spend alert would fire.
    expect((await put({ scope: 'account', accountId: accA, limits: { max_cost_per_message: 0 } })).status).toBe(200);
    const settings = (await agent.get('/api/alerts/cost-settings')).body;
    expect(settings.defaults).toEqual([{ currency: 'BDT', limits: expect.objectContaining({ daily_spend_limit: 550, max_cost_per_message: 15 }) }]);
    expect(settings.accounts.find((a: any) => a.id === accA).limits.max_cost_per_message).toBe(0);
    expect((await evaluateCostAlerts(accA)).map((b) => b.key)).toEqual(['spend:account']);
    const viewer = await signIn(app, 'viewer@example.test', pw);
    expect((await viewer.agent.put('/api/alerts/cost-settings').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', viewer.csrf).send({ scope: 'default', currency: 'BDT', limits: {} })).status).toBe(403);
  });

  it('a later sync drops campaigns that were archived on Meta and only refreshes recent days', async () => {
    const before = await query(`SELECT campaign_id FROM meta_campaigns WHERE ad_account_row_id=?`, [accA]);
    expect(before).toHaveLength(2);
    const out = await syncAccountLive(accA);
    expect(out.since).toBe(addDays(today, -2));
  });

  it('returns Meta\'s own preview URL for an ad', async () => {
    const { agent } = await signIn(app, 'boss@example.test', pw);
    const r = await agent.get('/api/live/ads/6001/preview?format=MOBILE_FEED_STANDARD');
    expect(r.status).toBe(200);
    expect(r.body.src).toBe('https://www.facebook.com/ads/api/preview_iframe.php?d=1&t=2');
    expect((await agent.get('/api/live/ads/999/preview')).status).toBe(404);
    expect((await agent.get('/api/live/ads/6001/preview?format=BOGUS')).status).toBe(400);
  });

  it('records a Meta error on the account instead of hiding it', async () => {
    await execute(`UPDATE meta_ad_accounts SET is_managed=1 WHERE id=?`, [accB]);
    await expect(syncAccountLive(accB)).rejects.toThrow();
    const row = await queryOne(`SELECT live_sync_error FROM meta_ad_accounts WHERE id=?`, [accB]);
    expect(row!.live_sync_error).toContain('unexpected act_222/campaigns');
    const { agent } = await signIn(app, 'boss@example.test', pw);
    const b = (await agent.get('/api/live/overview?period=today')).body.accounts.find((x: any) => x.id === accB);
    expect(b).toMatchObject({ metrics: null, syncError: expect.stringContaining('Meta code 100') });
  });

  it('allows Meta preview iframes in the content security policy', async () => {
    const { agent } = await signIn(app, 'boss@example.test', pw);
    const r = await agent.get('/api/auth/me');
    expect(r.headers['content-security-policy']).toContain('frame-src https://www.facebook.com');
  });
});

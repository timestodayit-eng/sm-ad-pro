import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { execute, query, queryOne } from '../src/db/pool.js';
import { registerCoreHandlers } from '../src/jobs/handlers.js';
import { tick } from '../src/jobs/scheduler.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { setFetchForTests } from '../src/meta/graph.js';
import { localIso, normalizePhone, parseCsv, placementTargeting, sheetToRows } from '../src/services/launch.js';
import { closePool, freshDb, signIn, TEST_ORIGIN } from './helpers.js';

const ENV = {
  META_APP_ID: '123', META_APP_SECRET: 'app-secret-for-tests', META_API_VERSION: 'v24.0', META_REDIRECT_URI: `${TEST_ORIGIN}/api/meta/callback`,
  R2_ACCOUNT_ID: 'test', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_ENDPOINT: 'http://127.0.0.1:9', R2_PREFIX: 'coastal-media/',
};

describe('pure helpers', () => {
  it('reads CSV with quotes, semicolons and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('accepts only full international phone numbers', () => {
    expect(normalizePhone('+1 (555) 010-2000')).toBe('+15550102000');
    expect(normalizePhone('555 010 2000')).toBeNull();
  });
  it('turns dates into the account’s own time zone and placements into Meta’s fields', () => {
    expect(localIso('2026-11-20', '00:00', 'Asia/Dhaka')).toBe('2026-11-20T00:00:00+06:00');
    expect(localIso('2026-07-04', '23:59', 'America/New_York')).toBe('2026-07-04T23:59:00-04:00');
    expect(placementTargeting(['fb_feed', 'ig_reels', 'fb_reels'])).toEqual({ publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed', 'facebook_reels'], instagram_positions: ['reels'] });
  });
  it('matches sheet rows to accounts by short name, ID or full name', () => {
    const accounts = [{ id: 1, account_id: '111', name: 'DadExpress DE 154' }, { id: 2, account_id: '222', name: 'DadExpress DE 1540' }, { id: 3, account_id: '333', name: 'Shop DE 168' }, { id: 4, account_id: '444', name: 'Other DE 168' }];
    const out = sheetToRows('account,daily_budget,video\nDE 154,$20,\nact_222,22.5,clip\nDE 168,24,\nNope,1,\nShop DE 168,,missing.mp4\n', accounts, [], [{ id: 9, original_name: 'clip.mp4' }]);
    expect(out.rows).toEqual([{ accountRowId: 1, dailyBudget: 20 }, { accountRowId: 2, dailyBudget: 22.5, mediaAssetId: 9 }, { accountRowId: 3 }]);
    expect(out.errors).toEqual([
      'Row 4: "DE 168" matches 2 accounts (Shop DE 168, Other DE 168). Use the full name or the account ID.',
      'Row 5: "Nope" is not one of your working accounts.',
      'Row 6: video "missing.mp4" is not in the media library.',
    ]);
  });
});

describe('Easy Ads launches, all PAUSED, in the account order', () => {
  let app: ReturnType<typeof createApp>;
  const pw = 'super admin password 1';
  const acc: Record<string, number> = {};
  let video = 0;
  const calls: { method: string; path: string; params: Record<string, string> }[] = [];
  const created: Record<string, { id: string; name: string; parent?: string }[]> = { campaigns: [], adsets: [], ads: [] };
  let processingChecks = 0;
  let timeoutOnAd = false;
  let rejectCreativeSwitches = false;
  const creativeSpecs: number[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let seq = 100;

  beforeAll(async () => {
    await freshDb(ENV);
    registerCoreHandlers();
    app = createApp();
    const org = (await execute(`INSERT INTO orgs (name) VALUES ('O')`)).insertId;
    const u = await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [org, 'boss@example.test', 'Boss', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'analyst')`, [org, 'analyst@example.test', 'An', await hashPassword(pw)]);
    const c = (await execute(`INSERT INTO meta_connections (org_id, connected_by, meta_user_id, token_ciphertext, token_key_id, status) VALUES (?,?,?,?,?, 'active')`,
      [org, u.insertId, 'mu1', encryptSecret('tok', env().TOKEN_ENCRYPTION_KEY), 'k1'])).insertId;
    for (const [name, id, order] of [['DadExpress DE 168', '168', 1], ['DadExpress DE 154', '154', 2], ['DadExpress DE 179', '179', 3]] as const)
      acc[name.slice(-6)] = (await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status, is_managed, display_order) VALUES (?,?,?,?, 'USD', 'Asia/Dhaka', 1, 1, ?)`, [org, c, id, name, order])).insertId;
    await execute(`INSERT INTO meta_pages (org_id, connection_id, page_id, name, tasks) VALUES (?,?,?,?,?), (?,?,?,?,?)`, [org, c, '501', 'Page A', 'ADVERTISE,ANALYZE', org, c, '502', 'Page B', 'ADVERTISE']);
    video = (await execute(`INSERT INTO media_assets (org_id, kind, original_name, content_type, size_bytes, object_key, status, part_size, part_count) VALUES (?, 'video', 'promo.mp4', 'video/mp4', 1000, 'coastal-media/promo.mp4', 'ready', 1000, 1)`, [org])).insertId;

    setFetchForTests(async (url: any, init: any) => {
      const u = new URL(String(url));
      const path = u.pathname.replace('/v24.0/', '');
      const method = init?.method ?? 'GET';
      const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(String(init.body)));
      calls.push({ method, path, params });
      const [first, edge] = path.split('/');
      if (method === 'POST') {
        if (edge === 'advideos') return json({ id: `v${++seq}` });
        if (edge === 'adcreatives') {
          const dof = params.degrees_of_freedom_spec ? JSON.parse(params.degrees_of_freedom_spec).creative_features_spec : null;
          creativeSpecs.push(dof ? Object.keys(dof).length : 0);
          if (rejectCreativeSwitches && dof && Object.keys(dof).length > 1) return json({ error: { message: '(#100) Invalid parameter: creative_features_spec', code: 100 } }, 400);
          return json({ id: `cr${++seq}` });
        }
        if (edge === 'ads' && timeoutOnAd) {
          timeoutOnAd = false;
          const id = `ad${++seq}`;
          created.ads.push({ id, name: params.name, parent: params.adset_id });
          throw new TypeError('socket hang up'); // Meta created it, but we never heard back
        }
        if (edge === 'campaigns' || edge === 'adsets' || edge === 'ads') {
          const id = `${edge.slice(0, 2)}${++seq}`;
          created[edge].push({ id, name: params.name, parent: params.campaign_id ?? params.adset_id ?? first });
          return json({ id });
        }
      }
      if (first === 'search') {
        if (params.type === 'adgeolocation') return json({ data: [{ key: '2420379', name: 'Dhaka', type: 'city', country_code: 'BD', country_name: 'Bangladesh', region: 'Dhaka Division' }, { key: 'BD', name: 'Bangladesh', type: 'country', country_code: 'BD' }] });
        if (params.type === 'adinterest') return json({ data: [{ id: '6003139266461', name: 'Movies', audience_size_lower_bound: 1_000_000, path: ['Interests', 'Entertainment', 'Movies'] }] });
        if (params.type === 'adTargetingCategory') return json({ data: [{ id: '6002714895372', name: 'Frequent travelers', path: ['Behaviors', 'Travel'] }, { id: '6071631541183', name: 'Small business owners', path: ['Behaviors', 'Digital activities'] }] });
        if (params.type === 'adlocale') return json({ data: [{ key: 6, name: 'English (US)' }, { key: 46, name: 'Bengali' }] });
      }
      if (edge === 'customaudiences') return json({ data: [{ id: '9001', name: 'Past callers', subtype: 'CUSTOM', approximate_count_lower_bound: 1200, approximate_count_upper_bound: 1500, delivery_status: { status: 200 } }] });
      if (edge === 'thumbnails') return json({ data: [{ uri: 'https://scontent.example/t1.jpg', is_preferred: false }, { uri: 'https://scontent.example/t2.jpg', is_preferred: true }] });
      if (edge === 'campaigns' || edge === 'adsets' || edge === 'ads') return json({ data: created[edge].filter((x) => x.parent === first || first.startsWith('act_')) });
      if (first.startsWith('v') && params.fields === 'status') return json({ status: { video_status: ++processingChecks < 2 ? 'processing' : 'ready' } });
      if (first.startsWith('ad')) return json({ id: first, status: 'PAUSED', effective_status: 'PAUSED' });
      return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
    });
  });
  afterAll(async () => {
    setFetchForTests((...a) => fetch(...a));
    await closePool();
  });

  const base = () => ({
    name: 'Spring promo', goal: 'call', optimize: 'calls', mediaAssetId: video, caption: 'Call us today', title: 'Fast delivery', link: '+1 555 010 2000',
    countries: ['US'], ageMin: 21, ageMax: 60, budget: { kind: 'lifetime', mode: 'stepped', start: 20, step: 2 },
    startDate: '2099-01-10', endDate: '2099-01-20', hours: { from: '07:00', to: '22:00' }, placements: ['fb_feed', 'ig_reels'],
    rows: [{ accountRowId: acc['DE 179'], pageId: '502' }, { accountRowId: acc['DE 168'] }, { accountRowId: acc['DE 154'] }],
  });
  /** Runs scheduler ticks until no launch job is waiting (video processing reschedules are made due at once). */
  async function drain() {
    for (let i = 0; i < 20; i++) {
      await execute(`UPDATE jobs SET run_after=CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE status='queued' AND type='launch.item'`);
      const r = await tick('test', { budgetMs: 10_000 });
      if (!r.claimed) return;
    }
  }

  it('plans stepped budgets in the account order and lists what is missing', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const plan = (await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(base())).body;
    expect(plan.rows.map((r: any) => [r.accountName, r.position, r.budget, r.pageName, r.link])).toEqual([
      ['DadExpress DE 168', 1, 20, null, '+15550102000'],
      ['DadExpress DE 154', 2, 22, null, '+15550102000'],
      ['DadExpress DE 179', 3, 24, 'Page B', '+15550102000'],
    ]);
    expect(plan.rows[1].issues).toEqual(['Choose a Facebook Page.']);
    // one Page for the whole launch; a row can still name its own
    const onePage = (await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...base(), pageId: '501' })).body;
    expect(onePage.rows.map((r: any) => r.pageName)).toEqual(['Page A', 'Page A', 'Page B']);
    expect(onePage.ready).toBe(true);
    const setup = (await agent.get('/api/launch/setup')).body;
    expect(setup.pages.map((p: any) => p.name)).toEqual(['Page A', 'Page B']);
    expect(plan.ready).toBe(false);
    expect(plan.totals).toEqual([{ currency: 'USD', total: 66 }]);
    expect(plan.days).toBe(10);
    const bad = (await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...base(), pageId: '501', endDate: '2099-01-10', hours: { from: '22:00', to: '07:00' } })).body;
    expect(bad.problems).toEqual(['The end date must be after the start date.', 'The end hour must be after the start hour.']);
    expect(bad.ready).toBe(false);

    const refused = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...base(), confirm: true });
    expect(refused.status).toBe(400);
    expect(calls).toEqual([]); // planning never calls Meta
  });

  it('reads an uploaded sheet: per-account budgets, captions and Pages', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const tpl = await agent.get('/api/launch/sheet-template.csv');
    expect(tpl.text.split('\r\n')[0]).toBe('\uFEFFaccount,budget,age_min,age_max,page,video,caption,title,phone_or_website');
    expect(tpl.text).toContain('DadExpress DE 168');
    const sheet = (await agent.post('/api/launch/sheet').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ csv: 'account,page,budget,caption,age_min,age_max\nDE 154,Page A,30,Hello 154,25,45\nDE 168,,,,,\n' })).body;
    expect(sheet.errors).toEqual([]);
    expect(sheet.rows).toEqual([{ accountRowId: acc['DE 154'], pageId: '501', dailyBudget: 30, caption: 'Hello 154', ageMin: 25, ageMax: 45 }, { accountRowId: acc['DE 168'] }]);
  });

  it('only roles that may publish can launch', async () => {
    const { agent, csrf } = await signIn(app, 'analyst@example.test', pw);
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...base(), confirm: true });
    expect(res.status).toBe(403);
  });

  it('creates campaign, ad set and ad PAUSED in every account, and stores the real IDs', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const body = { ...base(), pageId: '501', rows: [{ accountRowId: acc['DE 179'], pageId: '502', ageMin: 30, ageMax: 50 }, { accountRowId: acc['DE 168'] }, { accountRowId: acc['DE 154'] }] };
    expect((await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body)).status).toBe(400); // no confirm
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...body, confirm: true });
    expect(res.status).toBe(201);
    await drain();

    const l = (await agent.get(`/api/launches/${res.body.id}`)).body;
    expect(l.items.map((i: any) => [i.accountName, i.budget, i.budgetKind, i.status, i.adStatus])).toEqual([
      ['DadExpress DE 168', 20, 'lifetime', 'done', 'PAUSED'],
      ['DadExpress DE 154', 22, 'lifetime', 'done', 'PAUSED'],
      ['DadExpress DE 179', 24, 'lifetime', 'done', 'PAUSED'],
    ]);
    expect(l.items.every((i: any) => i.campaignId && i.adsetId && i.creativeId && i.adId && i.videoId)).toBe(true);

    const posts = calls.filter((c) => c.method === 'POST');
    // the first account is built first
    expect(posts[0].path).toBe('act_168/advideos');
    const camps = posts.filter((c) => c.path.endsWith('/campaigns'));
    expect(camps.map((c) => [c.params.status, c.params.objective, c.params.special_ad_categories, c.params.is_adset_budget_sharing_enabled])).toEqual(Array(3).fill(['PAUSED', 'OUTCOME_ENGAGEMENT', '[]', 'false']));
    const sets = posts.filter((c) => c.path.endsWith('/adsets'));
    // an account still waiting for Meta to process its video does not hold up the others
    expect(sets.map((c) => [c.path, c.params.lifetime_budget]).sort()).toEqual([['act_154/adsets', '2200'], ['act_168/adsets', '2000'], ['act_179/adsets', '2400']]);
    expect(sets.every((c) => c.params.daily_budget === undefined)).toBe(true);
    const first = sets.find((c) => c.path === 'act_168/adsets')!.params;
    // dates in the account's zone (Asia/Dhaka), hours 7:00–22:00 every day, fixed placements, no Advantage+ placements
    expect(first.start_time).toBe('2099-01-10T00:00:00+06:00');
    expect(first.end_time).toBe('2099-01-20T23:59:00+06:00');
    expect(first.pacing_type).toBe('["day_parting"]');
    expect(JSON.parse(first.adset_schedule)).toEqual([{ start_minute: 420, end_minute: 1320, days: [0, 1, 2, 3, 4, 5, 6], timezone_type: 'ADVERTISER' }]);
    expect(sets.find((c) => c.path === 'act_168/adsets')!.params).toMatchObject({ status: 'PAUSED', optimization_goal: 'QUALITY_CALL', destination_type: 'PHONE_CALL', billing_event: 'IMPRESSIONS', promoted_object: '{"page_id":"501"}' });
    expect(JSON.parse(first.targeting)).toEqual({ geo_locations: { countries: ['US'] }, age_min: 21, age_max: 60, targeting_automation: { advantage_audience: 0 }, publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['reels'] });
    // the same ad everywhere; only budget and age range differ per account
    expect(JSON.parse(sets.find((c) => c.path === 'act_179/adsets')!.params.targeting)).toMatchObject({ age_min: 30, age_max: 50 });
    const crPost = posts.find((c) => c.path === 'act_179/adcreatives')!;
    const cr = JSON.parse(crPost.params.object_story_spec);
    // every Advantage+ creative feature is opted out
    const dof = JSON.parse(crPost.params.degrees_of_freedom_spec).creative_features_spec;
    expect(dof.standard_enhancements).toEqual({ enroll_status: 'OPT_OUT' });
    expect(Object.values(dof).every((v: any) => v.enroll_status === 'OPT_OUT')).toBe(true);
    expect(cr).toMatchObject({ page_id: '502', video_data: { image_url: 'https://scontent.example/t2.jpg', message: 'Call us today', title: 'Fast delivery', call_to_action: { type: 'CALL_NOW', value: { link: 'tel:+15550102000' } } } });
    expect(posts.filter((c) => c.path.endsWith('/ads')).every((c) => c.params.status === 'PAUSED')).toBe(true);
    // nothing anywhere asks Meta to switch something on
    expect(posts.some((c) => c.params.status === 'ACTIVE')).toBe(false);
    // the Page is remembered for next time
    expect((await queryOne<any>(`SELECT page_id, phone_number FROM account_defaults WHERE ad_account_row_id=?`, [acc['DE 154']]))).toEqual({ page_id: '501', phone_number: '+15550102000' });
  });

  it('reuses an uploaded video, and a retry after an unanswered request does not create a duplicate ad', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    calls.length = 0;
    timeoutOnAd = true;
    const body = { ...base(), name: 'Second', goal: 'website', optimize: 'clicks', link: 'https://dadexpress.example/offer', cta: 'SHOP_NOW', pageId: '501', rows: [{ accountRowId: acc['DE 168'] }] };
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...body, confirm: true });
    await drain();
    expect(calls.some((c) => c.path.endsWith('/advideos'))).toBe(false); // same video, same account: reused
    let l = (await agent.get(`/api/launches/${res.body.id}`)).body;
    expect(l.items[0]).toMatchObject({ status: 'needs_review', stage: 'ad', adId: null });
    expect(l.items[0].error.hint).toMatch(/does not create a duplicate/);
    const set = calls.find((c) => c.path.endsWith('/adsets'))!;
    expect(set.params).toMatchObject({ optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE' });
    expect(set.params.promoted_object).toBeUndefined();
    expect(JSON.parse(calls.find((c) => c.path.endsWith('/adcreatives'))!.params.object_story_spec).video_data.call_to_action).toEqual({ type: 'SHOP_NOW', value: { link: 'https://dadexpress.example/offer' } });

    expect((await agent.post(`/api/launches/${res.body.id}/items/${l.items[0].id}/retry`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(200);
    await drain();
    l = (await agent.get(`/api/launches/${res.body.id}`)).body;
    expect(l.items[0]).toMatchObject({ status: 'done', adStatus: 'PAUSED' });
    const mine = created.ads.filter((a) => a.name.includes(`[L${res.body.id}-1]`));
    expect(mine).toHaveLength(1); // found the ad Meta had created instead of making another
    expect(l.items[0].adId).toBe(mine[0].id);
    const list = (await agent.get('/api/launches')).body.items;
    expect(list[0]).toMatchObject({ name: 'Second', items: 1, done: 1, failed: 0 });
    expect((await query(`SELECT * FROM meta_video_uploads`)).length).toBe(3);
  });

  it('Advanced Ads: Meta lists for places, interests, behaviours, languages and audiences; every extra control reaches the ad set', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const search = (type: string, q: string) => agent.get(`/api/launch/search?type=${type}&q=${encodeURIComponent(q)}`).then((r) => r.body.items);
    expect(await search('location', 'dha')).toEqual([
      { key: '2420379', name: 'Dhaka', type: 'city', countryCode: 'BD', detail: 'Dhaka Division, Bangladesh' },
      { key: 'BD', name: 'Bangladesh', type: 'country', countryCode: 'BD', detail: '' },
    ]);
    expect(await search('interest', 'mov')).toMatchObject([{ key: '6003139266461', name: 'Movies', detail: 'Interests › Entertainment › Movies', audience: 1_000_000 }]);
    expect((await search('behavior', 'travel')).map((x: any) => x.name)).toEqual(['Frequent travelers']);
    expect(await search('locale', 'ben')).toEqual([{ key: '6', name: 'English (US)', type: 'locale' }, { key: '46', name: 'Bengali', type: 'locale' }]);
    expect((await agent.get(`/api/launch/accounts/${acc['DE 168']}/audiences`)).body.items).toEqual([{ id: '9001', name: 'Past callers', subtype: 'CUSTOM', sizeLow: 1200, sizeHigh: 1500, status: 200 }]);

    const advanced = {
      bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: 1.5,
      locations: { include: [{ key: '2420379', name: 'Dhaka', type: 'city', radius: 20 }, { key: '3891', name: 'Sylhet Division', type: 'region' }], exclude: [{ key: '2420380', name: 'Gazipur', type: 'city' }], types: ['home'] },
      interests: [{ key: '6003139266461', name: 'Movies' }], behaviors: [{ key: '6002714895372', name: 'Frequent travelers' }], excludedInterests: [{ key: '6003020834693', name: 'Gambling' }],
      locales: [{ key: '46', name: 'Bengali' }], devicePlatforms: ['mobile'], userOs: ['Android'], days: [1, 2, 3, 4, 5], description: 'Open 7 days', urlTags: 'utm_source=fb', creativeEnhancements: false,
    };
    const body = { ...base(), name: 'Advanced test', goal: 'website', optimize: 'clicks', link: 'https://example.com/', countries: ['BD'], pageId: '501', advanced, rows: [{ accountRowId: acc['DE 168'], customAudiences: { include: ['9001'], exclude: [] } }] };
    // problems are named before anything is created
    const bad = (await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...body, specialCategory: 'EMPLOYMENT', advanced: { ...advanced, bidAmount: undefined } })).body;
    expect(bad.problems).toEqual(expect.arrayContaining(['A bid cap needs an amount.', 'Job ads cannot exclude interests (Meta special ad category rule).', 'Job ads cannot exclude locations (Meta special ad category rule).']));
    expect((await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body)).body.ready).toBe(true);

    calls.length = 0;
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...body, confirm: true });
    expect(res.status).toBe(201);
    await drain();
    const l = (await agent.get(`/api/launches/${res.body.id}`)).body;
    expect(l.items.map((i: any) => [i.status, i.adStatus])).toEqual([['done', 'PAUSED']]);
    const set = calls.find((c) => c.method === 'POST' && c.path === 'act_168/adsets')!.params;
    expect(set.bid_strategy).toBe('LOWEST_COST_WITH_BID_CAP');
    expect(set.bid_amount).toBe('150');
    expect(JSON.parse(set.adset_schedule)[0].days).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.parse(set.targeting)).toEqual({
      geo_locations: { countries: ['BD'], regions: [{ key: '3891' }], cities: [{ key: '2420379', radius: 20, distance_unit: 'mile' }], location_types: ['home'] },
      excluded_geo_locations: { cities: [{ key: '2420380' }] },
      age_min: 21, age_max: 60, targeting_automation: { advantage_audience: 0 },
      flexible_spec: [{ interests: [{ id: '6003139266461', name: 'Movies' }], behaviors: [{ id: '6002714895372', name: 'Frequent travelers' }] }],
      exclusions: { interests: [{ id: '6003020834693', name: 'Gambling' }] },
      locales: [46], device_platforms: ['mobile'], user_os: ['Android'],
      custom_audiences: [{ id: '9001' }],
      publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['reels'],
    });
    const cr = calls.find((c) => c.method === 'POST' && c.path === 'act_168/adcreatives')!.params;
    expect(cr.url_tags).toBe('utm_source=fb');
    expect(JSON.parse(cr.object_story_spec).video_data).toMatchObject({ link_description: 'Open 7 days', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.com/' } } });
    expect(JSON.parse(cr.degrees_of_freedom_spec).creative_features_spec.standard_enhancements).toEqual({ enroll_status: 'OPT_OUT' });
  });

  it('campaign objective and buying type are chosen by hand; unsupported pairs are named before anything is created', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const plan = (b: any) => agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(b).then((r) => r.body);
    const setup = (await agent.get('/api/launch/setup')).body;
    expect(setup.objectives.map((o: any) => o.value)).toEqual(['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION']);
    expect(setup.objectives.find((o: any) => o.value === 'OUTCOME_LEADS').website).toBeNull();
    expect(setup.buyingTypes.map((b: any) => [b.value, b.supported])).toEqual([['AUCTION', true], ['RESERVED', false]]);
    // what Meta cannot do with the panel's inputs is said up front
    expect((await plan({ ...base(), pageId: '501', goal: 'website', link: 'https://x.example/', objective: 'OUTCOME_LEADS', optimize: 'LINK_CLICKS' })).problems).toContain('Leads runs as Calls: conversion location Calls, with your Facebook Page. Pick the performance goal under "Meta optimizes for".');
    // the Calls performance goals Meta's API lists: calls, and 60-second calls (undocumented by Meta, passed through as is)
    expect(setup.objectives.find((o: any) => o.value === 'OUTCOME_LEADS').call.map((x: any) => x.value)).toEqual(['QUALITY_CALL', 'MEANINGFUL_CALL_ATTEMPT']);
    expect((await plan({ ...base(), pageId: '501', objective: 'OUTCOME_LEADS', optimize: 'MEANINGFUL_CALL_ATTEMPT' })).goal).toMatchObject({ optimization_goal: 'MEANINGFUL_CALL_ATTEMPT', destination_type: 'PHONE_CALL', promotedPage: true });
    // Leads + Call builds exactly the Ads Manager ad set: conversion location Calls, "Maximize number of calls", the Page promoted
    expect((await plan({ ...base(), pageId: '501', objective: 'OUTCOME_LEADS', optimize: 'QUALITY_CALL' })).goal).toMatchObject({ objective: 'OUTCOME_LEADS', optimization_goal: 'QUALITY_CALL', destination_type: 'PHONE_CALL', promotedPage: true, label: 'Maximize number of calls' });
    expect((await plan({ ...base(), pageId: '501', buyingType: 'RESERVED' })).problems).toContain('Only the Auction buying type is supported. Reserved buying needs a reach and frequency prediction.');
    expect((await plan({ ...base(), pageId: '501', spendCap: 50 })).problems).toContain('Meta requires a campaign spending limit of at least 100 in the account currency.');
    // the default is unchanged: Calls under Engagement
    expect((await plan({ ...base(), pageId: '501' })).goal).toMatchObject({ objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'QUALITY_CALL', destination_type: 'PHONE_CALL' });
    // Awareness + video views on a website ad: no destination, Page promoted, spend cap on the campaign
    const body = { ...base(), name: 'Awareness test', pageId: '501', goal: 'website', link: 'https://x.example/', objective: 'OUTCOME_AWARENESS', optimize: 'THRUPLAY', spendCap: 500, rows: [{ accountRowId: acc['DE 154'] }] };
    expect((await plan(body)).ready).toBe(true);
    calls.length = 0;
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...body, confirm: true });
    expect(res.status).toBe(201);
    await drain();
    const camp = calls.find((c) => c.method === 'POST' && c.path === 'act_154/campaigns')!.params;
    expect(camp).toMatchObject({ objective: 'OUTCOME_AWARENESS', buying_type: 'AUCTION', spend_cap: '50000', status: 'PAUSED' });
    const set = calls.find((c) => c.method === 'POST' && c.path === 'act_154/adsets')!.params;
    expect(set.optimization_goal).toBe('THRUPLAY');
    expect(set.destination_type).toBeUndefined();
    expect(set.promoted_object).toBeUndefined();
    // Leads with Calls promotes the Page and asks for quality calls
    const leads = (await plan({ ...base(), pageId: '501', objective: 'OUTCOME_LEADS', optimize: 'QUALITY_CALL' })).goal;
    expect(leads).toMatchObject({ objective: 'OUTCOME_LEADS', optimization_goal: 'QUALITY_CALL', destination_type: 'PHONE_CALL', promotedPage: true });
  });

  it('falls back when Meta refuses the Advantage+ creative switches, and says so on the row', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    rejectCreativeSwitches = true;
    creativeSpecs.length = 0;
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...base(), name: 'Third', pageId: '501', rows: [{ accountRowId: acc['DE 154'] }], confirm: true });
    expect(res.status).toBe(201);
    await drain();
    rejectCreativeSwitches = false;
    const l = (await agent.get(`/api/launches/${res.body.id}`)).body;
    expect(creativeSpecs).toEqual([14, 1]); // all switches refused, the umbrella switch accepted
    expect(l.items[0]).toMatchObject({ status: 'done', adStatus: 'PAUSED' });
    expect(l.items[0].warning).toMatch(/accepted only the main/);
  });
  it('several videos make several ads in the one ad set of every account, each with its own text when given', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    const org = (await queryOne<any>(`SELECT org_id FROM media_assets WHERE id=?`, [video])).org_id;
    const clip2 = (await execute(`INSERT INTO media_assets (org_id, kind, original_name, content_type, size_bytes, object_key, status, part_size, part_count) VALUES (?, 'video', 'clip2.mp4', 'video/mp4', 1000, 'coastal-media/clip2.mp4', 'ready', 1000, 1)`, [org])).insertId;
    const uploading = (await execute(`INSERT INTO media_assets (org_id, kind, original_name, content_type, size_bytes, object_key, status, part_size, part_count) VALUES (?, 'video', 'half.mp4', 'video/mp4', 1000, 'coastal-media/half.mp4', 'uploading', 1000, 1)`, [org])).insertId;
    const rows = [{ accountRowId: acc['DE 154'] }];
    // problems are named per ad, before anything is created
    let plan = (await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...base(), name: 'Multi', pageId: '501', rows, moreAds: [{}, { mediaAssetId: uploading }] })).body;
    expect(plan.problems).toEqual(['Choose a video for ad 2.', 'The video for ad 3 has not finished uploading.']);
    expect(plan.ready).toBe(false);

    calls.length = 0;
    const body = { ...base(), name: 'Multi', pageId: '501', rows, moreAds: [{ mediaAssetId: clip2, caption: 'Second clip', title: 'Other headline' }, { mediaAssetId: video }] };
    plan = (await agent.post('/api/launch/plan').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body)).body;
    expect(plan.ready).toBe(true);
    expect(plan.adsPerAccount).toBe(3);
    expect(plan.rows[0].ads.map((a: any) => [a.videoName, a.caption, a.title])).toEqual([['promo.mp4', 'Call us today', 'Fast delivery'], ['clip2.mp4', 'Second clip', 'Other headline'], ['promo.mp4', 'Call us today', 'Fast delivery']]);
    const res = await agent.post('/api/launches').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ ...body, confirm: true });
    expect(res.status).toBe(201);
    await drain();

    const l = (await agent.get(`/api/launches/${res.body.id}`)).body;
    expect(l.items[0]).toMatchObject({ status: 'done', adStatus: 'PAUSED' });
    expect(l.items[0].ads.map((a: any) => [a.position, a.adStatus, !!a.videoId, !!a.creativeId, !!a.adId])).toEqual([[1, 'PAUSED', true, true, true], [2, 'PAUSED', true, true, true], [3, 'PAUSED', true, true, true]]);
    expect(new Set(l.items[0].ads.map((a: any) => a.adId)).size).toBe(3);
    expect(l.items[0].ads[0].videoId).toBe(l.items[0].ads[2].videoId); // same video twice: uploaded once
    expect(l.items[0].adId).toBe(l.items[0].ads[0].adId);
    const posts = calls.filter((c) => c.method === 'POST');
    // promo.mp4 was already in this account from an earlier launch; only clip2 is uploaded
    expect(posts.filter((c) => c.path === 'act_154/advideos').length).toBe(1);
    expect(posts.filter((c) => c.path === 'act_154/campaigns').length).toBe(1);
    expect(posts.filter((c) => c.path === 'act_154/adsets').length).toBe(1);
    const creatives = posts.filter((c) => c.path === 'act_154/adcreatives').map((c) => JSON.parse(c.params.object_story_spec).video_data);
    expect(creatives.map((v) => [v.message, v.title])).toEqual([['Call us today', 'Fast delivery'], ['Second clip', 'Other headline'], ['Call us today', 'Fast delivery']]);
    const ads = posts.filter((c) => c.path === 'act_154/ads');
    expect(ads.map((c) => c.params.name)).toEqual([`Multi · Ad 1 [L${res.body.id}-1]`, `Multi · Ad 2 [L${res.body.id}-1]`, `Multi · Ad 3 [L${res.body.id}-1]`]);
    expect(ads.every((c) => c.params.status === 'PAUSED' && c.params.adset_id === l.items[0].adsetId)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { setAiFetchForTests } from '../src/ai/openai.js';
import { computeFindings } from '../src/ai/findings.js';
import { closePool, freshDb, signIn, TEST_ORIGIN } from './helpers.js';

const AI_ENV = { OPENAI_API_KEY: 'sk-test-not-real', OPENAI_MODEL: 'gpt-test', OPENAI_BASE_URL: 'https://openai.example.test/v1' };

describe('AI Analytics findings are computed by code', () => {
  const acc = (id: number, name: string, over: Partial<any> = {}) => ({ id, accountId: String(id), name, currency: 'USD', position: id, synced: true, syncedAt: null, range: { since: '2026-11-01', until: '2026-11-07' }, spend: 100, impressions: 10_000, clicks: 200, linkClicks: 150, leads: 0, calls: 10, messages: 0, results: [{ type: 'click_to_call_native_call_placed', label: 'Calls', count: 10, costPer: 10 }], ctr: 2, cpc: 0.5, activeCampaigns: 1, activeAds: 2, disapprovedAds: 0, syncError: null, ...over });
  it('flags spikes, stalls, expensive and cheap results, low balance and failed launches with evidence', () => {
    const daily = new Map<number, { date: string; spend: number; results: number }[]>();
    const days = (spend: number[], today: number | null) => [...spend.map((s, i) => ({ date: `2026-11-0${i + 1}`, spend: s, results: 1 })), ...(today == null ? [] : [{ date: '2026-11-08', spend: today, results: 0 }])];
    daily.set(1, days([20, 20, 20, 20, 20, 20, 20], 70)); // spike
    daily.set(2, days([20, 20, 20, 20, 20, 20, 20], 0)); // stall
    daily.set(3, days([20, 20, 20, 20, 20, 20, 20], 20));
    const out = computeFindings({
      accounts: [
        acc(1, 'A'), acc(2, 'B'), acc(3, 'C', { results: [{ type: 'click_to_call_native_call_placed', label: 'Calls', count: 10, costPer: 30 }] }),
        acc(4, 'D', { results: [{ type: 'click_to_call_native_call_placed', label: 'Calls', count: 20, costPer: 4 }] }),
        acc(5, 'E', { results: [{ type: 'click_to_call_native_call_placed', label: 'Calls', count: 10, costPer: 11 }] }),
        acc(6, 'F', { results: [], calls: 0, spend: 80 }), acc(7, 'G', { synced: false }), acc(8, 'H', { disapprovedAds: 2 }),
      ],
      campaigns: [], balances: [{ id: 1, name: 'A', currency: 'USD', kind: 'prepaid', available: 15, owed: null, capLeft: null, remaining: 15, avgDailySpend: 20, daysLeft: 0.8, spentToday: 5 }],
      daily, launches: [{ id: 9, name: 'Nov', failed: 2, pending: 1 }], today: '2026-11-08',
    });
    const kinds = Object.fromEntries(out.map((f) => [`${f.kind}:${f.accountName ?? ''}`, f]));
    expect(kinds['spend_spike:A'].evidence).toEqual({ today: 70, avgPerDay: 20, days: 7 });
    expect(kinds['stalled_delivery:B']).toBeTruthy();
    expect(kinds['cost_per_result_high:C'].evidence).toMatchObject({ costPer: 30, typical: 10, accountsCompared: 6 });
    expect(kinds['cost_per_result_low:D'].severity).toBe('good');
    expect(kinds['spend_no_results:F']).toBeTruthy();
    expect(kinds['not_synced:G'].severity).toBe('info');
    expect(kinds['rejected_ads:H'].evidence.rejectedAds).toBe(2);
    expect(kinds['low_balance:A'].severity).toBe('critical');
    expect(kinds['launch_failed:'].link).toBe('/publishing?launch=9');
    expect(out[0].severity).toBe('critical'); // sorted most severe first
    expect(out.some((f) => f.kind === 'cost_per_result_high' && f.accountName === 'E')).toBe(false); // near the median: no finding
  });
});

describe('AI Copilot, documents and exports', () => {
  let app: ReturnType<typeof createApp>;
  const pw = 'super admin password 1';
  const requests: any[] = [];
  /** Scripted model replies: each call pops the next one. */
  let script: any[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const reply = (message: any) => ({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

  beforeAll(async () => {
    await freshDb(AI_ENV);
    app = createApp();
    const org = (await execute(`INSERT INTO orgs (name) VALUES ('O')`)).insertId;
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [org, 'boss@example.test', 'Boss', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'viewer')`, [org, 'viewer@example.test', 'V', await hashPassword(pw)]);
    const c = (await execute(`INSERT INTO meta_connections (org_id, connected_by, meta_user_id, token_ciphertext, token_key_id, status) VALUES (?,1,'mu1','x','k1','active')`, [org])).insertId;
    for (const [name, id, order] of [['DE 168', '168', 1], ['DE 154', '154', 2]] as const) {
      const a = (await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, timezone_name, account_status, is_managed, display_order, live_full_synced_at) VALUES (?,?,?,?, 'USD', 'UTC', 1, 1, ?, NOW(3))`, [org, c, id, name, order])).insertId;
      await execute(`INSERT INTO meta_campaigns (ad_account_row_id, campaign_id, name, status, effective_status, objective, synced_at) VALUES (?,?,?, 'ACTIVE','ACTIVE','OUTCOME_ENGAGEMENT', NOW(3))`, [a, `9${id}`, `Calls ${name}`]);
      await execute(`INSERT INTO meta_adsets (ad_account_row_id, adset_id, campaign_id, name, status, effective_status, daily_budget_minor, synced_at) VALUES (?,?,?,?, 'ACTIVE','ACTIVE', 2000, NOW(3))`, [a, `8${id}`, `9${id}`, 'Set']);
      for (let d = 1; d <= 8; d++)
        await execute(`INSERT INTO meta_insights_daily (ad_account_row_id, level, object_id, date, spend, impressions, clicks, link_clicks, leads, calls, messages, result_type, results, synced_at) VALUES (?, 'campaign', ?, CURRENT_DATE - INTERVAL ? DAY, ?, 1000, 40, 30, 0, ?, 0, 'click_to_call_native_call_placed', ?, NOW(3))`, [a, `9${id}`, d, order === 1 ? 20 : 10, 4, 4]);
    }
    setAiFetchForTests(async (url: any, init: any) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url: String(url), auth: init.headers.authorization, body });
      const next = script.shift();
      if (!next) return json({ error: { message: 'script exhausted' } }, 500);
      if (next.status) return json(next.body, next.status);
      return json(reply(next));
    });
  });
  afterAll(async () => {
    setAiFetchForTests((...a) => fetch(...a));
    await closePool();
  });

  it('answers only from tool data and turns a budget tool call into a proposal, never a change', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    script = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_accounts', arguments: '{"period":"7d"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'propose_budget_change', arguments: '{"mode":"stepped","start":30,"step":5,"reason":"DE 168 gets cheaper calls"}' } }] },
      { role: 'assistant', content: 'গত ৭ দিনে DE 168 খরচ করেছে USD 140 আর DE 154 USD 70। বাজেট প্ল্যান দেখানো হলো, এখনো কিছু বদলানো হয়নি।' },
    ];
    const res = await agent.post('/api/ai/conversations/new/messages?wait=1').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ content: 'গত সপ্তাহে কোন অ্যাকাউন্ট বেশি খরচ করেছে? বাজেট বাড়াও' });
    expect(res.status).toBe(200);
    expect(res.body.toolsUsed).toEqual(['get_accounts', 'propose_budget_change']);
    // the key goes only to the configured base URL, and tools are offered
    expect(requests[0].url).toBe('https://openai.example.test/v1/chat/completions');
    expect(requests[0].auth).toBe('Bearer sk-test-not-real');
    expect(requests[0].body.model).toBe('gpt-test');
    expect(requests[0].body.tools.map((t: any) => t.function.name)).toContain('get_accounts');
    // the tool reply carried the real synced numbers (7 full days × 20 and × 10)
    const toolMsg = requests[1].body.messages.find((m: any) => m.role === 'tool');
    const data = JSON.parse(toolMsg.content);
    expect(data.accounts.map((a: any) => [a.name, a.spend, a.calls])).toEqual([['DE 168', 140, 28], ['DE 154', 70, 28]]);
    // the proposal is visible and computed like the Budgets page; nothing was written
    const proposal = res.body.messages.find((m: any) => m.proposal)?.proposal;
    expect(proposal.items.map((i: any) => [i.accountName, i.current, i.next])).toEqual([['DE 168', 20, 30], ['DE 154', 20, 35]]);
    expect(proposal.reason).toBe('DE 168 gets cheaper calls');
    expect(res.body.messages.at(-1).content).toMatch(/USD 140/);
    const conv = (await agent.get(`/api/ai/conversations/${res.body.conversationId}`)).body;
    expect(conv.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect((await agent.get('/api/ai/conversations')).body.items).toHaveLength(1);
  });

  it('refuses a viewer and explains an OpenAI key problem', async () => {
    const v = await signIn(app, 'viewer@example.test', pw);
    expect((await v.agent.post('/api/ai/conversations/new/messages?wait=1').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', v.csrf).send({ content: 'hi' })).status).toBe(403);
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    script = [{ status: 401, body: { error: { message: 'Incorrect API key provided' } } }];
    const res = await agent.post('/api/ai/conversations/new/messages?wait=1').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ content: 'hello' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'AI_AUTH', hint: 'Check OPENAI_API_KEY in the hosting settings.' });
  });

  it('answers in the background: the request returns at once and the panel polls for the answer or the error', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    script = [{ role: 'assistant', content: 'Nothing is spending today.' }];
    const res = await agent.post('/api/ai/conversations/new/messages').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ content: 'anything spending?' });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);
    let conv: any;
    for (let i = 0; i < 50; i++) {
      conv = (await agent.get(`/api/ai/conversations/${res.body.conversationId}`)).body;
      if (!conv.pending && conv.messages.length === 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(conv.messages.map((m: any) => [m.role, m.content, m.error])).toEqual([['user', 'anything spending?', false], ['assistant', 'Nothing is spending today.', false]]);
    // a model failure lands in the conversation, marked as an error, instead of a lost request
    script = [{ status: 429, body: { error: { message: 'quota' } } }];
    const r2 = await agent.post(`/api/ai/conversations/${res.body.conversationId}/messages`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ content: 'again' });
    expect(r2.body.pending).toBe(true);
    for (let i = 0; i < 50; i++) {
      conv = (await agent.get(`/api/ai/conversations/${res.body.conversationId}`)).body;
      if (!conv.pending && conv.messages.length === 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(conv.messages.at(-1)).toMatchObject({ role: 'assistant', error: true, content: expect.stringContaining('rate-limiting') });
  });

  it('lists findings from synced data without calling the model', async () => {
    const { agent } = await signIn(app, 'boss@example.test', pw);
    const before = requests.length;
    const res = await agent.get('/api/ai/findings?period=7d');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toBe(2);
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(requests.length).toBe(before);
  });

  it('builds a document from data, versions edits, and exports Word and PDF', async () => {
    const { agent, csrf } = await signIn(app, 'boss@example.test', pw);
    script = [{ role: 'assistant', content: JSON.stringify({ summary: 'DE 168 spent USD 140 and DE 154 USD 70 in the last 7 days.', recommendations: '- Keep DE 168 at its budget.\n- Watch DE 154.' }) }];
    const created = await agent.post('/api/ai/documents').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ period: '7d' });
    expect(created.status).toBe(201);
    const doc = (await agent.get(`/api/ai/documents/${created.body.id}`)).body;
    expect(doc.sections.map((s: any) => s.id)).toEqual(['summary', 'overview', 'accounts', 'campaigns', 'balances', 'findings', 'recommendations']);
    const accounts = doc.sections.find((s: any) => s.id === 'accounts');
    expect(accounts.table.rows.map((r: any) => [r[1], r[2]])).toEqual([['DE 168', 'USD 140'], ['DE 154', 'USD 70']]);
    expect(doc.sections[0].ai).toBe(true);
    // the model was asked for JSON and given only real numbers
    expect(requests.at(-1).body.response_format).toEqual({ type: 'json_object' });

    const edited = doc.sections.map((s: any) => (s.id === 'summary' ? { ...s, body: 'Edited by Jamil.' } : s));
    const saved = await agent.put(`/api/ai/documents/${doc.id}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ sections: edited, note: 'Fixed the summary' });
    expect(saved.body.version).toBe(2);
    const v2 = (await agent.get(`/api/ai/documents/${doc.id}`)).body;
    expect(v2.sections[0].body).toBe('Edited by Jamil.');
    expect(v2.versions.map((v: any) => v.version)).toEqual([2, 1]);
    const v1 = (await agent.get(`/api/ai/documents/${doc.id}?version=1`)).body;
    expect(v1.sections[0].body).toMatch(/USD 140/);

    const docx = await agent.get(`/api/ai/documents/${doc.id}/export.docx`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(docx.status).toBe(200);
    expect(docx.headers['content-type']).toContain('wordprocessingml');
    expect((docx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const pdf = await agent.get(`/api/ai/documents/${doc.id}/export.pdf`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);

    const v = await signIn(app, 'viewer@example.test', pw);
    expect((await v.agent.get('/api/ai/documents')).status).toBe(200); // viewers can read reports
    expect((await v.agent.post('/api/ai/documents').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', v.csrf).send({})).status).toBe(403);
  });
});

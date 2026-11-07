import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { execute, queryOne } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { closePool, freshDb, TEST_ORIGIN } from './helpers.js';

let app: ReturnType<typeof createApp>;
const admin = { email: 'admin@example.test', password: 'correct horse battery staple' };

/** A logged-in agent that sends the Origin header and CSRF token like the real frontend. */
async function login(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(async () => {
  await freshDb();
  app = createApp();
});
afterAll(closePool);

describe('first-time setup', () => {
  it('bootstrap says setup is required on an empty install', async () => {
    const res = await request(app).get('/api/public/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.setupRequired).toBe(true);
    expect(res.body.schema.upToDate).toBe(true);
    expect(res.body.branding.panelName).toBe('Ads Command Center');
  });

  it('rejects setup from a foreign origin', async () => {
    const res = await request(app).post('/api/setup/admin').set('Origin', 'https://evil.example').send({ orgName: 'X', name: 'X', email: 'x@x.io', password: 'x'.repeat(12) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_MISMATCH');
  });

  it('creates the first Super Admin and then refuses a second setup', async () => {
    const ok = await request(app).post('/api/setup/admin').set('Origin', TEST_ORIGIN).send({ orgName: 'SM Enterprise', name: 'Jamil', ...admin });
    expect(ok.status).toBe(201);
    const again = await request(app).post('/api/setup/admin').set('Origin', TEST_ORIGIN).send({ orgName: 'Other', name: 'Other', email: 'o@x.io', password: 'y'.repeat(12) });
    expect(again.status).toBe(409);
    expect((await request(app).get('/api/public/bootstrap')).body.setupRequired).toBe(false);
  });
});

describe('authentication and protection', () => {
  it('returns structured errors with a correlation ID (bug 12)', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'NOT_SIGNED_IN', category: 'auth' });
    expect(res.body.error.correlationId).toMatch(/[0-9a-f-]{36}/);
    expect(res.headers['x-correlation-id']).toBe(res.body.error.correlationId);
  });

  it('rejects a wrong password without saying which part was wrong', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: admin.email, password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Email or password is incorrect.');
  });

  it('logs in and returns the user, permissions and branding', async () => {
    const { agent } = await login(admin.email, admin.password);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: admin.email, role: 'super_admin' });
    expect(me.body.permissions).toContain('settings.manage');
    expect(me.body.csrfToken).toHaveLength(64);
  });

  it('requires the CSRF token on writes', async () => {
    const { agent } = await login(admin.email, admin.password);
    const res = await agent.put('/api/settings/branding').set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });
});

describe('branding persistence (regression 26)', () => {
  it('saves the panel name and AI name and returns them publicly', async () => {
    const { agent, csrf } = await login(admin.email, admin.password);
    const body = {
      panelName: 'SM Ads Panel',
      logoUrl: null,
      faviconUrl: null,
      primaryColor: '#0f766e',
      sidebarStyle: 'default',
      defaultTheme: 'dark',
      defaultCurrency: 'USD',
      timezone: 'Asia/Dhaka',
      defaultLanguage: 'bn',
      aiAssistantName: 'Jamil AI',
    };
    const res = await agent.put('/api/settings/branding').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body);
    expect(res.status).toBe(200);
    const pub = await request(app).get('/api/public/bootstrap');
    expect(pub.body.branding).toMatchObject({ panelName: 'SM Ads Panel', aiAssistantName: 'Jamil AI', defaultTheme: 'dark', primaryColor: '#0f766e' });
    const audit = await queryOne(`SELECT action FROM audit_logs WHERE action='settings.branding_updated'`);
    expect(audit).not.toBeNull();
  });

  it('validates input and names the bad field', async () => {
    const { agent, csrf } = await login(admin.email, admin.password);
    const res = await agent.put('/api/settings/branding').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ panelName: 'x', primaryColor: 'red' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details.fields)).toEqual(expect.arrayContaining(['panelName', 'primaryColor']));
  });
});

describe('role enforcement', () => {
  it('a viewer cannot change branding or manage jobs', async () => {
    const r = await queryOne(`SELECT org_id FROM users LIMIT 1`);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'viewer')`, [r!.org_id, 'viewer@example.test', 'Viewer', await hashPassword('viewer password 123')]);
    const { agent, csrf } = await login('viewer@example.test', 'viewer password 123');
    const b = await agent.put('/api/settings/branding').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({});
    expect(b.status).toBe(403);
    expect(b.body.error.code).toBe('FORBIDDEN');
    const j = await agent.post('/api/jobs/run-now').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf);
    expect(j.status).toBe(403);
  });
});

describe('scheduler endpoint', () => {
  it('rejects ticks without the secret', async () => {
    const res = await request(app).post('/internal/tick');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TICK_UNAUTHORIZED');
  });

  it('runs a tick with the secret and the dashboard shows the scheduler running', async () => {
    const res = await request(app).post('/internal/tick').set('Authorization', 'Bearer test-runner-secret-0123456789abcdef0123').set('X-Tick-Source', 'hostinger');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    const { agent } = await login(admin.email, admin.password);
    const dash = await agent.get('/api/dashboard/summary');
    expect(dash.body.scheduler.state).toBe('running');
    expect(dash.body.performance.available).toBe(false);
  });
});

describe('accounts at scale (bug 14)', () => {
  it('searches 600 accounts with POST filters and paginates without a cap', async () => {
    const r = await queryOne(`SELECT org_id, id FROM users WHERE role='super_admin' LIMIT 1`);
    const conn = await execute(
      `INSERT INTO meta_connections (org_id, connected_by, meta_user_id, token_ciphertext, token_key_id) VALUES (?,?,?,?,?)`,
      [r!.org_id, r!.id, 'mu1', 'x', 'k1'],
    );
    const values: unknown[] = [];
    for (let i = 0; i < 600; i++) values.push([r!.org_id, conn.insertId, `10${i}`, `Account ${String(i).padStart(3, '0')}`, i % 3 ? 'USD' : 'BDT', i % 10 ? 1 : 2]);
    await execute(`INSERT INTO meta_ad_accounts (org_id, connection_id, account_id, name, currency, account_status) VALUES ?`, [values]);
    const { agent, csrf } = await login(admin.email, admin.password);
    const all = await agent.post('/api/accounts/search').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ pageSize: 500, page: 2 });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(600);
    expect(all.body.items.length).toBe(100);
    const active = await agent.post('/api/accounts/search').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ status: 'active', currency: 'BDT', pageSize: 10 });
    expect(active.body.total).toBe(180);
    expect(active.body.items[0].readiness.issues).toContain('No Facebook Page mapped');
  });
});

describe('health', () => {
  it('distinguishes configuration from live checks and marks publishing not implemented', async () => {
    const { agent } = await login(admin.email, admin.password);
    const res = await agent.get('/api/health');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.checks.map((c: any) => [c.id, c]));
    expect(byId['db.connection']).toMatchObject({ status: 'pass', evidence: 'live' });
    expect(byId['db.schema'].status).toBe('pass');
    expect(byId['meta.config'].status).toBe('not_configured');
    expect(byId['publishing.engine']).toMatchObject({ status: 'not_implemented', evidence: 'none' });
  });

  it('readyz reports the schema gate', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });
});

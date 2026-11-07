import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { execute, queryOne } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { base32Decode, base32Encode, currentStep, hotp, verifyTotp } from '../src/auth/totp.js';
import { closePool, freshDb, TEST_ORIGIN } from './helpers.js';

describe('TOTP maths', () => {
  it('matches the RFC 4226 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(hotp(secret, i)).toBe(code));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('accepts one window of clock drift and refuses replays', () => {
    const secret = base32Encode(Buffer.from('abcdefghij0123456789'));
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(secret, hotp(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step - 2), null, now)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', null, now)).toBeNull();
  });
});

describe('two-step login', () => {
  let app: ReturnType<typeof createApp>;
  let orgId = 0;
  const pw = 'super admin password 1';

  beforeAll(async () => {
    await freshDb();
    app = createApp();
    const org = await execute(`INSERT INTO orgs (name) VALUES ('O')`);
    orgId = org.insertId;
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [orgId, 'boss@example.test', 'Boss', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'super_admin')`, [orgId, 'boss2@example.test', 'Boss 2', await hashPassword(pw)]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'media_buyer')`, [orgId, 'buyer@example.test', 'Buyer', await hashPassword(pw)]);
  });
  afterAll(closePool);

  const send = (agent: any, method: 'post' | 'get', path: string, csrf: string, body?: object) => {
    const r = agent[method](path).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf);
    return method === 'post' ? r.send(body ?? {}) : r;
  };

  let secret = '';
  let recovery: string[] = [];

  it('blocks an admin without two-step login from everything except setting it up', async () => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    expect(r.body.mfaRequired).toBeUndefined();
    const me = await agent.get('/api/auth/me');
    expect(me.body.mfa).toEqual({ enabled: false, required: true, setupRequired: true });
    const blocked = await agent.get('/api/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_SETUP_REQUIRED');
    // Upgrades stay possible so a pending migration can never lock everyone out.
    expect((await agent.get('/api/admin/schema')).status).toBe(200);

    const setup = await send(agent, 'post', '/api/auth/2fa/setup', r.body.csrfToken);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/);
    expect(setup.body.qrSvg).toContain('<svg');
    secret = setup.body.secret.replace(/\s/g, '');

    const wrong = await send(agent, 'post', '/api/auth/2fa/enable', r.body.csrfToken, { code: '000000' });
    expect(wrong.status).toBe(400);
    const ok = await send(agent, 'post', '/api/auth/2fa/enable', r.body.csrfToken, { code: hotp(secret, currentStep()) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    recovery = ok.body.recoveryCodes;

    // Same session now works.
    expect((await agent.get('/api/users')).status).toBe(200);
    const row = await queryOne(`SELECT totp_secret_enc, recovery_codes FROM users WHERE email='boss@example.test'`);
    expect(row.totp_secret_enc).not.toContain(secret); // stored encrypted
    expect(JSON.stringify(row.recovery_codes)).not.toContain(recovery[0]); // stored hashed
  });

  it('asks for a code after the password, and creates no session until then', async () => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    expect(r.body).toMatchObject({ mfaRequired: true });
    expect(r.body.csrfToken).toBeUndefined();
    expect((await agent.get('/api/auth/me')).status).toBe(401);

    // The code used to enable is already spent (replay guard); the next window's code works.
    const replay = await agent.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: hotp(secret, currentStep()) });
    expect(replay.status).toBe(401);
    expect(replay.body.error.details.attemptsLeft).toBe(4);
    const v = await agent.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: hotp(secret, currentStep() + 1) });
    expect(v.status).toBe(200);
    expect((await agent.get('/api/auth/me')).body.mfa.enabled).toBe(true);

    // A challenge is single use.
    const again = await request(app).post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: '123456' });
    expect(again.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('locks the challenge after 5 wrong codes', async () => {
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    for (let i = 0; i < 5; i++) await agent.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: '000000' });
    const locked = await agent.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: '000000' });
    expect(locked.body.error.code).toBe('MFA_TOO_MANY_ATTEMPTS');
  });

  it('accepts each recovery code once', async () => {
    const a1 = request.agent(app);
    const r1 = await a1.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    const v1 = await a1.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r1.body.challenge, code: recovery[0].toLowerCase() });
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ usedRecoveryCode: true, recoveryCodesLeft: 9 });

    const a2 = request.agent(app);
    const r2 = await a2.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    const v2 = await a2.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r2.body.challenge, code: recovery[0] });
    expect(v2.status).toBe(401);
  });

  it('does not let an admin turn it off, but a non-admin can', async () => {
    const a = request.agent(app);
    const r = await a.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    const v = await a.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: recovery[1] });
    const off = await send(a, 'post', '/api/auth/2fa/disable', v.body.csrfToken, { password: pw, code: recovery[2] });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('MFA_REQUIRED_FOR_ROLE');

    // Media buyer: optional, so not blocked, and can enable then disable.
    const b = request.agent(app);
    const rb = await b.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'buyer@example.test', password: pw });
    expect((await b.get('/api/auth/me')).body.mfa).toEqual({ enabled: false, required: false, setupRequired: false });
    expect((await b.get('/api/media?status=all')).status).not.toBe(403);
    const s = await send(b, 'post', '/api/auth/2fa/setup', rb.body.csrfToken);
    const bs = s.body.secret.replace(/\s/g, '');
    await send(b, 'post', '/api/auth/2fa/enable', rb.body.csrfToken, { code: hotp(bs, currentStep()) });
    const d = await send(b, 'post', '/api/auth/2fa/disable', rb.body.csrfToken, { password: pw, code: hotp(bs, currentStep() + 1) });
    expect(d.status).toBe(200);
  });

  it('lets another Super Admin reset a lost phone, ending that user’s sessions', async () => {
    // boss2 enrols first (required role).
    const a2 = request.agent(app);
    const r2 = await a2.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss2@example.test', password: pw });
    const s = await send(a2, 'post', '/api/auth/2fa/setup', r2.body.csrfToken);
    await send(a2, 'post', '/api/auth/2fa/enable', r2.body.csrfToken, { code: hotp(s.body.secret.replace(/\s/g, ''), currentStep()) });

    const boss = request.agent(app);
    const r = await boss.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'boss@example.test', password: pw });
    const v = await boss.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: r.body.challenge, code: recovery[3] });
    const target = await queryOne(`SELECT id FROM users WHERE email='boss2@example.test'`);
    const self = await queryOne(`SELECT id FROM users WHERE email='boss@example.test'`);
    expect((await send(boss, 'post', `/api/users/${self.id}/reset-2fa`, v.body.csrfToken)).body.error.code).toBe('MFA_RESET_SELF');
    const reset = await send(boss, 'post', `/api/users/${target.id}/reset-2fa`, v.body.csrfToken);
    expect(reset.status).toBe(200);
    expect((await a2.get('/api/auth/me')).status).toBe(401);
    const audit = await queryOne(`SELECT action FROM audit_logs WHERE action='user.mfa_reset' AND target_id=?`, [String(target.id)]);
    expect(audit).toBeTruthy();
  });
});

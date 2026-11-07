import { randomBytes } from 'node:crypto';
import { parseEnv, setEnvForTests, type Env } from '../src/config/env.js';
import { closePool, db, initPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrations.js';

export const TEST_ORIGIN = 'https://proads.example.test';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    APP_ORIGIN: TEST_ORIGIN,
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME ?? 'acc_test',
    DB_USER: process.env.TEST_DB_USER ?? 'acc',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'acc_pw',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    JOB_RUNNER_SECRET: 'test-runner-secret-0123456789abcdef0123',
    IN_PROCESS_WORKER: 'false',
    ...overrides,
  });
}

/** Fresh database for each test file: drop every table, then run the real migrations. */
export async function freshDb(overrides: Record<string, string> = {}) {
  const e = testEnv(overrides);
  setEnvForTests(e);
  await closePool();
  initPool(e);
  await db().query('SET FOREIGN_KEY_CHECKS=0');
  const [tables] = await db().query<any[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`);
  for (const { t } of tables) await db().query(`DROP TABLE IF EXISTS \`${t}\``);
  await db().query('SET FOREIGN_KEY_CHECKS=1');
  await migrate(db(), 'test');
  return e;
}

export async function emptyDb() {
  const e = testEnv();
  setEnvForTests(e);
  await closePool();
  initPool(e);
  await db().query('SET FOREIGN_KEY_CHECKS=0');
  const [tables] = await db().query<any[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`);
  for (const { t } of tables) await db().query(`DROP TABLE IF EXISTS \`${t}\``);
  await db().query('SET FOREIGN_KEY_CHECKS=1');
  return e;
}

export { closePool };

/* ---- two-step login helpers for tests ---- */
import request from 'supertest';
import { execute as dbExecute } from '../src/db/pool.js';
import { currentStep, hotp } from '../src/auth/totp.js';

const secrets = new Map<string, string>();

/**
 * Signs in like the real frontend, including two-step login. Admin roles are enrolled on first use, because the
 * server refuses them everything else until they are. Test-only shortcut: the replay guard is reset before
 * reusing the current code, since tests sign in many times within one 30-second window.
 */
export async function signIn(app: any, email: string, password: string) {
  const agent = request.agent(app);
  let res = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.mfaRequired) {
    await dbExecute(`UPDATE users SET totp_last_step=NULL WHERE email=?`, [email]);
    res = await agent.post('/api/auth/login/verify').set('Origin', TEST_ORIGIN).send({ challenge: res.body.challenge, code: hotp(secrets.get(email)!, currentStep()) });
    if (res.status !== 200) throw new Error(`mfa verify failed: ${JSON.stringify(res.body)}`);
  }
  const csrf = res.body.csrfToken as string;
  const me = await agent.get('/api/auth/me');
  if (me.body.mfa?.setupRequired) {
    const s = await agent.post('/api/auth/2fa/setup').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({});
    const secret = s.body.secret.replace(/\s/g, '');
    secrets.set(email, secret);
    const en = await agent.post('/api/auth/2fa/enable').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ code: hotp(secret, currentStep()) });
    if (en.status !== 200) throw new Error(`mfa enable failed: ${JSON.stringify(en.body)}`);
  }
  return { agent, csrf };
}

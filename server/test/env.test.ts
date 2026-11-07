import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/config/env.js';

const base = {
  APP_ORIGIN: 'https://proads.smenterpriserl1987.com',
  DB_HOST: 'localhost',
  DB_NAME: 'x',
  DB_USER: 'x',
  SESSION_SECRET: 'a'.repeat(40),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  JOB_RUNNER_SECRET: 'b'.repeat(40),
};

function issues(src: Record<string, string>) {
  try {
    parseEnv(src);
    return [];
  } catch (e) {
    return (e as EnvError).issues;
  }
}

describe('environment validation (bugs 15, 16)', () => {
  it('accepts the production origin and redirect URI', () => {
    const e = parseEnv({ ...base, META_REDIRECT_URI: 'https://proads.smenterpriserl1987.com/api/meta/callback' });
    expect(e.APP_ORIGIN).toBe('https://proads.smenterpriserl1987.com');
    expect(e.PUBLISH_ENABLED).toBe(false);
    expect(e.ACTIVATION_ENABLED).toBe(false);
  });

  it('rejects a trailing slash on APP_ORIGIN', () => {
    expect(issues({ ...base, APP_ORIGIN: 'https://proads.smenterpriserl1987.com/' }).join()).toMatch(/APP_ORIGIN: must not end with a trailing slash/);
  });

  it('rejects a redirect URI on a different domain (the old pro.coastalmanpoweragency.com mistake)', () => {
    expect(issues({ ...base, META_REDIRECT_URI: 'https://pro.coastalmanpoweragency.com/api/meta/callback' }).join()).toMatch(/META_REDIRECT_URI: must be on APP_ORIGIN/);
  });

  it('names every missing required variable', () => {
    const list = issues({ APP_ORIGIN: base.APP_ORIGIN });
    for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'JOB_RUNNER_SECRET']) {
      expect(list.join('\n')).toContain(v);
    }
  });

  it('treats empty strings as missing', () => {
    expect(issues({ ...base, DB_HOST: '' }).join()).toContain('DB_HOST');
  });

  it('refuses ACTIVATION_ENABLED without PUBLISH_ENABLED', () => {
    expect(issues({ ...base, ACTIVATION_ENABLED: 'true' }).join()).toMatch(/requires PUBLISH_ENABLED/);
  });

  it('requires https in production', () => {
    expect(issues({ ...base, NODE_ENV: 'production', APP_ORIGIN: 'http://proads.smenterpriserl1987.com' }).join()).toMatch(/https/);
  });

  it('rejects a token key that is not 32 bytes', () => {
    expect(issues({ ...base, TOKEN_ENCRYPTION_KEY: 'short' }).join()).toContain('TOKEN_ENCRYPTION_KEY');
  });
});

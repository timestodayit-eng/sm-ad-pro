import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setEnvForTests } from '../src/config/env.js';
import { classifyMetaError, graph, graphPaged, MetaApiError, serializeParams, setFetchForTests } from '../src/meta/graph.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { sanitizeUrl } from '../src/lib/logger.js';
import { testEnv } from './helpers.js';

beforeAll(() => setEnvForTests(testEnv({ META_API_VERSION: 'v24.0' })));
afterEach(() => setFetchForTests((...a) => fetch(...a)));

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Graph request serialization', () => {
  it('sends booleans as explicit "true"/"false" strings, never dropping false (bug 1 groundwork)', () => {
    const p = serializeParams({ is_adset_budget_sharing_enabled: false, special_ad_categories: ['EMPLOYMENT'], skip: undefined });
    expect(p.get('is_adset_budget_sharing_enabled')).toBe('false');
    expect(p.get('special_ad_categories')).toBe('["EMPLOYMENT"]');
    expect(p.has('skip')).toBe(false);
  });

  it('POSTs form-encoded bodies with the token in the body, not the URL', async () => {
    let seen: { url: string; body: string } | null = null;
    setFetchForTests(async (url: any, init: any) => {
      seen = { url: String(url), body: String(init.body) };
      return jsonResponse(200, { id: '123' });
    });
    const r = await graph({ method: 'POST', path: 'act_1/campaigns', params: { status: 'PAUSED' }, accessToken: 'TOKEN', operation: 'test' });
    expect(r.data).toEqual({ id: '123' });
    expect(seen!.url).toBe('https://graph.facebook.com/v24.0/act_1/campaigns');
    expect(seen!.body).toContain('access_token=TOKEN');
  });
});

describe('Meta error classification', () => {
  it('maps the historical META_WRITE_100 budget-sharing error to a deterministic validation error', () => {
    const info = classifyMetaError(400, { error: { code: 100, message: 'Must specify True or False in is_adset_budget_sharing_enabled field', type: 'OAuthException' } });
    expect(info.class).toBe('validation');
  });

  it('maps the missing-thumbnail error with subcode 1443226', () => {
    const info = classifyMetaError(400, { error: { code: 100, error_subcode: 1443226, message: 'Your ad needs a video thumbnail' } });
    expect(info).toMatchObject({ class: 'validation', code: 100, subcode: 1443226 });
    expect(new MetaApiError(info, 'creative.create').code).toBe('META_100_1443226');
  });

  it('treats rate limits as retryable and expired tokens as auth', () => {
    expect(classifyMetaError(400, { error: { code: 17 } }).class).toBe('rate_limited');
    expect(classifyMetaError(400, { error: { code: 80004 } }).class).toBe('rate_limited');
    expect(classifyMetaError(400, { error: { code: 190, message: 'Session has expired' } }).class).toBe('auth');
    expect(new MetaApiError(classifyMetaError(400, { error: { code: 17 } }), 'x').retryable).toBe(true);
  });

  it('marks a network failure on a write as ambiguous so it is reconciled, not blindly retried (bugs 8, 9)', async () => {
    setFetchForTests(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const err = await graph({ method: 'POST', path: 'act_1/campaigns', accessToken: 't', operation: 'campaign.create' }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.meta.class).toBe('ambiguous');
    expect(err.retryable).toBe(false);
  });

  it('marks a network failure on a read as transient', async () => {
    setFetchForTests(async () => {
      throw new Error('ECONNRESET');
    });
    const err = await graph({ path: 'me', accessToken: 't', operation: 'me' }).catch((e) => e);
    expect(err.meta.class).toBe('transient');
    expect(err.retryable).toBe(true);
  });
});

describe('paging', () => {
  it('follows cursors until there is no next page', async () => {
    let calls = 0;
    setFetchForTests(async (url: any) => {
      calls++;
      const after = new URL(String(url)).searchParams.get('after');
      if (!after) return jsonResponse(200, { data: [{ id: 1 }, { id: 2 }], paging: { cursors: { after: 'c1' }, next: 'x' } });
      return jsonResponse(200, { data: [{ id: 3 }], paging: { cursors: { after: 'c2' } } });
    });
    const all = await graphPaged({ path: 'me/adaccounts', accessToken: 't', operation: 'list' });
    expect(all.map((a: any) => a.id)).toEqual([1, 2, 3]);
    expect(calls).toBe(2);
  });
});

describe('secrets', () => {
  it('encrypts tokens with AES-GCM and detects tampering', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const enc = encryptSecret('EAAB-token', key);
    expect(enc).not.toContain('EAAB');
    expect(decryptSecret(enc, key)).toBe('EAAB-token');
    const tampered = Buffer.from(enc, 'base64');
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSecret(tampered.toString('base64'), key)).toThrow();
  });

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('long enough password');
    expect(await verifyPassword('long enough password', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('redacts signatures and tokens from URLs before logging (bug 10/11 hygiene)', () => {
    const s = sanitizeUrl('https://smdb.r2.cloudflarestorage.com/coastal-media/a.mp4?X-Amz-Signature=abc&X-Amz-SignedHeaders=host&access_token=zzz');
    expect(s).not.toContain('abc');
    expect(s).not.toContain('zzz');
    expect(s).toContain('X-Amz-SignedHeaders=host');
  });
});

import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { execute, queryOne } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { planParts } from '../src/services/storage.js';
import { closePool, freshDb, TEST_ORIGIN } from './helpers.js';

/**
 * Runs the real upload pipeline against an S3-compatible server (moto locally, a moto container in CI).
 * Set TEST_S3_ENDPOINT (e.g. http://127.0.0.1:5055). Without it these tests are skipped, never faked.
 */
const S3 = process.env.TEST_S3_ENDPOINT;
const BUCKET = 'smdb-test';
const MiB = 1024 * 1024;

describe.skipIf(!S3)('media library against S3', () => {
  let app: ReturnType<typeof createApp>;
  let agent: ReturnType<typeof request.agent>;
  let csrf = '';
  const post = (p: string, body?: unknown) => agent.post(p).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send(body as object);

  beforeAll(async () => {
    await freshDb({ R2_ACCOUNT_ID: 'test', R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_ENDPOINT: S3!, R2_PREFIX: 'coastal-media/' });
    const s3 = new S3Client({ region: 'us-east-1', endpoint: S3, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    await s3.send(
      new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [TEST_ORIGIN], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'] }] } }),
    );
    const org = await execute(`INSERT INTO orgs (name) VALUES ('Test org')`);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'media_buyer')`, [org.insertId, 'buyer@example.test', 'Buyer', await hashPassword('buyer password 1234')]);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'viewer')`, [org.insertId, 'viewer@example.test', 'Viewer', await hashPassword('viewer password 1234')]);
    app = createApp();
    agent = request.agent(app);
    const r = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'buyer@example.test', password: 'buyer password 1234' });
    csrf = r.body.csrfToken;
  });
  afterAll(closePool);

  async function putParts(assetId: number, data: Buffer, partSize: number, numbers: number[]) {
    const urls = await post(`/api/media/uploads/${assetId}/part-urls`, { parts: numbers });
    expect(urls.status).toBe(200);
    for (const { partNumber, url } of urls.body.urls) {
      const chunk = data.subarray((partNumber - 1) * partSize, partNumber * partSize);
      const r = await fetch(url, { method: 'PUT', body: chunk });
      expect(r.status, await r.text()).toBe(200);
      expect(r.headers.get('etag')).toBeTruthy();
    }
  }

  it('plans parts of at least 8 MiB and at most 10,000 parts', () => {
    expect(planParts(5 * MiB)).toEqual({ partSize: 8 * MiB, partCount: 1 });
    expect(planParts(1024 * MiB)).toEqual({ partSize: 8 * MiB, partCount: 128 });
    expect(planParts(100 * 1024 * MiB).partCount).toBeLessThanOrEqual(10_000);
  });

  it('rejects file types Meta does not accept, and oversize files', async () => {
    const bad = await post('/api/media/uploads', { name: 'a.gif', size: 100, contentType: 'image/gif' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    const big = await post('/api/media/uploads', { name: 'a.mp4', size: 2 * 1024 ** 3, contentType: 'video/mp4' });
    expect(big.body.error.code).toBe('MEDIA_TOO_LARGE');
  });

  it('uploads a multi-part video, refuses to finish early, resumes, and verifies the size', async () => {
    const size = 17 * MiB + 12345; // 3 parts: 8 + 8 + 1.x MiB
    const data = Buffer.alloc(size, 7);
    const fingerprint = 'a'.repeat(64);
    const init = await post('/api/media/uploads', { name: 'Eid offer (final).mp4', size, contentType: 'video/mp4', fingerprint });
    expect(init.status).toBe(201);
    expect(init.body).toMatchObject({ partSize: 8 * MiB, partCount: 3, resumed: false });
    const id = init.body.assetId;

    await putParts(id, data, init.body.partSize, [1]);

    const early = await post(`/api/media/uploads/${id}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('MEDIA_PARTS_INCOMPLETE');
    expect(early.body.error.details.missing).toEqual([2, 3]);

    // Same file picked again (e.g. after a page reload): the server hands back the same upload with part 1 done.
    const again = await post('/api/media/uploads', { name: 'Eid offer (final).mp4', size, contentType: 'video/mp4', fingerprint });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ assetId: id, resumed: true, uploadedParts: [1] });

    await putParts(id, data, init.body.partSize, [2, 3]);
    const done = await post(`/api/media/uploads/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'ready', size, kind: 'video', name: 'Eid offer (final).mp4' });

    // Completing twice is harmless.
    expect((await post(`/api/media/uploads/${id}/complete`)).status).toBe(200);

    const row = await queryOne(`SELECT object_key, upload_id FROM media_assets WHERE id=?`, [id]);
    expect(row.object_key).toMatch(/^coastal-media\/\d+\/\d{4}\/\d{2}\/[0-9a-f-]{36}-Eid-offer-final-.mp4$/);
    expect(row.upload_id).toBeNull();

    const url = await agent.get(`/api/media/${id}/url`);
    const got = await fetch(url.body.url);
    expect(got.status).toBe(200);
    expect(Number(got.headers.get('content-length'))).toBe(size);
  });

  it('stores a thumbnail only through a signed token', async () => {
    const list = await agent.get('/api/media');
    const id = list.body.items[0].id;
    const forged = await agent.patch(`/api/media/${id}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ thumbnailToken: 'eyJrZXkiOiJ4In0.bad' });
    expect(forged.status).toBe(400);

    const t = await post(`/api/media/${id}/thumbnail-url`);
    const put = await fetch(t.body.url, { method: 'PUT', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), headers: { 'Content-Type': 'image/jpeg' } });
    expect(put.status).toBe(200);
    const patched = await agent.patch(`/api/media/${id}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf).send({ thumbnailToken: t.body.token, width: 1080, height: 1920, durationMs: 15000 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ hasThumbnail: true, width: 1080, height: 1920, durationMs: 15000 });
    expect(patched.body.thumbnailUrl).toContain('/thumbs/');
  });

  it('lists the library with totals, and viewers can read but not upload or delete', async () => {
    const list = await agent.get('/api/media');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.library.video.count).toBe(1);

    const viewer = request.agent(app);
    const v = await viewer.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'viewer@example.test', password: 'viewer password 1234' });
    expect((await viewer.get('/api/media')).status).toBe(200);
    const up = await viewer.post('/api/media/uploads').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', v.body.csrfToken).send({ name: 'x.mp4', size: 10, contentType: 'video/mp4' });
    expect(up.status).toBe(403);
    const del = await viewer.delete(`/api/media/${list.body.items[0].id}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', v.body.csrfToken);
    expect(del.status).toBe(403);
  });

  it('aborts an unfinished upload', async () => {
    const init = await post('/api/media/uploads', { name: 'cancel-me.mov', size: 1000, contentType: 'video/quicktime' });
    const abort = await post(`/api/media/uploads/${init.body.assetId}/abort`);
    expect(abort.status).toBe(200);
    const parts = await agent.get(`/api/media/uploads/${init.body.assetId}/parts`);
    expect(parts.status).toBe(409);
    expect(parts.body.error.code).toBe('MEDIA_NOT_UPLOADING');
  });

  it('deletes a file from the bucket and the library', async () => {
    const list = await agent.get('/api/media');
    const id = list.body.items[0].id;
    const url = (await agent.get(`/api/media/${id}/url`)).body.url;
    const del = await agent.delete(`/api/media/${id}`).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf);
    expect(del.status).toBe(200);
    expect((await fetch(url)).status).toBe(404);
    expect((await agent.get('/api/media')).body.total).toBe(0);
    expect((await agent.get(`/api/media/${id}/url`)).status).toBe(404);
  });

  it('runs the storage diagnostic: bucket, CORS policy, then a real test object', async () => {
    const d = await post('/api/media/diagnostics');
    expect(d.status).toBe(200);
    expect(d.body.bucketOk).toBe(true);
    expect(d.body.cors).toMatchObject({ readable: true, originAllowed: true, putAllowed: true, etagExposed: true });
    const put = await fetch(d.body.test.url, { method: 'PUT', body: 'ok', headers: { 'Content-Type': 'text/plain' } });
    expect(put.status).toBe(200);
    const fin = await post('/api/media/diagnostics/finish', { key: d.body.test.key, browserPut: true, browserEtag: true, cors: d.body.cors });
    expect(fin.body).toMatchObject({ serverSawObject: true, browserPut: true });
    expect(fin.body.error).toBeUndefined();

    const health = await agent.get('/api/health');
    const browser = health.body.checks.find((c: any) => c.id === 'storage.browser');
    expect(browser).toMatchObject({ status: 'pass', evidence: 'verified' });
    expect(health.body.checks.find((c: any) => c.id === 'storage.bucket')).toMatchObject({ status: 'pass', evidence: 'live' });
  });

  it('refuses to finish a diagnostic for objects outside the diagnostics folder', async () => {
    const r = await post('/api/media/diagnostics/finish', { key: 'coastal-media/1/2026/01/real-video.mp4', browserPut: true, browserEtag: true });
    expect(r.status).toBe(400);
  });
});

describe('media library without R2 configured', () => {
  it('says exactly which settings are missing', async () => {
    await freshDb();
    const app = createApp();
    const org = await execute(`INSERT INTO orgs (name) VALUES ('O')`);
    await execute(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?,?,?,?, 'admin')`, [org.insertId, 'a@example.test', 'A', await hashPassword('admin password 1234')]);
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'a@example.test', password: 'admin password 1234' });
    const up = await agent.post('/api/media/uploads').set('Origin', TEST_ORIGIN).set('X-CSRF-Token', r.body.csrfToken).send({ name: 'x.mp4', size: 10, contentType: 'video/mp4' });
    expect(up.status).toBe(503);
    expect(up.body.error.code).toBe('FEATURE_NOT_CONFIGURED');
    expect(up.body.error.hint).toContain('R2_ACCESS_KEY_ID');
    await closePool();
  });
});

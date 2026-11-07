import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { execute, query, queryOne } from '../db/pool.js';
import { hmac, randomToken, safeEqual } from '../lib/crypto.js';
import { AppError, errors } from '../lib/errors.js';
import { asyncHandler, idParam, parse } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { requirePermission } from '../auth/sessions.js';
import { audit } from '../services/audit.js';
import { abortMultipart, completeMultipart, corsReport, createMultipart, deleteObject, headBucket, headObject, listParts, objectKeyFor, planParts, presignGet, presignParts, presignPut, thumbnailKeyFor, } from '../services/storage.js';
/** File types Meta accepts for ad creatives. */
export const ALLOWED_TYPES = {
    'video/mp4': 'video',
    'video/quicktime': 'video',
    'video/x-m4v': 'video',
    'image/jpeg': 'image',
    'image/png': 'image',
};
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
/** R2 aborts unfinished multipart uploads after 7 days; we stop offering resume a day earlier. */
const RESUME_WINDOW_HOURS = 6 * 24;
export const mediaRouter = Router();
async function loadAsset(req, id) {
    const row = await queryOne(`SELECT * FROM media_assets WHERE id=? AND org_id=? AND status <> 'deleted'`, [id, req.user.orgId]);
    if (!row)
        throw errors.notFound('Media file');
    return row;
}
function publicAsset(a, thumbnailUrl = null) {
    return {
        id: a.id,
        kind: a.kind,
        name: a.original_name,
        contentType: a.content_type,
        size: Number(a.size_bytes),
        status: a.status,
        width: a.width,
        height: a.height,
        durationMs: a.duration_ms,
        hasThumbnail: Boolean(a.thumbnail_key),
        thumbnailUrl,
        lastError: a.last_error,
        createdBy: a.creator_name ?? null,
        createdAt: a.created_at,
        completedAt: a.completed_at,
    };
}
function uploadState(a) {
    return { assetId: a.id, partSize: a.part_size, partCount: a.part_count, size: Number(a.size_bytes) };
}
const listSchema = z.object({
    q: z.string().trim().max(100).optional(),
    kind: z.enum(['video', 'image']).optional(),
    status: z.enum(['ready', 'uploading', 'failed', 'all']).default('ready'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(48),
});
mediaRouter.get('/media', requirePermission('media.read'), asyncHandler(async (req, res) => {
    const f = parse(listSchema, req.query);
    const where = ['m.org_id = ?', "m.status <> 'deleted'"];
    const args = [req.user.orgId];
    if (f.status === 'all')
        where.push("m.status <> 'aborted'");
    else {
        where.push('m.status = ?');
        args.push(f.status);
    }
    if (f.kind) {
        where.push('m.kind = ?');
        args.push(f.kind);
    }
    if (f.q) {
        where.push('m.original_name LIKE ?');
        args.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    }
    const w = where.join(' AND ');
    const total = await queryOne(`SELECT COUNT(*) AS n FROM media_assets m WHERE ${w}`, args);
    const rows = await query(`SELECT m.*, u.name AS creator_name FROM media_assets m LEFT JOIN users u ON u.id = m.created_by
        WHERE ${w} ORDER BY m.id DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, args);
    const totals = await query(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM media_assets WHERE org_id=? AND status='ready' GROUP BY kind`, [req.user.orgId]);
    const items = await Promise.all(rows.map(async (a) => publicAsset(a, a.thumbnail_key ? await presignGet(a.thumbnail_key) : null)));
    res.json({
        items,
        total: Number(total?.n ?? 0),
        page: f.page,
        pageSize: f.pageSize,
        library: Object.fromEntries(totals.map((t) => [t.kind, { count: Number(t.n), bytes: Number(t.bytes) }])),
        maxBytes: env().MEDIA_MAX_BYTES,
        allowedTypes: Object.keys(ALLOWED_TYPES),
    });
}));
const initSchema = z.object({
    name: z.string().trim().min(1).max(255),
    size: z.number().int().positive(),
    contentType: z.string().trim().toLowerCase(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
/** Starts an upload, or hands back an unfinished one for the same file so the browser can resume it. */
mediaRouter.post('/media/uploads', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const input = parse(initSchema, req.body);
    const kind = ALLOWED_TYPES[input.contentType];
    if (!kind) {
        throw new AppError({ code: 'MEDIA_TYPE_NOT_ALLOWED', message: `${input.contentType || 'This file type'} is not accepted.`, status: 400, category: 'validation', hint: 'Use MP4 or MOV for video, JPG or PNG for images. These are the formats Meta accepts for ads.' });
    }
    const max = kind === 'image' ? Math.min(IMAGE_MAX_BYTES, env().MEDIA_MAX_BYTES) : env().MEDIA_MAX_BYTES;
    if (input.size > max) {
        throw new AppError({ code: 'MEDIA_TOO_LARGE', message: `The file is ${(input.size / 1024 ** 2).toFixed(0)} MB; the limit for ${kind}s is ${(max / 1024 ** 2).toFixed(0)} MB.`, status: 400, category: 'validation' });
    }
    if (input.fingerprint) {
        const existing = await queryOne(`SELECT * FROM media_assets WHERE org_id=? AND fingerprint=? AND status='uploading' AND size_bytes=?
           AND created_at > (UTC_TIMESTAMP(3) - INTERVAL ${RESUME_WINDOW_HOURS} HOUR) ORDER BY id DESC LIMIT 1`, [req.user.orgId, input.fingerprint, input.size]);
        if (existing?.upload_id) {
            try {
                const parts = await listParts(existing.object_key, existing.upload_id);
                return res.json({ ...uploadState(existing), resumed: true, uploadedParts: parts.map((p) => p.partNumber) });
            }
            catch (err) {
                if (err?.code !== 'R2_UPLOAD_GONE')
                    throw err;
                await execute(`UPDATE media_assets SET status='failed', last_error='Upload expired in R2; started again.' WHERE id=?`, [existing.id]);
            }
        }
    }
    const { partSize, partCount } = planParts(input.size);
    const key = objectKeyFor(req.user.orgId, input.name);
    const uploadId = await createMultipart(key, input.contentType);
    const r = await execute(`INSERT INTO media_assets (org_id, kind, original_name, content_type, size_bytes, object_key, status, upload_id, part_size, part_count, fingerprint, created_by)
       VALUES (?,?,?,?,?,?,'uploading',?,?,?,?,?)`, [req.user.orgId, kind, input.name, input.contentType, input.size, key, uploadId, partSize, partCount, input.fingerprint ?? null, req.user.id]);
    res.status(201).json({ assetId: r.insertId, partSize, partCount, size: input.size, resumed: false, uploadedParts: [] });
}));
async function loadUploading(req) {
    const a = await loadAsset(req, parse(idParam, req.params.id));
    if (a.status !== 'uploading' || !a.upload_id) {
        throw new AppError({ code: 'MEDIA_NOT_UPLOADING', message: `This file is ${a.status}, not uploading.`, status: 409, category: 'conflict', details: { status: a.status } });
    }
    return a;
}
mediaRouter.post('/media/uploads/:id/part-urls', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const a = await loadUploading(req);
    const { parts } = parse(z.object({ parts: z.array(z.number().int().min(1)).min(1).max(100) }), req.body);
    if (parts.some((n) => n > a.part_count))
        throw errors.validation(`Part numbers must be between 1 and ${a.part_count}.`);
    res.json({ urls: await presignParts(a.object_key, a.upload_id, [...new Set(parts)]) });
}));
mediaRouter.get('/media/uploads/:id/parts', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const a = await loadUploading(req);
    const parts = await listParts(a.object_key, a.upload_id);
    res.json({ ...uploadState(a), uploadedParts: parts.map((p) => p.partNumber), uploadedBytes: parts.reduce((s, p) => s + p.size, 0) });
}));
/**
 * Finishes an upload. The server lists the parts itself (it does not trust ETags sent by the browser), checks
 * every part is there with the right sizes, completes the upload, then confirms the object size in the bucket.
 * Only then is the file marked ready.
 */
mediaRouter.post('/media/uploads/:id/complete', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const a = await loadAsset(req, id);
    if (a.status === 'ready')
        return res.json(publicAsset(a));
    if (a.status !== 'uploading' || !a.upload_id)
        throw new AppError({ code: 'MEDIA_NOT_UPLOADING', message: `This file is ${a.status}.`, status: 409, category: 'conflict' });
    const size = Number(a.size_bytes);
    let parts;
    try {
        parts = await listParts(a.object_key, a.upload_id);
    }
    catch (err) {
        // A previous complete call may have succeeded and its response been lost. Check the bucket before failing.
        if (err?.code === 'R2_UPLOAD_GONE') {
            const head = await headObject(a.object_key);
            if (head && head.size === size) {
                await execute(`UPDATE media_assets SET status='ready', upload_id=NULL, completed_at=UTC_TIMESTAMP(3), last_error=NULL WHERE id=?`, [id]);
                return res.json(publicAsset({ ...a, status: 'ready' }));
            }
            await execute(`UPDATE media_assets SET status='failed', last_error=? WHERE id=?`, ['R2 no longer has this upload. Upload the file again.', id]);
        }
        throw err;
    }
    const missing = [];
    const wrongSize = [];
    const byNumber = new Map(parts.map((p) => [p.partNumber, p]));
    for (let n = 1; n <= a.part_count; n++) {
        const p = byNumber.get(n);
        const expected = n < a.part_count ? a.part_size : size - a.part_size * (a.part_count - 1);
        if (!p)
            missing.push(n);
        else if (p.size !== expected)
            wrongSize.push(n);
    }
    if (missing.length || wrongSize.length) {
        throw new AppError({
            code: 'MEDIA_PARTS_INCOMPLETE',
            message: missing.length ? `${missing.length} of ${a.part_count} parts have not reached R2 yet.` : `${wrongSize.length} parts have the wrong size.`,
            status: 409,
            category: 'conflict',
            retryable: true,
            details: { missing: missing.slice(0, 50), wrongSize: wrongSize.slice(0, 50) },
            hint: 'Resume the upload; only the listed parts are sent again.',
        });
    }
    await completeMultipart(a.object_key, a.upload_id, parts);
    const head = await headObject(a.object_key);
    if (!head || head.size !== size) {
        await execute(`UPDATE media_assets SET status='failed', last_error=? WHERE id=?`, [`Size check failed after upload: expected ${size} bytes, bucket has ${head?.size ?? 'nothing'}.`, id]);
        throw new AppError({ code: 'MEDIA_SIZE_MISMATCH', message: 'The file in R2 does not match the original size.', status: 502, category: 'external_storage', hint: 'Upload the file again.' });
    }
    await execute(`UPDATE media_assets SET status='ready', upload_id=NULL, completed_at=UTC_TIMESTAMP(3), last_error=NULL WHERE id=?`, [id]);
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'media.uploaded', targetType: 'media', targetId: id, details: { name: a.original_name, size, kind: a.kind }, ip: req.ip, correlationId: req.correlationId });
    res.json(publicAsset({ ...a, status: 'ready' }));
}));
mediaRouter.post('/media/uploads/:id/abort', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const a = await loadUploading(req);
    await abortMultipart(a.object_key, a.upload_id);
    await execute(`UPDATE media_assets SET status='aborted', upload_id=NULL WHERE id=?`, [a.id]);
    res.json({ ok: true });
}));
/** Presigned PUT for a small JPEG thumbnail the browser renders from the video's first frames. */
mediaRouter.post('/media/:id/thumbnail-url', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const a = await loadAsset(req, parse(idParam, req.params.id));
    if (a.status !== 'ready')
        throw new AppError({ code: 'MEDIA_NOT_READY', message: 'Finish the upload first.', status: 409, category: 'conflict' });
    const key = thumbnailKeyFor(a.org_id, a.id);
    res.json({ url: await presignPut(key, 'image/jpeg'), token: signThumb({ key, assetId: a.id, expires: Date.now() + 15 * 60_000 }) });
}));
function signThumb(c) {
    const body = Buffer.from(JSON.stringify(c)).toString('base64url');
    return `${body}.${hmac(env().SESSION_SECRET, `thumb:${body}`)}`;
}
function verifyThumb(token) {
    const [body, sig] = token.split('.');
    if (!body || !sig || !safeEqual(sig, hmac(env().SESSION_SECRET, `thumb:${body}`)))
        return null;
    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString());
    }
    catch {
        return null;
    }
}
const patchSchema = z.object({
    name: z.string().trim().min(1).max(255).optional(),
    width: z.number().int().positive().max(20000).optional(),
    height: z.number().int().positive().max(20000).optional(),
    durationMs: z.number().int().nonnegative().max(24 * 3600 * 1000).optional(),
    thumbnailToken: z.string().max(2048).optional(),
});
mediaRouter.patch('/media/:id', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const a = await loadAsset(req, parse(idParam, req.params.id));
    const input = parse(patchSchema, req.body);
    const sets = [];
    const args = [];
    if (input.name)
        sets.push('original_name=?'), args.push(input.name);
    if (input.width)
        sets.push('width=?'), args.push(input.width);
    if (input.height)
        sets.push('height=?'), args.push(input.height);
    if (input.durationMs != null)
        sets.push('duration_ms=?'), args.push(input.durationMs);
    let oldThumb = null;
    if (input.thumbnailToken) {
        const t = verifyThumb(input.thumbnailToken);
        if (!t || t.assetId !== a.id || t.expires < Date.now())
            throw errors.validation('Thumbnail link expired. Try again.');
        const head = await headObject(t.key);
        if (!head)
            throw new AppError({ code: 'MEDIA_THUMBNAIL_MISSING', message: 'The thumbnail did not reach R2.', status: 409, category: 'conflict', retryable: true });
        if (head.size > 2 * 1024 * 1024) {
            await deleteObject(t.key);
            throw errors.validation('Thumbnail is larger than 2 MB.');
        }
        oldThumb = a.thumbnail_key;
        sets.push('thumbnail_key=?'), args.push(t.key);
    }
    if (sets.length)
        await execute(`UPDATE media_assets SET ${sets.join(', ')} WHERE id=?`, [...args, a.id]);
    if (oldThumb)
        await deleteObject(oldThumb).catch((err) => logger.warn({ err }, 'old thumbnail delete failed'));
    const fresh = await loadAsset(req, a.id);
    res.json(publicAsset(fresh, fresh.thumbnail_key ? await presignGet(fresh.thumbnail_key) : null));
}));
mediaRouter.get('/media/:id/url', requirePermission('media.read'), asyncHandler(async (req, res) => {
    const a = await loadAsset(req, parse(idParam, req.params.id));
    if (a.status !== 'ready')
        throw new AppError({ code: 'MEDIA_NOT_READY', message: 'This file has not finished uploading.', status: 409, category: 'conflict' });
    const download = req.query.download === '1';
    res.json({ url: await presignGet(a.object_key, { downloadName: download ? a.original_name : undefined }), expiresInSeconds: 3600 });
}));
/** Removes the file from R2 and the library. Copies already uploaded to Meta are not affected. */
mediaRouter.delete('/media/:id', requirePermission('media.delete'), asyncHandler(async (req, res) => {
    const a = await loadAsset(req, parse(idParam, req.params.id));
    if (a.status === 'uploading' && a.upload_id)
        await abortMultipart(a.object_key, a.upload_id);
    else
        await deleteObject(a.object_key);
    if (a.thumbnail_key)
        await deleteObject(a.thumbnail_key);
    await execute(`UPDATE media_assets SET status='deleted', upload_id=NULL, deleted_at=UTC_TIMESTAMP(3) WHERE id=?`, [a.id]);
    await audit({ orgId: req.user.orgId, actorUserId: req.user.id, action: 'media.deleted', targetType: 'media', targetId: a.id, details: { name: a.original_name }, ip: req.ip, correlationId: req.correlationId });
    res.json({ ok: true });
}));
/**
 * Step 1 (server): bucket reachable with these credentials, CORS policy readable and sensible.
 * Returns a presigned PUT for a tiny test object so the browser can prove CORS for real (step 2).
 */
mediaRouter.post('/media/diagnostics', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const out = { at: new Date().toISOString(), bucketOk: false, cors: null, browserPut: null, browserEtag: null, serverSawObject: null };
    try {
        await headBucket();
        out.bucketOk = true;
        out.cors = await corsReport();
    }
    catch (err) {
        out.error = { code: err?.code ?? 'R2_ERROR', message: err?.message ?? String(err), hint: err?.hint };
        await saveDiagnostic(out, req.user.id);
        return res.json({ ...out, test: null });
    }
    const key = `${env().R2_PREFIX}_diagnostics/${randomToken(8)}.txt`;
    res.json({ ...out, test: { key, url: await presignPut(key, 'text/plain', 300) } });
}));
/** Step 3 (server): the browser reports what it saw; the server confirms the object landed, then deletes it. */
mediaRouter.post('/media/diagnostics/finish', requirePermission('media.upload'), asyncHandler(async (req, res) => {
    const input = parse(z.object({ key: z.string().max(512), browserPut: z.boolean(), browserEtag: z.boolean(), browserError: z.string().max(500).optional(), cors: z.any().optional() }), req.body);
    if (!input.key.startsWith(`${env().R2_PREFIX}_diagnostics/`))
        throw errors.validation('Not a diagnostic object.');
    const head = await headObject(input.key);
    if (head)
        await deleteObject(input.key);
    const out = {
        at: new Date().toISOString(),
        bucketOk: true,
        cors: input.cors ?? null,
        browserPut: input.browserPut,
        browserEtag: input.browserEtag,
        serverSawObject: Boolean(head),
    };
    if (!input.browserPut)
        out.error = { code: 'R2_CORS_BLOCKED', message: input.browserError ?? 'The browser could not upload to R2.', hint: 'Add the CORS policy from docs/R2_SETUP.md to the bucket, with this panel’s address as an allowed origin.' };
    else if (!input.browserEtag)
        out.error = { code: 'R2_ETAG_NOT_EXPOSED', message: 'Uploads work, but the bucket hides the ETag header from the browser.', hint: 'Add "ExposeHeaders": ["ETag"] to the bucket CORS policy.' };
    await saveDiagnostic(out, req.user.id);
    res.json(out);
}));
async function saveDiagnostic(d, userId) {
    await execute(`INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES ('storage.diagnostic', ?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_by=VALUES(updated_by)`, [JSON.stringify(d), userId]);
}
export async function lastDiagnostic() {
    const r = await queryOne(`SELECT setting_value FROM system_settings WHERE setting_key='storage.diagnostic'`);
    if (!r)
        return null;
    return (typeof r.setting_value === 'string' ? JSON.parse(r.setting_value) : r.setting_value);
}
mediaRouter.get('/media/diagnostics', requirePermission('media.read'), asyncHandler(async (_req, res) => {
    res.json({ last: await lastDiagnostic() });
}));
//# sourceMappingURL=media.js.map
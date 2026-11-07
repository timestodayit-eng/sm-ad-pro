import { randomUUID } from 'node:crypto';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetBucketCorsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand, } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, features, r2Endpoint } from '../config/env.js';
import { AppError, errors } from '../lib/errors.js';
/**
 * Cloudflare R2 through its S3-compatible API. Media bytes never pass through Node: the browser uploads parts
 * straight to presigned URLs, and the server only creates, lists, completes and verifies uploads.
 */
const MiB = 1024 * 1024;
export const MIN_PART_SIZE = 8 * MiB;
const MAX_PARTS = 10_000;
export const PRESIGN_SECONDS = 3600;
let client = null;
let clientKey = '';
export function storage() {
    const e = env();
    if (!features(e).r2)
        throw errors.notConfigured('Cloudflare R2 storage', ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
    const key = `${r2Endpoint(e)}|${e.R2_ACCESS_KEY_ID}`;
    if (!client || key !== clientKey) {
        client = new S3Client({
            region: 'auto',
            endpoint: r2Endpoint(e),
            forcePathStyle: true,
            credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
            // Newer SDKs add CRC32 checksums to every request by default. R2 and browser presigned PUTs do not
            // carry them, so only send checksums when an operation strictly requires one.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            maxAttempts: 3,
            requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
        });
        clientKey = key;
    }
    return client;
}
export const bucket = () => env().R2_BUCKET;
/** Turns S3/R2 errors into AppErrors that say what failed and what to do. */
export function storageError(err, operation) {
    if (err instanceof AppError)
        return err;
    const e = err;
    const name = e?.name ?? 'Error';
    const status = e?.$metadata?.httpStatusCode;
    const base = { category: 'external_storage', operation, details: { s3Error: name, httpStatus: status } };
    if (name === 'NoSuchBucket')
        return new AppError({ ...base, code: 'R2_BUCKET_NOT_FOUND', message: `Bucket "${bucket()}" does not exist for this account.`, status: 502, hint: 'Check R2_BUCKET and R2_ACCOUNT_ID.' });
    if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || status === 401)
        return new AppError({ ...base, code: 'R2_CREDENTIALS_INVALID', message: 'R2 rejected the access key or secret.', status: 502, hint: 'Create a new R2 API token with Object Read & Write on the bucket and update R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.' });
    if (name === 'AccessDenied' || status === 403)
        return new AppError({ ...base, code: 'R2_ACCESS_DENIED', message: 'The R2 token is not allowed to do this.', status: 502, hint: 'The token needs Object Read & Write permission on this bucket.' });
    if (name === 'NoSuchUpload')
        return new AppError({ ...base, code: 'R2_UPLOAD_GONE', message: 'R2 no longer has this upload (finished, aborted or expired).', status: 409 });
    if (name === 'NotFound' || name === 'NoSuchKey' || status === 404)
        return new AppError({ ...base, code: 'R2_OBJECT_NOT_FOUND', message: 'The file is not in the bucket.', status: 404 });
    const network = !status;
    return new AppError({
        ...base,
        code: network ? 'R2_UNREACHABLE' : 'R2_ERROR',
        message: network ? `Could not reach R2 (${e?.message ?? name}).` : `R2 returned ${status} ${name}.`,
        status: 502,
        retryable: true,
        hint: network ? 'Check R2_ACCOUNT_ID / R2_ENDPOINT and the server network, then retry.' : 'Retry. If it keeps failing, check System Health.',
    });
}
/** Part size: at least 8 MiB and never more than 10,000 parts. */
export function planParts(size) {
    const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
    return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}
export function safeFileName(name) {
    const base = name.normalize('NFKD').replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '');
    return (base || 'file').slice(-120);
}
export function objectKeyFor(orgId, name, now = new Date()) {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${env().R2_PREFIX}${orgId}/${y}/${m}/${randomUUID()}-${safeFileName(name)}`;
}
export function thumbnailKeyFor(orgId, assetId) {
    return `${env().R2_PREFIX}${orgId}/thumbs/${assetId}-${randomUUID().slice(0, 8)}.jpg`;
}
export async function createMultipart(key, contentType) {
    try {
        const r = await storage().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }));
        if (!r.UploadId)
            throw new Error('R2 returned no UploadId');
        return r.UploadId;
    }
    catch (err) {
        throw storageError(err, 'create_multipart');
    }
}
export async function presignParts(key, uploadId, partNumbers) {
    const s = storage();
    return Promise.all(partNumbers.map(async (n) => ({
        partNumber: n,
        url: await getSignedUrl(s, new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: PRESIGN_SECONDS }),
    })));
}
export async function listParts(key, uploadId) {
    const out = [];
    let marker;
    try {
        for (;;) {
            const r = await storage().send(new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }));
            for (const p of r.Parts ?? [])
                out.push({ partNumber: p.PartNumber, etag: p.ETag, size: Number(p.Size ?? 0) });
            if (!r.IsTruncated)
                break;
            marker = r.NextPartNumberMarker;
        }
    }
    catch (err) {
        throw storageError(err, 'list_parts');
    }
    return out.sort((a, b) => a.partNumber - b.partNumber);
}
export async function completeMultipart(key, uploadId, parts) {
    try {
        await storage().send(new CompleteMultipartUploadCommand({
            Bucket: bucket(),
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }));
    }
    catch (err) {
        throw storageError(err, 'complete_multipart');
    }
}
export async function abortMultipart(key, uploadId) {
    try {
        await storage().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
    }
    catch (err) {
        const e = storageError(err, 'abort_multipart');
        if (e.code !== 'R2_UPLOAD_GONE')
            throw e;
    }
}
/** Size of an object, or null when it does not exist. */
export async function headObject(key) {
    try {
        const r = await storage().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
        return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    }
    catch (err) {
        const e = storageError(err, 'head_object');
        if (e.code === 'R2_OBJECT_NOT_FOUND')
            return null;
        throw e;
    }
}
export async function deleteObject(key) {
    try {
        await storage().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    }
    catch (err) {
        const e = storageError(err, 'delete_object');
        if (e.code !== 'R2_OBJECT_NOT_FOUND')
            throw e;
    }
}
export async function presignGet(key, opts = {}) {
    return getSignedUrl(storage(), new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ResponseContentDisposition: opts.downloadName ? `attachment; filename="${safeFileName(opts.downloadName)}"` : undefined,
    }), { expiresIn: opts.expiresIn ?? PRESIGN_SECONDS });
}
export async function presignPut(key, contentType, expiresIn = 900) {
    return getSignedUrl(storage(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn, signableHeaders: new Set(['content-type']) });
}
export async function headBucket() {
    try {
        await storage().send(new HeadBucketCommand({ Bucket: bucket() }));
    }
    catch (err) {
        throw storageError(err, 'head_bucket');
    }
}
/** Reads the bucket CORS policy and checks it allows browser uploads from APP_ORIGIN. */
export async function corsReport() {
    const origin = env().APP_ORIGIN;
    try {
        const r = await storage().send(new GetBucketCorsCommand({ Bucket: bucket() }));
        const rules = r.CORSRules ?? [];
        const match = rules.filter((x) => (x.AllowedOrigins ?? []).some((o) => o === '*' || o === origin));
        const putAllowed = match.some((x) => (x.AllowedMethods ?? []).includes('PUT'));
        const etagExposed = match.some((x) => (x.ExposeHeaders ?? []).some((h) => h.toLowerCase() === 'etag'));
        return { readable: true, originAllowed: match.length > 0, putAllowed, etagExposed, rules };
    }
    catch (err) {
        const e = err;
        if (e?.name === 'NoSuchCORSConfiguration')
            return { readable: true, originAllowed: false, putAllowed: false, etagExposed: false, rules: [], problem: 'The bucket has no CORS policy.' };
        // Object-scoped tokens cannot read bucket settings. The browser test below is the real proof either way.
        return { readable: false, originAllowed: false, putAllowed: false, etagExposed: false, rules: [], problem: `Could not read the CORS policy (${e?.name ?? 'error'}). The browser test still checks it for real.` };
    }
}
//# sourceMappingURL=storage.js.map
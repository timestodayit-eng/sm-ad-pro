import { ApiError, get, patch, post } from './api';

/**
 * Browser-side upload engine. Files go straight to R2 in parts through presigned URLs; Node never sees the bytes.
 *  - 4 parts in flight per file, each retried up to 6 times with backoff (expired links are re-signed).
 *  - Pause stops in-flight parts; resume asks the server which parts R2 already has and sends only the rest.
 *  - Picking the same file again after a reload or crash resumes it (matched by a fingerprint of name, size, date).
 *  - The server, not the browser, decides when a file is complete: it lists the parts and checks the size.
 */

export type UploadStatus = 'preparing' | 'uploading' | 'paused' | 'finishing' | 'thumbnail' | 'done' | 'failed' | 'cancelled';

export interface UploadItem {
  key: string;
  file: File;
  name: string;
  size: number;
  status: UploadStatus;
  assetId?: number;
  uploadedBytes: number;
  resumedBytes: number;
  speedBps: number;
  error?: { code: string; message: string; hint?: string };
  startedAt: number;
}

interface Internal {
  item: UploadItem;
  partSize: number;
  partCount: number;
  done: Set<number>;
  inflight: Map<number, XMLHttpRequest>;
  inflightBytes: Map<number, number>;
  urls: Map<number, { url: string; at: number }>;
  samples: { t: number; b: number }[];
  runId: number;
}

const CONCURRENCY = 4;
const MAX_PART_ATTEMPTS = 6;
const URL_TTL_MS = 50 * 60_000; // links are valid for 60 min; refresh before that

const items = new Map<string, Internal>();
const listeners = new Set<() => void>();
let snapshot: UploadItem[] = [];
let onFinished: ((assetId: number) => void) | null = null;

function emit() {
  snapshot = [...items.values()].map((i) => ({ ...i.item }));
  listeners.forEach((l) => l());
}
export const uploads = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot: () => snapshot,
  onFinished(fn: (assetId: number) => void) {
    onFinished = fn;
  },
  active: () => [...items.values()].some((i) => ['preparing', 'uploading', 'finishing', 'thumbnail'].includes(i.item.status)),
};

async function fingerprint(f: File): Promise<string> {
  const data = new TextEncoder().encode(`${f.name}|${f.size}|${f.lastModified}|${f.type}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toErr(e: unknown): UploadItem['error'] {
  if (e instanceof ApiError) return { code: e.body.code, message: e.body.message, hint: e.body.hint };
  return { code: 'UPLOAD_ERROR', message: (e as Error)?.message ?? String(e) };
}

export function contentTypeFor(f: File): string {
  if (f.type) return f.type === 'video/mov' ? 'video/quicktime' : f.type;
  const ext = f.name.split('.').pop()?.toLowerCase();
  return ({ mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}

export function addFiles(files: File[]) {
  for (const file of files) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    const existing = items.get(key);
    if (existing && !['failed', 'cancelled', 'done'].includes(existing.item.status)) continue;
    const it: Internal = {
      item: { key, file, name: file.name, size: file.size, status: 'preparing', uploadedBytes: 0, resumedBytes: 0, speedBps: 0, startedAt: Date.now() },
      partSize: 0,
      partCount: 0,
      done: new Set(),
      inflight: new Map(),
      inflightBytes: new Map(),
      urls: new Map(),
      samples: [],
      runId: 0,
    };
    items.set(key, it);
    void start(it);
  }
  emit();
}

async function start(it: Internal) {
  const run = ++it.runId;
  it.item.error = undefined;
  it.item.status = 'preparing';
  emit();
  try {
    const f = it.item.file;
    const init = await post<{ assetId: number; partSize: number; partCount: number; resumed: boolean; uploadedParts: number[] }>('/media/uploads', {
      name: f.name,
      size: f.size,
      contentType: contentTypeFor(f),
      fingerprint: await fingerprint(f),
    });
    if (run !== it.runId) return;
    it.item.assetId = init.assetId;
    it.partSize = init.partSize;
    it.partCount = init.partCount;
    it.done = new Set(init.uploadedParts);
    it.item.resumedBytes = [...it.done].reduce((s, n) => s + partLength(it, n), 0);
    await pump(it, run);
  } catch (e) {
    if (run === it.runId) fail(it, e);
  }
}

function partLength(it: Internal, n: number) {
  return n < it.partCount ? it.partSize : it.item.size - it.partSize * (it.partCount - 1);
}

function recompute(it: Internal) {
  let b = 0;
  for (const n of it.done) b += partLength(it, n);
  for (const v of it.inflightBytes.values()) b += v;
  it.item.uploadedBytes = b;
  const now = Date.now();
  it.samples.push({ t: now, b });
  while (it.samples.length > 2 && now - it.samples[0].t > 5000) it.samples.shift();
  const first = it.samples[0];
  it.item.speedBps = now > first.t ? ((b - first.b) * 1000) / (now - first.t) : 0;
}

async function urlsFor(it: Internal, parts: number[]) {
  const need = parts.filter((n) => {
    const u = it.urls.get(n);
    return !u || Date.now() - u.at > URL_TTL_MS;
  });
  if (need.length) {
    const r = await post<{ urls: { partNumber: number; url: string }[] }>(`/media/uploads/${it.item.assetId}/part-urls`, { parts: need });
    for (const u of r.urls) it.urls.set(u.partNumber, { url: u.url, at: Date.now() });
  }
}

async function pump(it: Internal, run: number) {
  it.item.status = 'uploading';
  emit();
  const queue = Array.from({ length: it.partCount }, (_, i) => i + 1).filter((n) => !it.done.has(n));
  let failure: unknown = null;

  const worker = async () => {
    while (queue.length && !failure && run === it.runId) {
      const n = queue.shift()!;
      try {
        await sendPart(it, n, run);
      } catch (e) {
        if (run === it.runId) failure = e;
      }
    }
  };
  // Sign links in batches ahead of the workers.
  try {
    await urlsFor(it, queue.slice(0, 40));
  } catch (e) {
    return fail(it, e);
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
  if (run !== it.runId) return; // paused or cancelled meanwhile
  if (failure) return fail(it, failure);
  await finish(it, run);
}

function putOnce(it: Internal, n: number, url: string): Promise<number> {
  const start = (n - 1) * it.partSize;
  const blob = it.item.file.slice(start, start + partLength(it, n));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    it.inflight.set(n, xhr);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      it.inflightBytes.set(n, e.loaded);
      recompute(it);
      emit();
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(Object.assign(new Error('Network error while sending to R2'), { network: true }));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    xhr.send(blob);
  }).finally(() => {
    it.inflight.delete(n);
    it.inflightBytes.delete(n);
  }) as Promise<number>;
}

async function sendPart(it: Internal, n: number, run: number) {
  for (let attempt = 1; ; attempt++) {
    if (run !== it.runId) return;
    await urlsFor(it, [n]);
    let status: number;
    try {
      status = await putOnce(it, n, it.urls.get(n)!.url);
    } catch (e: any) {
      if (e?.aborted) return;
      if (attempt >= MAX_PART_ATTEMPTS) {
        throw Object.assign(new Error(`Part ${n} could not reach R2 after ${attempt} tries. If every part fails at once, the bucket CORS policy is probably missing; run "Check storage connection".`), {});
      }
      await sleep(backoff(attempt));
      continue;
    }
    if (status >= 200 && status < 300) {
      it.done.add(n);
      recompute(it);
      emit();
      return;
    }
    if (status === 403) it.urls.delete(n); // expired or clock skew: re-sign
    if (attempt >= MAX_PART_ATTEMPTS) throw new Error(`R2 refused part ${n} (HTTP ${status}) after ${attempt} tries.`);
    await sleep(backoff(attempt));
  }
}

const backoff = (a: number) => Math.min(30_000, 1000 * 2 ** (a - 1)) * (0.75 + Math.random() * 0.5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function finish(it: Internal, run: number) {
  it.item.status = 'finishing';
  emit();
  try {
    await post(`/media/uploads/${it.item.assetId}/complete`);
  } catch (e) {
    // The server lists what R2 really has; if it says parts are missing, send just those.
    if (e instanceof ApiError && e.body.code === 'MEDIA_PARTS_INCOMPLETE' && run === it.runId) {
      const missing = (e.body.details?.missing as number[] | undefined) ?? [];
      missing.forEach((n) => it.done.delete(n));
      if (missing.length) return pump(it, run);
    }
    return fail(it, e);
  }
  if (run !== it.runId) return;
  it.item.status = 'thumbnail';
  emit();
  await makeThumbnail(it).catch(() => undefined); // a missing thumbnail never fails the upload
  it.item.status = 'done';
  it.item.uploadedBytes = it.item.size;
  emit();
  onFinished?.(it.item.assetId!);
}

function fail(it: Internal, e: unknown) {
  for (const x of it.inflight.values()) x.abort();
  it.item.status = 'failed';
  it.item.error = toErr(e);
  emit();
}

export function pause(key: string) {
  const it = items.get(key);
  if (!it || it.item.status !== 'uploading') return;
  it.runId++;
  for (const x of it.inflight.values()) x.abort();
  it.item.status = 'paused';
  recompute(it);
  emit();
}

/** Resume or retry: ask R2 (through the server) which parts arrived, then send the rest. */
export async function resume(key: string) {
  const it = items.get(key);
  if (!it || !['paused', 'failed'].includes(it.item.status)) return;
  if (!it.item.assetId) return void start(it);
  const run = ++it.runId;
  it.item.error = undefined;
  it.item.status = 'preparing';
  emit();
  try {
    const s = await get<{ uploadedParts: number[] }>(`/media/uploads/${it.item.assetId}/parts`);
    it.done = new Set(s.uploadedParts);
    recompute(it);
    await pump(it, run);
  } catch (e) {
    if (e instanceof ApiError && e.body.code === 'MEDIA_NOT_UPLOADING') {
      // Already completed (lost response) or aborted: completing is idempotent, otherwise start fresh.
      try {
        await post(`/media/uploads/${it.item.assetId}/complete`);
        it.item.status = 'done';
        emit();
        onFinished?.(it.item.assetId);
        return;
      } catch {
        it.item.assetId = undefined;
        return void start(it);
      }
    }
    if (run === it.runId) fail(it, e);
  }
}

export async function cancel(key: string) {
  const it = items.get(key);
  if (!it) return;
  it.runId++;
  for (const x of it.inflight.values()) x.abort();
  const wasActive = it.item.status !== 'done';
  it.item.status = 'cancelled';
  emit();
  if (wasActive && it.item.assetId) await post(`/media/uploads/${it.item.assetId}/abort`).catch(() => undefined);
}

export function dismiss(key: string) {
  const it = items.get(key);
  if (it && ['done', 'cancelled', 'failed'].includes(it.item.status)) {
    items.delete(key);
    emit();
  }
}

export function clearFinished() {
  for (const [k, it] of items) if (it.item.status === 'done' || it.item.status === 'cancelled') items.delete(k);
  emit();
}

/* ---------- thumbnails (rendered in the browser, uploaded as a small JPEG) ---------- */

async function makeThumbnail(it: Internal) {
  const f = it.item.file;
  const src = URL.createObjectURL(f);
  try {
    let source: CanvasImageSource;
    let width: number;
    let height: number;
    let durationMs: number | undefined;
    if (f.type.startsWith('image/')) {
      const img = new Image();
      img.src = src;
      await img.decode();
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
    } else {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.src = src;
      await once(v, 'loadedmetadata', 15_000);
      width = v.videoWidth;
      height = v.videoHeight;
      durationMs = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined;
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
      await once(v, 'seeked', 15_000);
      source = v;
    }
    const scale = Math.min(1, 480 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    const meta = { width: width || undefined, height: height || undefined, durationMs };
    if (!blob) return void (await patch(`/media/${it.item.assetId}`, meta));
    const t = await post<{ url: string; token: string }>(`/media/${it.item.assetId}/thumbnail-url`);
    const res = await fetch(t.url, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
    await patch(`/media/${it.item.assetId}`, res.ok ? { ...meta, thumbnailToken: t.token } : meta);
  } finally {
    URL.revokeObjectURL(src);
  }
}

function once(el: HTMLElement, ev: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${ev} timeout`)), timeoutMs);
    el.addEventListener(ev, () => (clearTimeout(t), resolve()), { once: true });
    el.addEventListener('error', () => (clearTimeout(t), reject(new Error('cannot decode'))), { once: true });
  });
}

/* ---------- storage diagnostic ---------- */

export interface DiagnosticResult {
  at: string;
  bucketOk: boolean;
  cors: { readable: boolean; originAllowed: boolean; putAllowed: boolean; etagExposed: boolean; problem?: string } | null;
  browserPut: boolean | null;
  browserEtag: boolean | null;
  serverSawObject: boolean | null;
  error?: { code: string; message: string; hint?: string };
}

/** Server checks the bucket and CORS policy, the browser uploads a tiny file for real, the server confirms it. */
export async function runDiagnostic(): Promise<DiagnosticResult> {
  const step1 = await post<DiagnosticResult & { test: { key: string; url: string } | null }>('/media/diagnostics');
  if (!step1.test) return step1;
  let browserPut = false;
  let browserEtag = false;
  let browserError: string | undefined;
  try {
    const r = await fetch(step1.test.url, { method: 'PUT', body: `diagnostic ${new Date().toISOString()}`, headers: { 'Content-Type': 'text/plain' } });
    browserPut = r.ok;
    browserEtag = Boolean(r.headers.get('etag'));
    if (!r.ok) browserError = `R2 answered HTTP ${r.status} to the test upload.`;
  } catch {
    browserError = 'The browser blocked the upload to R2. This is what a missing or wrong bucket CORS policy looks like.';
  }
  return post<DiagnosticResult>('/media/diagnostics/finish', { key: step1.test.key, browserPut, browserEtag, browserError, cors: step1.cors });
}

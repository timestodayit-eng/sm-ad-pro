import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger, sanitizeUrl } from '../lib/logger.js';

/**
 * The only module that talks to the Graph / Marketing API. Pinned API version from META_API_VERSION.
 * Classifies every failure so callers know whether a retry is safe (bugs 8, 9, 12, 20).
 */

export type MetaErrorClass = 'rate_limited' | 'transient' | 'auth' | 'permission' | 'validation' | 'ambiguous' | 'unknown';

export interface MetaErrorInfo {
  class: MetaErrorClass;
  httpStatus?: number;
  code?: number;
  subcode?: number;
  type?: string;
  message: string;
  userTitle?: string;
  userMessage?: string;
  fbtraceId?: string;
  isTransient?: boolean;
}

export class MetaApiError extends AppError {
  readonly meta: MetaErrorInfo;
  constructor(info: MetaErrorInfo, operation: string) {
    const retryable = info.class === 'rate_limited' || info.class === 'transient';
    super({
      code: info.code != null ? `META_${info.code}${info.subcode ? `_${info.subcode}` : ''}` : `META_${info.class.toUpperCase()}`,
      message: info.userMessage || info.message,
      status: 502,
      category: info.class === 'rate_limited' ? 'rate_limited' : 'external_meta',
      operation,
      retryable,
      hint: hintFor(info),
      details: { code: info.code, subcode: info.subcode, type: info.type, fbtraceId: info.fbtraceId, class: info.class, title: info.userTitle },
    });
    this.meta = info;
  }
}

function hintFor(i: MetaErrorInfo): string {
  switch (i.class) {
    case 'rate_limited':
      return 'Meta is rate-limiting this app or ad account. The job will retry automatically with backoff.';
    case 'auth':
      return 'The Meta connection token is invalid or expired. Reconnect Meta from Ad Accounts.';
    case 'permission':
      return 'The connected Meta user lacks a permission or role for this object. Check Business Manager roles and app permissions.';
    case 'ambiguous':
      return 'The request may or may not have reached Meta. The system will look up the object before trying again.';
    case 'validation':
      return 'Meta rejected the request. Correct the setting named in the message and retry this stage.';
    default:
      return 'Retry later. If it keeps failing, share the correlation ID with support.';
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const TRANSIENT_CODES = new Set([1, 2]);
const AUTH_CODES = new Set([102, 190, 463, 467]);
const PERMISSION_CODES = new Set([10, 200, 294, 299]);

export function classifyMetaError(httpStatus: number, body: any): MetaErrorInfo {
  const e = body?.error ?? {};
  const code = typeof e.code === 'number' ? e.code : undefined;
  const subcode = typeof e.error_subcode === 'number' ? e.error_subcode : undefined;
  let cls: MetaErrorClass = 'unknown';
  if (code != null && RATE_LIMIT_CODES.has(code)) cls = 'rate_limited';
  else if (e.is_transient === true || (code != null && TRANSIENT_CODES.has(code))) cls = 'transient';
  else if (code != null && AUTH_CODES.has(code)) cls = 'auth';
  else if ((code != null && PERMISSION_CODES.has(code)) || (code != null && code >= 200 && code < 300)) cls = 'permission';
  else if (code === 100 || httpStatus === 400) cls = 'validation';
  else if (httpStatus >= 500) cls = 'transient';
  return {
    class: cls,
    httpStatus,
    code,
    subcode,
    type: e.type,
    message: String(e.message ?? `HTTP ${httpStatus}`).slice(0, 1000),
    userTitle: e.error_user_title,
    userMessage: e.error_user_msg,
    fbtraceId: e.fbtrace_id,
    isTransient: e.is_transient,
  };
}

export interface UsageHeaders {
  app?: unknown;
  business?: unknown;
  adAccount?: unknown;
}

export interface GraphResponse<T> {
  data: T;
  usage: UsageHeaders;
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  path: string; // e.g. "me/adaccounts" or "act_123/campaigns"
  params?: Record<string, string | number | boolean | object | undefined>;
  accessToken: string;
  operation: string;
  timeoutMs?: number;
}

function parseJsonHeader(v: string | null) {
  if (!v) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Serializes params the way Graph expects: objects/arrays as JSON, booleans as "true"/"false" (bug 1). */
export function serializeParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (typeof v === 'object' && v !== null) out.set(k, JSON.stringify(v));
    else out.set(k, String(v));
  }
  return out;
}

export type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
export function setFetchForTests(f: FetchLike) {
  fetchImpl = f;
}

export function graphBase(version = env().META_API_VERSION) {
  if (!version) throw new AppError({ code: 'META_API_VERSION_MISSING', message: 'META_API_VERSION is not set.', category: 'configuration', status: 503 });
  return `https://graph.facebook.com/${version}`;
}

export async function graph<T = any>(req: GraphRequest): Promise<GraphResponse<T>> {
  const method = req.method ?? 'GET';
  const params = serializeParams({ ...(req.params ?? {}), access_token: req.accessToken });
  let url = `${graphBase()}/${req.path.replace(/^\//, '')}`;
  const init: RequestInit = { method, signal: AbortSignal.timeout(req.timeoutMs ?? 30_000) };
  if (method === 'GET' || method === 'DELETE') url += `?${params.toString()}`;
  else {
    init.body = params;
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  }

  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err: any) {
    // For writes, a timeout or reset after sending means we cannot know whether Meta created the object.
    const isWrite = method !== 'GET';
    const info: MetaErrorInfo = {
      class: isWrite ? 'ambiguous' : 'transient',
      message: `Network error talking to Meta: ${err?.name === 'TimeoutError' ? 'request timed out' : err?.message ?? err}`,
    };
    logger.warn({ url: sanitizeUrl(url), operation: req.operation, cls: info.class }, 'meta network error');
    throw new MetaApiError(info, req.operation);
  }

  const usage: UsageHeaders = {
    app: parseJsonHeader(res.headers.get('x-app-usage')),
    business: parseJsonHeader(res.headers.get('x-business-use-case-usage')),
    adAccount: parseJsonHeader(res.headers.get('x-ad-account-usage')),
  };
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: { message: `Non-JSON response from Meta (HTTP ${res.status})` } };
  }
  if (!res.ok || body?.error) {
    const info = classifyMetaError(res.status, body);
    if (method !== 'GET' && res.status >= 500 && info.class === 'transient' && !body?.error?.code) info.class = 'ambiguous';
    throw new MetaApiError(info, req.operation);
  }
  return { data: body as T, usage };
}

/** Follows `paging.next` cursors. Stops at maxPages as a safety net, never as a product limit. */
export async function graphPaged<T = any>(req: GraphRequest, maxPages = 200): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { data } = await graph<{ data: T[]; paging?: { cursors?: { after?: string }; next?: string } }>({
      ...req,
      params: { limit: 100, ...(req.params ?? {}), ...(after ? { after } : {}) },
    });
    out.push(...(data.data ?? []));
    if (!data.paging?.next || !data.paging.cursors?.after) break;
    after = data.paging.cursors.after;
  }
  return out;
}

/**
 * Thin API client. Sends the session cookie and CSRF token, and turns the server's structured
 * errors into ApiError so screens can show the real cause, hint and correlation ID.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  category?: string;
  operation?: string;
  stage?: string;
  retryable?: boolean;
  hint?: string;
  details?: { fields?: Record<string, string>; [k: string]: unknown };
  correlationId?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(body.message);
  }
  get fields() {
    return this.body.details?.fields ?? {};
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: opts.signal });
  } catch {
    throw new ApiError(0, { code: 'NETWORK_ERROR', message: 'Cannot reach the server.', hint: 'Check your internet connection. If others can open the app, the server may be restarting.' });
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, { code: 'BAD_RESPONSE', message: `The server returned an unexpected response (HTTP ${res.status}).`, hint: 'The app may be mid-deploy. Wait a minute and refresh.' });
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? { code: `HTTP_${res.status}`, message: res.status === 502 || res.status === 504 ? 'The hosting proxy cut the request before the app answered (HTTP ' + res.status + '). The app may be restarting, or the request took too long. Try again in a moment.' : res.status === 503 ? 'The app is not running or is still starting (HTTP 503). Try again in a minute.' : `Request failed (HTTP ${res.status}).` });
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body });

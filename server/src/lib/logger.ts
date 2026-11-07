import pino from 'pino';

/** Structured logger with redaction of anything that can carry a secret. */
export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      '*.access_token',
      '*.password',
      '*.password_hash',
      '*.token',
      '*.secret',
      '*.client_secret',
      '*.X-Amz-Signature',
    ],
    censor: '[redacted]',
  },
});

/** Removes query-string signatures and tokens from URLs before they are logged or shown. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|signature|secret|credential|code|key/i.test(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch {
    return url.replace(/(access_token|X-Amz-Signature|client_secret)=[^&\s]+/gi, '$1=[redacted]');
  }
}

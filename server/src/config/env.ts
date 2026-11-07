import { z } from 'zod';

/**
 * Environment validation. Runs once at boot; a missing or malformed variable stops the
 * server with a message naming the variable (bug 16), instead of failing later at random.
 */
const bool = (def: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def)
    .transform((v) => v === 'true' || v === '1');

const originSchema = z
  .string()
  .url()
  .refine((v) => !v.endsWith('/'), 'must not end with a trailing slash')
  .refine((v) => new URL(v).origin === v, 'must be a bare origin such as https://example.com (no path)');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_ORIGIN: originSchema,
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().default(''),
    DB_POOL_SIZE: z.coerce.number().int().positive().default(10),

    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded'),
    TOKEN_ENCRYPTION_KEY_ID: z.string().min(1).max(16).default('k1'),
    SETUP_TOKEN: z.string().min(16).optional(),

    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    META_CONFIG_ID: z.string().optional(),
    META_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, 'must look like v24.0')
      .optional(),
    META_REDIRECT_URI: z.string().url().optional(),

    R2_ACCOUNT_ID: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_ALLOWED_ORIGINS: z.string().optional(),
    // Optional override, e.g. an EU-jurisdiction endpoint or a local S3-compatible store for tests.
    R2_ENDPOINT: z.string().url().optional(),
    MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(5 * 1024 ** 3).default(1024 ** 3),
    R2_PREFIX: z.string().regex(/^[a-z0-9._-]+\/$/, 'must end with / such as coastal-media/').default('coastal-media/'),

    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),

    JOB_RUNNER_SECRET: z.string().min(32, 'must be at least 32 characters'),
    IN_PROCESS_WORKER: bool('true'),

    PUBLISH_ENABLED: bool(),
    ACTIVATION_ENABLED: bool(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.META_REDIRECT_URI) {
      const redirect = new URL(env.META_REDIRECT_URI);
      if (redirect.origin !== env.APP_ORIGIN) {
        ctx.addIssue({ code: 'custom', path: ['META_REDIRECT_URI'], message: `must be on APP_ORIGIN (${env.APP_ORIGIN})` });
      }
      if (redirect.pathname.endsWith('/') && redirect.pathname !== '/') {
        ctx.addIssue({ code: 'custom', path: ['META_REDIRECT_URI'], message: 'must not end with a trailing slash' });
      }
    }
    if (env.NODE_ENV === 'production' && !env.APP_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'must use https in production' });
    }
    if (env.ACTIVATION_ENABLED && !env.PUBLISH_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['ACTIVATION_ENABLED'], message: 'requires PUBLISH_ENABLED=true' });
    }
  });

export type Env = z.infer<typeof schema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // Treat empty strings as "not set" so a blank line in .env does not pass validation.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
export function setEnvForTests(e: Env) {
  cached = e;
}

/** The S3 API endpoint for the bucket: R2_ENDPOINT if set, otherwise the account's R2 endpoint. */
export function r2Endpoint(e: Env = env()): string | null {
  if (e.R2_ENDPOINT) return e.R2_ENDPOINT.replace(/\/$/, '');
  return e.R2_ACCOUNT_ID ? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
}

export function features(e: Env = env()) {
  return {
    meta: Boolean(e.META_APP_ID && e.META_APP_SECRET && e.META_API_VERSION && e.META_REDIRECT_URI),
    metaLoginForBusiness: Boolean(e.META_CONFIG_ID),
    r2: Boolean(e.R2_ACCOUNT_ID && e.R2_BUCKET && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY),
    openai: Boolean(e.OPENAI_API_KEY && e.OPENAI_MODEL),
    publishEnabled: e.PUBLISH_ENABLED,
    activationEnabled: e.ACTIVATION_ENABLED,
  };
}

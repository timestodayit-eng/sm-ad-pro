import { randomUUID } from 'node:crypto';

/**
 * Every failure the UI sees is an AppError: what was attempted, where it failed, whether a retry
 * can help and what the operator should do (bug 12). Secrets never go into `details`.
 */
export type ErrorCategory =
  | 'validation'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'configuration'
  | 'schema'
  | 'external_meta'
  | 'external_storage'
  | 'external_ai'
  | 'rate_limited'
  | 'internal';

export interface AppErrorInit {
  code: string;
  message: string;
  status?: number;
  category?: ErrorCategory;
  operation?: string;
  stage?: string;
  retryable?: boolean;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly category: ErrorCategory;
  readonly operation?: string;
  readonly stage?: string;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(init: AppErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = 'AppError';
    this.code = init.code;
    this.status = init.status ?? 500;
    this.category = init.category ?? 'internal';
    this.operation = init.operation;
    this.stage = init.stage;
    this.retryable = init.retryable ?? false;
    this.hint = init.hint;
    this.details = init.details;
  }

  toJSON(correlationId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        category: this.category,
        operation: this.operation,
        stage: this.stage,
        retryable: this.retryable,
        hint: this.hint,
        details: this.details,
        correlationId,
      },
    };
  }
}

export const newCorrelationId = () => randomUUID();

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError({ code: 'VALIDATION_FAILED', message, status: 400, category: 'validation', details, hint: 'Correct the highlighted fields and try again.' }),
  unauthenticated: () =>
    new AppError({ code: 'NOT_SIGNED_IN', message: 'You are not signed in or your session expired.', status: 401, category: 'auth', hint: 'Sign in again.' }),
  forbidden: (what = 'perform this action') =>
    new AppError({ code: 'FORBIDDEN', message: `Your role is not allowed to ${what}.`, status: 403, category: 'permission', hint: 'Ask a Super Admin to change your role or account access.' }),
  notFound: (what: string) => new AppError({ code: 'NOT_FOUND', message: `${what} was not found.`, status: 404, category: 'not_found' }),
  notConfigured: (feature: string, vars: string[]) =>
    new AppError({
      code: 'FEATURE_NOT_CONFIGURED',
      message: `${feature} is not configured on this server.`,
      status: 503,
      category: 'configuration',
      hint: `Set ${vars.join(', ')} in the hosting environment and restart the app.`,
    }),
};

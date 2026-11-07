import { randomUUID } from 'node:crypto';
export class AppError extends Error {
    code;
    status;
    category;
    operation;
    stage;
    retryable;
    hint;
    details;
    constructor(init) {
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
    toJSON(correlationId) {
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
    validation: (message, details) => new AppError({ code: 'VALIDATION_FAILED', message, status: 400, category: 'validation', details, hint: 'Correct the highlighted fields and try again.' }),
    unauthenticated: () => new AppError({ code: 'NOT_SIGNED_IN', message: 'You are not signed in or your session expired.', status: 401, category: 'auth', hint: 'Sign in again.' }),
    forbidden: (what = 'perform this action') => new AppError({ code: 'FORBIDDEN', message: `Your role is not allowed to ${what}.`, status: 403, category: 'permission', hint: 'Ask a Super Admin to change your role or account access.' }),
    notFound: (what) => new AppError({ code: 'NOT_FOUND', message: `${what} was not found.`, status: 404, category: 'not_found' }),
    notConfigured: (feature, vars) => new AppError({
        code: 'FEATURE_NOT_CONFIGURED',
        message: `${feature} is not configured on this server.`,
        status: 503,
        category: 'configuration',
        hint: `Set ${vars.join(', ')} in the hosting environment and restart the app.`,
    }),
};
//# sourceMappingURL=errors.js.map
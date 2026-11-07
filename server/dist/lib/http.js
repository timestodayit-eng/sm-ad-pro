import { z } from 'zod';
import { AppError, errors, newCorrelationId } from './errors.js';
import { logger } from './logger.js';
export const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res, next).catch(next);
};
export function parse(schema, data) {
    const r = schema.safeParse(data);
    if (!r.success) {
        const fields = {};
        for (const i of r.error.issues)
            fields[i.path.join('.') || '_'] = i.message;
        throw errors.validation('Some fields are invalid.', { fields });
    }
    return r.data;
}
export function correlation(req, res, next) {
    const incoming = req.get('x-correlation-id');
    req.correlationId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : newCorrelationId();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
}
export function errorHandler(err, req, res, _next) {
    const cid = req.correlationId ?? newCorrelationId();
    if (err instanceof AppError) {
        if (err.status >= 500)
            logger.error({ err, cid, path: req.path }, err.message);
        else
            logger.info({ code: err.code, cid, path: req.path }, err.message);
        return res.status(err.status).json(err.toJSON(cid));
    }
    const anyErr = err;
    if (anyErr?.type === 'entity.parse.failed') {
        return res.status(400).json(errors.validation('Request body is not valid JSON.').toJSON(cid));
    }
    if (anyErr?.type === 'entity.too.large') {
        return res.status(413).json(new AppError({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.', status: 413, category: 'validation' }).toJSON(cid));
    }
    logger.error({ err, cid, path: req.path }, 'unhandled error');
    const wrapped = new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error.',
        status: 500,
        category: 'internal',
        operation: `${req.method} ${req.path}`,
        retryable: true,
        hint: `Try again. If it repeats, open System Health or share correlation ID ${cid}.`,
    });
    res.status(500).json(wrapped.toJSON(cid));
}
export const idParam = z.coerce.number().int().positive();
//# sourceMappingURL=http.js.map
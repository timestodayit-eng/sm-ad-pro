import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { env, r2Endpoint } from './config/env.js';
import { db } from './db/pool.js';
import { schemaStatus } from './db/migrations.js';
import { correlation, errorHandler } from './lib/http.js';
import { AppError } from './lib/errors.js';
import { loadSession, originAndCsrf, requireAuth, requireMfaSetup } from './auth/sessions.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { internalRouter, opsRouter } from './routes/ops.js';
import { metaCallbackRouter, metaRouter } from './routes/meta.js';
import { mediaRouter } from './routes/media.js';
import { liveRouter } from './routes/live.js';
import { budgetsRouter } from './routes/budgets.js';
import { launchesRouter } from './routes/launches.js';
import { aiRouter } from './routes/ai.js';
import { modulesRouter } from './routes/modules.js';
import { securityRouter } from './routes/security.js';
function webDist() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, '..', '..', 'web', 'dist'), join(here, '..', 'web', 'dist')];
    return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? null;
}
export function createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', env().TRUST_PROXY);
    // Uploads and previews go straight between the browser and the bucket, so its origin must be allowed.
    const storageOrigin = r2Endpoint() ? new URL(r2Endpoint()).origin : 'https://*.r2.cloudflarestorage.com';
    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                'default-src': ["'self'"],
                'img-src': ["'self'", 'data:', 'blob:', 'https:', storageOrigin],
                'media-src': ["'self'", 'blob:', storageOrigin],
                'style-src': ["'self'", "'unsafe-inline'"],
                'font-src': ["'self'", 'data:'],
                'connect-src': ["'self'", storageOrigin],
                'frame-ancestors': ["'none'"],
                // Meta's own ad previews are iframes served from facebook.com.
                'frame-src': ['https://www.facebook.com', 'https://business.facebook.com'],
                'form-action': ["'self'", 'https://www.facebook.com'],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));
    app.use(correlation);
    app.use(express.json({ limit: '1mb' }));
    app.use(cookieParser());
    // Liveness: no database, so Hostinger can tell "process up" from "database down".
    app.get('/healthz', (_req, res) => res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));
    // Readiness: database reachable and schema matches this build (bug 3).
    app.get('/readyz', async (_req, res) => {
        try {
            const s = await schemaStatus(db());
            res.status(s.upToDate ? 200 : 503).json({ ready: s.upToDate, schema: { current: s.current, required: s.required, pending: s.pending.length, failed: s.failed.length } });
        }
        catch (err) {
            res.status(503).json({ ready: false, error: err?.code ?? 'DB_UNAVAILABLE' });
        }
    });
    app.use('/internal', internalRouter);
    const api = express.Router();
    api.use(loadSession);
    api.use(metaCallbackRouter); // GET only, before CSRF/origin
    api.use(originAndCsrf);
    api.use(authRouter);
    api.use(securityRouter);
    api.use(requireAuth);
    api.use(requireMfaSetup);
    api.use(adminRouter);
    api.use(opsRouter);
    api.use(metaRouter);
    api.use(mediaRouter);
    api.use(liveRouter);
    api.use(budgetsRouter);
    api.use(launchesRouter);
    api.use(aiRouter);
    api.use(modulesRouter);
    api.use((req, _res, next) => next(new AppError({ code: 'API_ROUTE_NOT_FOUND', message: `No API route ${req.method} ${req.path}.`, status: 404, category: 'not_found' })));
    app.use('/api', api);
    const dist = webDist();
    if (dist) {
        app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, path) => path.includes('/assets/') && res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
        app.get(/^\/(?!api\/|internal\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
    }
    app.use(errorHandler);
    return app;
}
//# sourceMappingURL=app.js.map
import { env, EnvError, features } from './config/env.js';
import { describeDbError, initPool, closePool, db } from './db/pool.js';
import { schemaStatus } from './db/migrations.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { registerCoreHandlers } from './jobs/handlers.js';
import { startInProcessLoop, stopInProcessLoop } from './jobs/scheduler.js';
/**
 * Boot sequence (bug 16): validate env -> connect DB -> report schema state -> listen.
 * The server still starts when the schema is behind, so the Setup page can install it,
 * but readiness reports 503 and publishing stays blocked.
 */
async function main() {
    let e;
    try {
        e = env();
    }
    catch (err) {
        if (err instanceof EnvError) {
            console.error(`[startup] ${err.message}\nSee .env.example and docs/DEPLOYMENT.md.`);
            process.exit(1);
        }
        throw err;
    }
    initPool(e);
    try {
        await db().query('SELECT 1');
        const s = await schemaStatus(db());
        logger.info({ schema: { current: s.current, required: s.required, pending: s.pending.length } }, s.upToDate ? 'database ready' : 'database schema needs migration');
    }
    catch (err) {
        const d = describeDbError(err);
        logger.error({ code: d.code, hint: d.hint }, `database not reachable at startup: ${d.message}`);
        // Keep running so /healthz and the error page explain the problem instead of a crash loop.
    }
    registerCoreHandlers();
    const app = createApp();
    const server = app.listen(e.PORT, () => {
        logger.info({ port: e.PORT, origin: e.APP_ORIGIN, features: features(e) }, 'Ads Command Center listening');
    });
    if (e.IN_PROCESS_WORKER)
        startInProcessLoop();
    const shutdown = (signal) => {
        logger.info({ signal }, 'shutting down');
        stopInProcessLoop();
        server.close(() => {
            closePool().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
main().catch((err) => {
    console.error('[startup] fatal', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map
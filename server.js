// Hostinger entrypoint. ESM only. Requires `npm run build` first.
import('./server/dist/index.js').catch((err) => {
  console.error('[startup] failed to load server/dist/index.js. Did the build run?', err);
  process.exit(1);
});

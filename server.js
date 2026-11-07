// Hostinger entrypoint. ESM only. The release ZIP already contains server/dist; from source run `npm run build` first.
import { createServer } from 'node:http';

import('./server/dist/index.js').catch((err) => {
  console.error('[startup] failed to load server/dist/index.js. Did the build run?', err);
  // Explain on the website instead of leaving the host to show a bare 503.
  const msg = err?.code === 'ERR_MODULE_NOT_FOUND' && String(err?.message).includes('server/dist')
    ? 'The compiled app (server/dist) is missing. Upload the release ZIP, or run "npm run build" in the app folder.'
    : 'The app failed to load. A required package may be missing: run "npm install" in the app folder, then restart.';
  createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Ads Command Center could not start.\n\n${msg}\n\nDetails are in the Node.js app log in hPanel.\n`);
  }).listen(Number(process.env.PORT) || 3000);
});

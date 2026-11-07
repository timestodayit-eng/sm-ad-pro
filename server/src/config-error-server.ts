import { createServer } from 'node:http';

/**
 * When the environment is invalid the real app cannot start. Instead of crashing (the host then shows a bare
 * "503"), serve one plain page that names each missing or wrong setting. Only variable NAMES and rules are
 * shown, never values.
 */
export function startConfigErrorServer(issues: string[], port = Number(process.env.PORT) || 3000) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Setup needed · Ads Command Center</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1f2937;background:#f8fafc}
@media(prefers-color-scheme:dark){body{color:#e5e7eb;background:#0b1020}code,li{background:#151b2e!important;border-color:#2a3350!important}}
h1{font-size:22px}ul{padding:0;list-style:none}li{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;margin:8px 0}
code{background:#eef2ff;padding:1px 6px;border-radius:6px}</style></head><body>
<h1>The app is installed, but its settings need fixing</h1>
<p>Open <b>hPanel → Websites → your site → Node.js → Environment variables</b>, correct these, then press <b>Restart</b>:</p>
<ul>${issues.map((i) => `<li><code>${esc(i.split(':')[0])}</code>${esc(i.slice(i.indexOf(':')))}</li>`).join('')}</ul>
<p>Every key and how to generate the secrets is in <code>.env.example</code> and <code>docs/DEPLOYMENT.md</code>. Values are never shown here.</p>
</body></html>`;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/healthz') || req.url?.startsWith('/readyz') || req.url?.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: { code: 'CONFIG_INVALID', message: 'Environment settings are missing or invalid.', issues } }));
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  server.listen(port, () => console.error(`[startup] configuration invalid; serving the setup-needed page on port ${port}`));
  return server;
}

// Build entry used by `npm run build` (and by hosting panels that run it automatically).
// Release ZIPs already contain server/dist and web/dist for this exact version; then there is nothing to do.
// Otherwise compile everything. All build tools are regular dependencies, so this works after `npm ci --omit=dev`.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const stamp = 'server/dist/BUILD_VERSION';
const prebuilt = existsSync('server/dist/index.js') && existsSync('web/dist/index.html') && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version;

if (prebuilt && !process.argv.includes('--force')) {
  console.log(`Prebuilt ${version} found (server/dist, web/dist). Skipping compile.`);
  process.exit(0);
}
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
try {
  run('npm run build -w server');
  run('npm run build -w web');
  run('node server/scripts/build-install-sql.mjs');
  writeFileSync(stamp, `${version}\n`);
  console.log(`Built ${version}.`);
} catch {
  console.error('\nBuild failed. If the log says "tsc: command not found" or "vite: not found", the install step skipped packages: run `npm install` (or `npm ci`) in the app folder, then build again.');
  process.exit(1);
}

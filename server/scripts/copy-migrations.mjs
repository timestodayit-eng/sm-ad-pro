// Copies SQL migrations next to the compiled code so the server can find them at runtime.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist', 'migrations'), { recursive: true });
cpSync(join(root, 'migrations'), join(root, 'dist', 'migrations'), { recursive: true });
console.log('migrations copied to dist/migrations');

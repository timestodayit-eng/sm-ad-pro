// Builds database/fresh-install-vX.Y.Z.sql from the migration files, so phpMyAdmin users get exactly
// what the Setup page would apply, plus the schema_migrations rows (same checksums as the runner).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const dir = join(root, 'server', 'migrations');
const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const migrations = files.map((f) => {
  const sql = readFileSync(join(dir, f), 'utf8');
  return { version: Number(f.slice(0, 4)), name: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
});
const latest = migrations.at(-1).version;

const out = `-- =====================================================================================
-- Ads Command Center ${version} : FRESH INSTALL database (schema version ${latest})
--
-- You normally do NOT need this file: the app's Setup page installs the database itself.
-- Use it only if you prefer to import with phpMyAdmin (MySQL 8).
--
-- SAFETY
--   * Import ONLY into a NEW, EMPTY database. It has no DROP statements, so it stops with
--     "table already exists" instead of overwriting anything. Never run it over a live database.
--   * To upgrade an existing install, do NOT use this file. Deploy the new release and press
--     "Apply pending migrations" in Settings -> Database (see docs/UPGRADE.md).
--   * It records migrations 1-${latest} in schema_migrations, so the app sees the database as up to
--     date. After importing, open the panel: it asks for the SETUP_TOKEN and creates the Super Admin.
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE schema_migrations (
  version INT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  checksum CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  applied_by VARCHAR(190) NULL,
  error TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

${migrations.map((m) => `-- ---------------------------------------------------------------- ${m.name}\n${m.sql.trim()}\n`).join('\n')}
-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
${migrations.map((m) => `  (${m.version}, '${m.name}', '${m.checksum}', 'applied', 'fresh-install-sql')`).join(',\n')};
`;
const outDir = join(root, 'database');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `fresh-install-v${version}.sql`);
writeFileSync(file, out);
console.log(`wrote ${file} (schema v${latest})`);

// Upgrade files for phpMyAdmin users: one per starting schema version, each applying every later migration
// and recording it, exactly as "Apply pending migrations" would. The app's button is still the safer route.
for (const from of migrations.slice(0, -1).map((m) => m.version)) {
  const steps = migrations.filter((m) => m.version > from);
  const up = `-- =====================================================================================
-- Ads Command Center ${version} : UPGRADE database from schema version ${from} to ${latest}
--
-- Use this ONLY on a database that is at schema version ${from}. To check: open the table
-- schema_migrations in phpMyAdmin; the highest "version" with status "applied" must be ${from}.
--   * Back up first: phpMyAdmin -> Export.
--   * Deploy the ${version} files and restart the app before or right after importing.
--   * If it stops with "Duplicate column" or "Table already exists", this upgrade (or part of it)
--     was already applied: restore your backup and use the file for your real version instead.
--   * You can also skip this file: Settings -> Database -> "Apply pending migrations" does the same.
-- Applies: ${steps.map((m) => m.name).join(', ')}
-- =====================================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

${steps.map((m) => `-- ---------------------------------------------------------------- ${m.name}\n${m.sql.trim()}\n`).join('\n')}
-- ---------------------------------------------------------------- record what was applied
INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES
${steps.map((m) => `  (${m.version}, '${m.name}', '${m.checksum}', 'applied', 'upgrade-sql')`).join(',\n')};
`;
  writeFileSync(join(outDir, `upgrade-from-schema-${from}-to-${latest}.sql`), up);
}
console.log(`wrote upgrade files for schema ${migrations.slice(0, -1).map((m) => m.version).join(', ')} -> ${latest}`);

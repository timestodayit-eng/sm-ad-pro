import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
function migrationsDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/db -> dist/migrations, src/db -> ../migrations
    const candidates = [join(here, '..', 'migrations'), join(here, '..', '..', 'migrations')];
    const found = candidates.find((c) => existsSync(c));
    if (!found)
        throw new AppError({ code: 'MIGRATIONS_MISSING', message: 'Migration files were not found in the build.', category: 'schema' });
    return found;
}
export function loadMigrations(dir = migrationsDir()) {
    return readdirSync(dir)
        .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
        .sort()
        .map((file) => {
        const sql = readFileSync(join(dir, file), 'utf8');
        return { version: Number(file.slice(0, 4)), name: file.replace(/\.sql$/, ''), file, sql, checksum: sha256(sql) };
    });
}
export const requiredSchemaVersion = () => {
    const all = loadMigrations();
    return all.length ? all[all.length - 1].version : 0;
};
/** Splits a migration into statements. Statements end with `;` at the end of a line. */
export function splitStatements(sql) {
    const withoutComments = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
    return withoutComments
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean);
}
async function ensureTable(pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    name VARCHAR(190) NOT NULL,
    checksum CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    applied_by VARCHAR(190) NULL,
    error TEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
export async function appliedMigrations(pool) {
    const [tables] = await pool.query(`SHOW TABLES LIKE 'schema_migrations'`);
    if (!tables.length)
        return [];
    const [rows] = await pool.query(`SELECT * FROM schema_migrations ORDER BY version`);
    return rows;
}
export async function schemaStatus(pool) {
    const bundled = loadMigrations();
    const history = await appliedMigrations(pool);
    const ok = history.filter((h) => h.status === 'applied');
    const okVersions = new Set(ok.map((h) => h.version));
    const current = ok.length ? Math.max(...ok.map((h) => h.version)) : 0;
    const required = bundled.length ? bundled[bundled.length - 1].version : 0;
    const pending = bundled.filter((m) => !okVersions.has(m.version)).map(({ version, name }) => ({ version, name }));
    const failed = history.filter((h) => h.status === 'failed').map(({ version, name, error }) => ({ version, name, error }));
    const checksumMismatches = bundled
        .filter((m) => ok.some((h) => h.version === m.version && h.checksum !== m.checksum))
        .map(({ version, name }) => ({ version, name }));
    return { required, current, upToDate: pending.length === 0 && failed.length === 0, pending, failed, checksumMismatches, history };
}
/**
 * Applies pending migrations in order under a named database lock so two app instances
 * (or a double-click on the Setup page) cannot run them at the same time.
 * MySQL DDL is not transactional: if a statement fails, the migration is marked `failed`
 * with the error and later migrations are not attempted.
 */
export async function migrate(pool, appliedBy) {
    const conn = await pool.getConnection();
    try {
        const [[lock]] = await conn.query(`SELECT GET_LOCK('acc_schema_migrate', 30) AS got`);
        if (!lock || Number(lock.got) !== 1) {
            throw new AppError({ code: 'MIGRATION_LOCKED', message: 'Another migration is already running.', status: 409, category: 'schema', retryable: true, hint: 'Wait a minute and refresh.' });
        }
        await ensureTable(pool);
        const status = await schemaStatus(pool);
        if (status.failed.length) {
            const f = status.failed[0];
            throw new AppError({
                code: 'MIGRATION_PREVIOUSLY_FAILED',
                message: `Migration ${f.name} failed earlier and must be resolved before continuing.`,
                status: 409,
                category: 'schema',
                details: { version: f.version, error: f.error },
                hint: 'See docs/UPGRADE.md, section "Recovering from a failed migration". Do not run the fresh-install file over this database.',
            });
        }
        if (status.checksumMismatches.length) {
            throw new AppError({
                code: 'MIGRATION_CHECKSUM_MISMATCH',
                message: 'An already-applied migration file was changed after it ran.',
                status: 409,
                category: 'schema',
                details: { migrations: status.checksumMismatches },
                hint: 'Migrations are immutable. Add a new migration instead of editing an old one.',
            });
        }
        const pendingVersions = new Set(status.pending.map((p) => p.version));
        const applied = [];
        for (const m of loadMigrations().filter((x) => pendingVersions.has(x.version))) {
            try {
                for (const stmt of splitStatements(m.sql))
                    await conn.query(stmt);
                await conn.query(`INSERT INTO schema_migrations (version, name, checksum, status, applied_by) VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE checksum=VALUES(checksum), status=VALUES(status), applied_by=VALUES(applied_by), error=NULL, applied_at=CURRENT_TIMESTAMP(3)`, [m.version, m.name, m.checksum, 'applied', appliedBy]);
                applied.push(m.name);
            }
            catch (err) {
                await conn.query(`INSERT INTO schema_migrations (version, name, checksum, status, applied_by, error) VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE status='failed', error=VALUES(error)`, [m.version, m.name, m.checksum, 'failed', appliedBy, String(err?.message ?? err).slice(0, 2000)]);
                throw new AppError({
                    code: 'MIGRATION_FAILED',
                    message: `Migration ${m.name} failed: ${err?.message ?? err}`,
                    status: 500,
                    category: 'schema',
                    stage: m.name,
                    hint: 'Nothing after this migration was applied. See docs/UPGRADE.md for recovery steps.',
                });
            }
        }
        return { applied, status: await schemaStatus(pool) };
    }
    finally {
        await conn.query(`SELECT RELEASE_LOCK('acc_schema_migrate')`).catch(() => undefined);
        conn.release();
    }
}
//# sourceMappingURL=migrations.js.map
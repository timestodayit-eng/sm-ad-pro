import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/pool.js';
import { loadMigrations, migrate, schemaStatus, splitStatements } from '../src/db/migrations.js';
import { closePool, emptyDb } from './helpers.js';

afterAll(closePool);

describe('versioned migrations (bug 3)', () => {
  it('reports an empty database as behind, then installs and reports up to date', async () => {
    await emptyDb();
    const before = await schemaStatus(db());
    expect(before.current).toBe(0);
    expect(before.upToDate).toBe(false);
    expect(before.pending.length).toBe(loadMigrations().length);

    const out = await migrate(db(), 'test');
    expect(out.applied).toContain('0001_foundation');
    expect(out.status.upToDate).toBe(true);
    expect(out.status.current).toBe(out.status.required);
  });

  it('is idempotent: running again applies nothing', async () => {
    const out = await migrate(db(), 'test');
    expect(out.applied).toEqual([]);
  });

  it('detects an edited migration file via checksum', async () => {
    await db().query(`UPDATE schema_migrations SET checksum=REPEAT('0',64) WHERE version=1`);
    const s = await schemaStatus(db());
    expect(s.checksumMismatches.map((m) => m.version)).toContain(1);
    await expect(migrate(db(), 'test')).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' });
  });

  it('blocks further migrations after a failed one', async () => {
    await db().query(`UPDATE schema_migrations SET checksum=? WHERE version=1`, [loadMigrations()[0].checksum]);
    await db().query(`INSERT INTO schema_migrations (version, name, checksum, status, error) VALUES (9999, '9999_broken', REPEAT('a',64), 'failed', 'boom')`);
    const s = await schemaStatus(db());
    expect(s.upToDate).toBe(false);
    await expect(migrate(db(), 'test')).rejects.toMatchObject({ code: 'MIGRATION_PREVIOUSLY_FAILED' });
    await db().query(`DELETE FROM schema_migrations WHERE version=9999`);
  });

  it('splits statements and ignores comment lines', () => {
    expect(splitStatements('-- c;\nCREATE TABLE a (x INT);\nINSERT INTO a VALUES (1);\n')).toEqual(['CREATE TABLE a (x INT)', 'INSERT INTO a VALUES (1)']);
  });
});

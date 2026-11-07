import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, execute, queryOne } from '../src/db/pool.js';
import { backoffSeconds, claim, enqueue, markFailed, queueStats, reclaimExpiredLeases } from '../src/jobs/queue.js';
import { JobError, registerHandler, schedulerHealth, tick } from '../src/jobs/scheduler.js';
import { closePool, freshDb } from './helpers.js';

beforeAll(async () => {
  await freshDb();
  // Recurring schedules would add noise to these tests.
  await execute(`UPDATE recurring_schedules SET is_enabled=0`);
});
beforeEach(async () => {
  await db().query('DELETE FROM job_runs');
  await db().query('DELETE FROM jobs');
});
afterAll(closePool);

describe('job queue', () => {
  it('claims a due job once even with concurrent workers (SKIP LOCKED)', async () => {
    for (let i = 0; i < 10; i++) await enqueue({ queue: 'sync', type: 'test.noop', payload: { i } });
    const results = await Promise.all(Array.from({ length: 5 }, (_, w) => claim(`w${w}`, 'sync', 4, 60)));
    const ids = results.flat().map((j) => j.id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('does not claim jobs that are not yet due', async () => {
    await enqueue({ queue: 'sync', type: 'test.noop', runAfter: new Date(Date.now() + 60_000) });
    expect(await claim('w', 'sync', 5, 60)).toEqual([]);
  });

  it('dedupe key prevents double enqueue', async () => {
    const a = await enqueue({ queue: 'sync', type: 'test.noop', dedupeKey: 'k1' });
    const b = await enqueue({ queue: 'sync', type: 'test.noop', dedupeKey: 'k1' });
    expect(a).toBeTypeOf('number');
    expect(b).toBeNull();
  });

  it('reclaims a job whose worker lease expired (crash recovery)', async () => {
    const id = await enqueue({ queue: 'sync', type: 'test.noop' });
    await claim('dead-worker', 'sync', 1, 60);
    await execute(`UPDATE jobs SET lease_until = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id=?`, [id]);
    expect(await reclaimExpiredLeases()).toBe(1);
    const row = await queryOne(`SELECT status, locked_by FROM jobs WHERE id=?`, [id]);
    expect(row).toMatchObject({ status: 'queued', locked_by: null });
  });

  it('flags overdue jobs (bug 4: queued, attempts 0, run_after in the past)', async () => {
    const id = await enqueue({ queue: 'publishing', type: 'test.noop' });
    await execute(`UPDATE jobs SET run_after = CURRENT_TIMESTAMP(3) - INTERVAL 10 MINUTE WHERE id=?`, [id]);
    const s = await queueStats();
    expect(s.overdue).toBe(1);
    expect(s.oldestPending?.id).toBe(id);
    expect(s.oldestPending!.overdueSeconds).toBeGreaterThanOrEqual(590);
  });

  it('retries transient failures with backoff, then dead-letters', async () => {
    const id = await enqueue({ queue: 'sync', type: 'test.noop', maxAttempts: 2 });
    let [job] = await claim('w', 'sync', 1, 60);
    expect(await markFailed(job, 'w', { kind: 'transient', code: 'X', message: 'x' })).toBe('queued');
    const after = await queueOneRunAfter(id!);
    expect(after).toBeGreaterThan(Date.now() + 20_000);
    await execute(`UPDATE jobs SET run_after=CURRENT_TIMESTAMP(3) WHERE id=?`, [id]);
    [job] = await claim('w', 'sync', 1, 60);
    expect(await markFailed(job, 'w', { kind: 'transient', code: 'X', message: 'x' })).toBe('dead');
  });

  it('sends deterministic and ambiguous failures to needs_review, never auto-retry', async () => {
    await enqueue({ queue: 'publishing', type: 'test.noop' });
    let [job] = await claim('w', 'publishing', 1, 60);
    expect(await markFailed(job, 'w', { kind: 'deterministic', code: 'META_100', message: 'bad field' })).toBe('needs_review');
    await enqueue({ queue: 'publishing', type: 'test.noop' });
    [job] = await claim('w', 'publishing', 1, 60);
    expect(await markFailed(job, 'w', { kind: 'ambiguous', code: 'TIMEOUT', message: 'unknown outcome' })).toBe('needs_review');
  });

  it('backoff grows exponentially and is capped', () => {
    expect(backoffSeconds(1)).toBeGreaterThanOrEqual(30);
    expect(backoffSeconds(3)).toBeGreaterThanOrEqual(120);
    expect(backoffSeconds(30)).toBeLessThanOrEqual(3600 + 30);
  });
});

async function queueOneRunAfter(id: number) {
  const r = await queryOne(`SELECT run_after FROM jobs WHERE id=?`, [id]);
  return new Date(r!.run_after).getTime();
}

describe('scheduler tick (bugs 4, 5)', () => {
  it('reports never_started before the first tick', async () => {
    await execute(`UPDATE scheduler_state SET last_tick_at=NULL, last_success_at=NULL, last_source=NULL WHERE id=1`);
    const h = await schedulerHealth();
    expect(h.state).toBe('never_started');
    expect(h.warnings.join()).toMatch(/never completed a tick/);
  });

  it('processes due jobs automatically and records a heartbeat', async () => {
    let ran = 0;
    registerHandler('test.count', async () => {
      ran++;
    });
    await enqueue({ queue: 'publishing', type: 'test.count' });
    await enqueue({ queue: 'reports', type: 'test.count' });
    const r = await tick('cron', { budgetMs: 5000 });
    expect(r.ran).toBe(true);
    expect(r.succeeded).toBe(2);
    expect(ran).toBe(2);
    const h = await schedulerHealth();
    expect(h.state).toBe('running');
    expect(h.lastSource).toBe('cron');
    expect(h.recentHeartbeats[0]).toMatchObject({ source: 'cron', jobs_claimed: 2 });
  });

  it('only one tick runs at a time; the second is skipped, not doubled', async () => {
    registerHandler('test.slow', async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    for (let i = 0; i < 3; i++) await enqueue({ queue: 'sync', type: 'test.slow' });
    const [a, b] = await Promise.all([tick('cron', { workerId: 'A', budgetMs: 5000 }), tick('cloudflare', { workerId: 'B', budgetMs: 5000 })]);
    const ran = [a, b].filter((x) => x.ran);
    expect(ran.length).toBe(1);
    expect([a, b].find((x) => !x.ran)?.skippedReason).toBe('another_tick_running');
    expect(a.succeeded + b.succeeded).toBe(3);
  });

  it('marks a job with no handler as needs_review with a clear message', async () => {
    const id = await enqueue({ queue: 'sync', type: 'test.unknown_type' });
    await tick('cron', { budgetMs: 3000 });
    const row = await queryOne(`SELECT status, last_error FROM jobs WHERE id=?`, [id]);
    expect(row!.status).toBe('needs_review');
    const err = typeof row!.last_error === 'string' ? JSON.parse(row!.last_error) : row!.last_error;
    expect(err.code).toBe('NO_HANDLER');
  });

  it('rescheduling (e.g. media still processing) does not burn attempts', async () => {
    registerHandler('test.wait', async (job, ctx) => {
      if (!job.payload.ready) await ctx.rescheduleIn(60, { polls: (job.payload.polls ?? 0) + 1 });
    });
    const id = await enqueue({ queue: 'media', type: 'test.wait', payload: {} });
    const r = await tick('cron', { budgetMs: 3000 });
    expect(r.rescheduled).toBe(1);
    const row = await queryOne(`SELECT status, attempts, payload FROM jobs WHERE id=?`, [id]);
    expect(row!.status).toBe('queued');
    expect(Number(row!.attempts)).toBe(0);
    const payload = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect(payload.polls).toBe(1);
  });

  it('JobError carries the failure kind', async () => {
    registerHandler('test.fail', async () => {
      throw new JobError({ kind: 'deterministic', code: 'META_WRITE_100', message: 'Must specify True or False' });
    });
    const id = await enqueue({ queue: 'publishing', type: 'test.fail' });
    await tick('cron', { budgetMs: 3000 });
    const row = await queryOne(`SELECT status FROM jobs WHERE id=?`, [id]);
    expect(row!.status).toBe('needs_review');
  });

  it('enqueues recurring schedules once per slot', async () => {
    await execute(`UPDATE recurring_schedules SET is_enabled=1, last_enqueued_at=NULL WHERE name='session_cleanup'`);
    await tick('cron', { budgetMs: 3000 });
    await execute(`UPDATE recurring_schedules SET last_enqueued_at=NULL WHERE name='session_cleanup'`);
    await tick('cron', { budgetMs: 3000 });
    const n = await queryOne(`SELECT COUNT(*) AS n FROM jobs WHERE type='maintenance.cleanup_sessions'`);
    expect(Number(n!.n)).toBe(1);
    await execute(`UPDATE recurring_schedules SET is_enabled=0`);
  });
});

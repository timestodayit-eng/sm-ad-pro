import { hostname } from 'node:os';
import { randomToken } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { db, execute, query, queryOne } from '../db/pool.js';
import { schemaStatus } from '../db/migrations.js';
import { AppError } from '../lib/errors.js';
import { claim, enqueue, markFailed, markSucceeded, queueStats, reclaimExpiredLeases, reschedule, type Job, type JobFailure, type QueueName, QUEUES, OVERDUE_AFTER_SECONDS } from './queue.js';

/**
 * The scheduler tick (bugs 4 and 5). Called every minute by an external cron (Hostinger cron and/or
 * a Cloudflare Cron Trigger) via POST /internal/tick, and opportunistically by an in-process loop.
 * A database lease on scheduler_state guarantees only one tick runs at a time, so several callers are safe.
 */

export const WORKER_ID = `${hostname()}:${process.pid}:${randomToken(3)}`;
const SCHEDULER_LEASE_SECONDS = 55;
const JOB_LEASE_SECONDS = 120;
export const SCHEDULER_STALE_AFTER_SECONDS = 180;

export interface JobContext {
  workerId: string;
  /** Put the job back without counting a failure, e.g. "video still processing, check again in 60 s". */
  rescheduleIn: (seconds: number, payloadPatch?: Record<string, unknown>) => Promise<void>;
}

export class JobError extends Error {
  constructor(public readonly failure: JobFailure) {
    super(failure.message);
  }
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void | 'rescheduled'>;
const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}
export function registeredTypes() {
  return [...handlers.keys()];
}

function toFailure(err: unknown): JobFailure {
  if (err instanceof JobError) return err.failure;
  if (err instanceof AppError) {
    return { kind: err.retryable ? 'transient' : 'deterministic', code: err.code, message: err.message, hint: err.hint, details: err.details };
  }
  const e = err as any;
  const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'];
  return {
    kind: transientCodes.includes(e?.code) ? 'transient' : 'deterministic',
    code: e?.code ?? 'UNEXPECTED_ERROR',
    message: String(e?.message ?? e).slice(0, 1000),
  };
}

async function runJob(job: Job, workerId: string): Promise<'succeeded' | 'failed' | 'rescheduled'> {
  const handler = handlers.get(job.type);
  if (!handler) {
    await markFailed(job, workerId, {
      kind: 'deterministic',
      code: 'NO_HANDLER',
      message: `No handler is registered for job type "${job.type}".`,
      hint: 'The server version may be older than the job. Deploy the matching version, then retry.',
    });
    return 'failed';
  }
  let rescheduled = false;
  const ctx: JobContext = {
    workerId,
    rescheduleIn: async (seconds, patch) => {
      rescheduled = true;
      await reschedule(job, workerId, seconds, patch);
    },
  };
  try {
    await handler(job, ctx);
    if (rescheduled) return 'rescheduled';
    await markSucceeded(job, workerId);
    return 'succeeded';
  } catch (err) {
    if (rescheduled) return 'rescheduled';
    const failure = toFailure(err);
    logger.warn({ jobId: job.id, type: job.type, failure }, 'job failed');
    await markFailed(job, workerId, failure);
    return 'failed';
  }
}

async function acquireSchedulerLease(workerId: string): Promise<boolean> {
  const res = await execute(
    `UPDATE scheduler_state
        SET locked_by=?, lease_until = CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND
      WHERE id=1 AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP(3) OR locked_by=?)`,
    [workerId, SCHEDULER_LEASE_SECONDS, workerId],
  );
  return res.affectedRows === 1;
}

async function releaseSchedulerLease(workerId: string) {
  await execute(`UPDATE scheduler_state SET locked_by=NULL, lease_until=NULL WHERE id=1 AND locked_by=?`, [workerId]);
}

/** Enqueues recurring work whose interval has elapsed. The dedupe key is the time slot, so two ticks cannot double-enqueue. */
export async function enqueueRecurring(): Promise<number> {
  const due = await query(
    `SELECT * FROM recurring_schedules
      WHERE is_enabled=1 AND (last_enqueued_at IS NULL OR last_enqueued_at <= CURRENT_TIMESTAMP(3) - INTERVAL interval_seconds SECOND)`,
  );
  let n = 0;
  for (const s of due) {
    const slot = Math.floor(Date.now() / 1000 / Number(s.interval_seconds));
    const id = await enqueue({ queue: s.queue as QueueName, type: s.type, payload: { schedule: s.name }, dedupeKey: `recurring:${s.name}:${slot}`, maxAttempts: 3 });
    await execute(`UPDATE recurring_schedules SET last_enqueued_at=CURRENT_TIMESTAMP(3) WHERE name=?`, [s.name]);
    if (id) n++;
  }
  return n;
}

export interface TickResult {
  ran: boolean;
  skippedReason?: string;
  claimed: number;
  succeeded: number;
  failed: number;
  rescheduled: number;
  reclaimed: number;
  enqueued: number;
  durationMs: number;
}

/**
 * One scheduler tick. Claims jobs round-robin across queues (fair scheduling: a big sync backlog cannot
 * starve publishing or reports) until the time budget runs out.
 */
export async function tick(source: string, opts: { budgetMs?: number; workerId?: string } = {}): Promise<TickResult> {
  const workerId = opts.workerId ?? WORKER_ID;
  const budgetMs = opts.budgetMs ?? 45_000;
  const started = Date.now();
  const result: TickResult = { ran: false, claimed: 0, succeeded: 0, failed: 0, rescheduled: 0, reclaimed: 0, enqueued: 0, durationMs: 0 };

  const hb = await execute(`INSERT INTO scheduler_heartbeats (source, worker_id, started_at) VALUES (?,?,CURRENT_TIMESTAMP(3))`, [source, workerId]);
  await execute(`UPDATE scheduler_state SET last_tick_at=CURRENT_TIMESTAMP(3), last_source=? WHERE id=1`, [source]);

  if (!(await acquireSchedulerLease(workerId))) {
    result.skippedReason = 'another_tick_running';
    result.durationMs = Date.now() - started;
    await execute(`UPDATE scheduler_heartbeats SET finished_at=CURRENT_TIMESTAMP(3), skipped_reason=? WHERE id=?`, [result.skippedReason, hb.insertId]);
    return result;
  }

  let tickError: string | null = null;
  try {
    result.ran = true;
    result.reclaimed = await reclaimExpiredLeases();
    result.enqueued = await enqueueRecurring();

    const queues = [...QUEUES];
    let idleRounds = 0;
    while (Date.now() - started < budgetMs && idleRounds < 1) {
      let claimedThisRound = 0;
      for (const q of queues) {
        if (Date.now() - started >= budgetMs) break;
        const [job] = await claim(workerId, q, 1, JOB_LEASE_SECONDS);
        if (!job) continue;
        claimedThisRound++;
        result.claimed++;
        const outcome = await runJob(job, workerId);
        result[outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'rescheduled']++;
      }
      idleRounds = claimedThisRound === 0 ? idleRounds + 1 : 0;
      // Keep the scheduler lease alive during long ticks.
      await acquireSchedulerLease(workerId);
    }
    await execute(`UPDATE scheduler_state SET last_success_at=CURRENT_TIMESTAMP(3) WHERE id=1`);
  } catch (err: any) {
    tickError = String(err?.message ?? err).slice(0, 1000);
    logger.error({ err }, 'scheduler tick failed');
    await execute(`UPDATE scheduler_state SET last_error=?, last_error_at=CURRENT_TIMESTAMP(3) WHERE id=1`, [tickError]).catch(() => undefined);
  } finally {
    await releaseSchedulerLease(workerId).catch(() => undefined);
    result.durationMs = Date.now() - started;
    await execute(
      `UPDATE scheduler_heartbeats SET finished_at=CURRENT_TIMESTAMP(3), jobs_claimed=?, jobs_succeeded=?, jobs_failed=?, leases_reclaimed=?, error=? WHERE id=?`,
      [result.claimed, result.succeeded, result.failed, result.reclaimed, tickError, hb.insertId],
    ).catch(() => undefined);
  }
  return result;
}

export interface SchedulerHealth {
  state: 'running' | 'stale' | 'never_started';
  lastTickAt: Date | null;
  lastSuccessAt: Date | null;
  lastSource: string | null;
  secondsSinceLastSuccess: number | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  recentHeartbeats: any[];
  queue: Awaited<ReturnType<typeof queueStats>>;
  warnings: string[];
  overdueAfterSeconds: number;
  staleAfterSeconds: number;
  /** Ticks are refused while the database is behind the code; say so instead of only "stopped". */
  schema: { upToDate: boolean; current: number; required: number };
}

/** What the Dashboard banner and System Health show. Distinguishes "never started" from "stopped". */
export async function schedulerHealth(): Promise<SchedulerHealth> {
  const st = await queryOne(
    `SELECT *, TIMESTAMPDIFF(SECOND, last_success_at, CURRENT_TIMESTAMP(3)) AS since_success FROM scheduler_state WHERE id=1`,
  );
  const recent = await query(`SELECT source, started_at, finished_at, jobs_claimed, jobs_succeeded, jobs_failed, skipped_reason, error FROM scheduler_heartbeats ORDER BY id DESC LIMIT 10`);
  const q = await queueStats();
  const since = st?.since_success != null ? Number(st.since_success) : null;
  const state: SchedulerHealth['state'] = !st?.last_success_at ? 'never_started' : since! > SCHEDULER_STALE_AFTER_SECONDS ? 'stale' : 'running';
  const ss = await schemaStatus(db());
  const schema = { upToDate: ss.upToDate, current: ss.current, required: ss.required };
  const warnings: string[] = [];
  if (!schema.upToDate) warnings.push(`The database is at version ${schema.current} but this release needs ${schema.required}. Background jobs wait until the upgrade is applied (Settings → Database, or the upgrade-from-schema-${schema.current}-to-${schema.required}.sql file).`);
  if (state === 'never_started') warnings.push('The scheduler has never completed a tick. Set up the cron job described in docs/SCHEDULER.md.');
  if (state === 'stale') warnings.push(`No successful scheduler tick for ${Math.round(since! / 60)} minutes. Background work (sync, publishing, reports) is not running.`);
  if (q.overdue > 0) warnings.push(`${q.overdue} job(s) are more than ${OVERDUE_AFTER_SECONDS / 60} minutes past their due time.`);
  if (q.failed > 0) warnings.push(`${q.failed} job(s) failed or need review.`);
  return {
    state,
    lastTickAt: st?.last_tick_at ?? null,
    lastSuccessAt: st?.last_success_at ?? null,
    lastSource: st?.last_source ?? null,
    secondsSinceLastSuccess: since,
    lastError: st?.last_error ?? null,
    lastErrorAt: st?.last_error_at ?? null,
    recentHeartbeats: recent,
    queue: q,
    warnings,
    overdueAfterSeconds: OVERDUE_AFTER_SECONDS,
    staleAfterSeconds: SCHEDULER_STALE_AFTER_SECONDS,
    schema,
  };
}

let loop: NodeJS.Timeout | null = null;
/** Opportunistic in-process draining while the app is awake. Never the only trigger. */
let schemaReady = false;
/** True once the database schema is fully migrated. Cached after the first success so ticks stay cheap. */
export async function schedulerSchemaReady(): Promise<boolean> {
  if (!schemaReady) schemaReady = (await schemaStatus(db())).upToDate;
  return schemaReady;
}

export function startInProcessLoop(intervalMs = 10_000) {
  if (loop) return;
  let busy = false;
  loop = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      // Before the Setup page installs the database there is nothing to run; stay quiet instead of logging errors.
      if (!(await schedulerSchemaReady())) return;
      await tick('in_process', { budgetMs: 8_000 });
    } catch (err) {
      logger.error({ err }, 'in-process tick failed');
    } finally {
      busy = false;
    }
  }, intervalMs);
  loop.unref();
}
export function stopInProcessLoop() {
  if (loop) clearInterval(loop);
  loop = null;
}

import { execute, query, queryOne } from '../db/pool.js';
import { randomToken } from '../lib/crypto.js';

/**
 * Persistent MySQL job queue (bugs 4, 5, 13). Jobs are claimed with row locks and a lease;
 * a crashed worker's lease expires and the job is reclaimed. Retries use exponential backoff
 * with jitter. Deterministic failures go to needs_review; exhausted retries go to dead.
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_review' | 'dead' | 'cancelled';

export interface Job {
  id: number;
  queue: string;
  type: string;
  payload: any;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_by: string | null;
  lease_until: Date | null;
  last_error: any;
  created_at: Date;
}

export const QUEUES = ['publishing', 'media', 'sync', 'insights', 'reports', 'ai', 'documents', 'notifications', 'maintenance'] as const;
export type QueueName = (typeof QUEUES)[number];

/** Overdue = still queued this long after it became due. */
export const OVERDUE_AFTER_SECONDS = 120;

export interface EnqueueInput {
  queue: QueueName;
  type: string;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
}

export async function enqueue(input: EnqueueInput): Promise<number | null> {
  const res = await execute(
    `INSERT INTO jobs (queue, type, payload, priority, max_attempts, run_after, dedupe_key)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      input.queue,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 100,
      input.maxAttempts ?? 6,
      input.runAfter ?? new Date(),
      input.dedupeKey ?? null,
    ],
  );
  return res.affectedRows === 1 && res.insertId > 0 ? res.insertId : null;
}

function parseJob(row: any): Job {
  return {
    ...row,
    id: Number(row.id),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    priority: Number(row.priority),
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    last_error: typeof row.last_error === 'string' ? JSON.parse(row.last_error) : row.last_error,
  };
}

/**
 * Claims up to `limit` due jobs from one queue with a lease. Safe with concurrent workers:
 * candidates are read without locks, then taken with a single conditional UPDATE stamped with a
 * unique claim token (`locked_by`). A row can only move queued -> running once, so two workers never
 * get the same job. (FOR UPDATE SKIP LOCKED was avoided: with ORDER BY + LIMIT InnoDB locks every row
 * it sorts, which starves other workers.)
 */
export async function claim(workerId: string, queue: string, limit: number, leaseSeconds: number): Promise<Job[]> {
  const candidates = await query(
    `SELECT id FROM jobs
      WHERE status='queued' AND queue=? AND run_after <= CURRENT_TIMESTAMP(3)
      ORDER BY priority ASC, run_after ASC, id ASC
      LIMIT ?`,
    [queue, limit * 4],
  );
  if (!candidates.length) return [];
  const token = `${workerId}#${randomToken(4)}`.slice(0, 64);
  await execute(
    `UPDATE jobs SET status='running', locked_by=?, attempts=attempts+1,
            lease_until = CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND
      WHERE id IN (?) AND status='queued'
      ORDER BY priority ASC, run_after ASC, id ASC
      LIMIT ?`,
    [token, leaseSeconds, candidates.map((c) => c.id), limit],
  );
  const claimed = await query(`SELECT * FROM jobs WHERE locked_by=? AND status='running'`, [token]);
  for (const j of claimed) {
    await execute(`INSERT INTO job_runs (job_id, attempt, worker_id, started_at) VALUES (?,?,?,CURRENT_TIMESTAMP(3))`, [j.id, j.attempts, token]);
  }
  return claimed.map(parseJob);
}

export async function extendLease(job: Job, leaseSeconds: number) {
  await execute(
    `UPDATE jobs SET lease_until = CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND WHERE id=? AND locked_by=? AND status='running'`,
    [leaseSeconds, job.id, job.locked_by],
  );
}

async function finishRun(jobId: number, attempt: number, outcome: string, error?: unknown) {
  await execute(
    `UPDATE job_runs SET finished_at=CURRENT_TIMESTAMP(3), outcome=?, error=? WHERE job_id=? AND attempt=? AND finished_at IS NULL`,
    [outcome, error ? JSON.stringify(error) : null, jobId, attempt],
  );
}

export async function markSucceeded(job: Job, workerId: string) {
  await execute(
    `UPDATE jobs SET status='succeeded', locked_by=NULL, lease_until=NULL, finished_at=CURRENT_TIMESTAMP(3), last_error=NULL
      WHERE id=? AND locked_by=?`,
    [job.id, job.locked_by ?? workerId],
  );
  await finishRun(job.id, job.attempts, 'succeeded');
}

/** Rescheduling without counting a failure (e.g. Meta video still processing). */
export async function reschedule(job: Job, workerId: string, delaySeconds: number, payloadPatch?: Record<string, unknown>) {
  const payload = payloadPatch ? { ...job.payload, ...payloadPatch } : job.payload;
  await execute(
    `UPDATE jobs SET status='queued', locked_by=NULL, lease_until=NULL, attempts=GREATEST(attempts-1,0),
            run_after = CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND, payload=?
      WHERE id=? AND locked_by=?`,
    [delaySeconds, JSON.stringify(payload), job.id, job.locked_by ?? workerId],
  );
  await finishRun(job.id, job.attempts, 'rescheduled');
}

export type FailureKind = 'transient' | 'deterministic' | 'ambiguous';

export interface JobFailure {
  kind: FailureKind;
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export function backoffSeconds(attempt: number, base = 30, cap = 3600): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(30, exp / 4));
  return exp + jitter;
}

export async function markFailed(job: Job, workerId: string, failure: JobFailure): Promise<JobStatus> {
  let next: JobStatus;
  if (failure.kind === 'deterministic') next = 'needs_review';
  else if (failure.kind === 'ambiguous') next = 'needs_review';
  else next = job.attempts >= job.max_attempts ? 'dead' : 'queued';

  const delay = next === 'queued' ? backoffSeconds(job.attempts) : 0;
  await execute(
    `UPDATE jobs SET status=?, locked_by=NULL, lease_until=NULL, last_error=?,
            run_after = IF(? = 'queued', CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND, run_after),
            finished_at = IF(? = 'queued', NULL, CURRENT_TIMESTAMP(3))
      WHERE id=? AND locked_by=?`,
    [next, JSON.stringify(failure), next, delay, next, job.id, job.locked_by ?? workerId],
  );
  await finishRun(job.id, job.attempts, next === 'queued' ? 'retry' : next, failure);
  return next;
}

/** Jobs whose worker died: lease expired while running. They go back to queued (bug 4 / crash recovery). */
export async function reclaimExpiredLeases(): Promise<number> {
  const expired = await query(`SELECT id, attempts, max_attempts FROM jobs WHERE status='running' AND lease_until < CURRENT_TIMESTAMP(3)`);
  let n = 0;
  for (const j of expired) {
    const exhausted = Number(j.attempts) >= Number(j.max_attempts);
    const res = await execute(
      `UPDATE jobs SET status=?, locked_by=NULL, lease_until=NULL,
              last_error=JSON_OBJECT('kind','transient','code','LEASE_EXPIRED','message','Worker stopped before finishing; job reclaimed.')
        WHERE id=? AND status='running' AND lease_until < CURRENT_TIMESTAMP(3)`,
      [exhausted ? 'dead' : 'queued', j.id],
    );
    if (res.affectedRows) {
      n++;
      await finishRun(Number(j.id), Number(j.attempts), 'lease_expired');
    }
  }
  return n;
}

export async function retryJob(jobId: number): Promise<boolean> {
  const res = await execute(
    `UPDATE jobs SET status='queued', run_after=CURRENT_TIMESTAMP(3), max_attempts=GREATEST(max_attempts, attempts+1), finished_at=NULL
      WHERE id=? AND status IN ('failed','needs_review','dead')`,
    [jobId],
  );
  return res.affectedRows === 1;
}

export async function cancelJob(jobId: number): Promise<boolean> {
  const res = await execute(`UPDATE jobs SET status='cancelled', finished_at=CURRENT_TIMESTAMP(3) WHERE id=? AND status IN ('queued','needs_review','failed','dead')`, [jobId]);
  return res.affectedRows === 1;
}

export interface QueueStats {
  byStatus: Record<string, number>;
  waiting: number;
  overdue: number;
  running: number;
  failed: number;
  oldestPending: { id: number; type: string; queue: string; run_after: Date; overdueSeconds: number } | null;
  perQueue: { queue: string; waiting: number; overdue: number; running: number }[];
}

export async function queueStats(): Promise<QueueStats> {
  const rows = await query(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = Number(r.n);
  const overdueRow = await queryOne(
    `SELECT COUNT(*) AS n FROM jobs WHERE status='queued' AND run_after < CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND`,
    [OVERDUE_AFTER_SECONDS],
  );
  const oldest = await queryOne(
    `SELECT id, type, queue, run_after, TIMESTAMPDIFF(SECOND, run_after, CURRENT_TIMESTAMP(3)) AS late
       FROM jobs WHERE status='queued' AND run_after <= CURRENT_TIMESTAMP(3) ORDER BY run_after ASC LIMIT 1`,
  );
  const perQueue = await query(
    `SELECT queue,
            SUM(status='queued') AS waiting,
            SUM(status='queued' AND run_after < CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND) AS overdue,
            SUM(status='running') AS running
       FROM jobs WHERE status IN ('queued','running') GROUP BY queue`,
    [OVERDUE_AFTER_SECONDS],
  );
  return {
    byStatus,
    waiting: byStatus.queued ?? 0,
    overdue: Number(overdueRow?.n ?? 0),
    running: byStatus.running ?? 0,
    failed: (byStatus.failed ?? 0) + (byStatus.needs_review ?? 0) + (byStatus.dead ?? 0),
    oldestPending: oldest
      ? { id: Number(oldest.id), type: oldest.type, queue: oldest.queue, run_after: oldest.run_after, overdueSeconds: Math.max(0, Number(oldest.late)) }
      : null,
    perQueue: perQueue.map((q) => ({ queue: q.queue, waiting: Number(q.waiting), overdue: Number(q.overdue), running: Number(q.running) })),
  };
}

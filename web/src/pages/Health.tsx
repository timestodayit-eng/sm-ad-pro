import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleDashed, Clock, Database, FlaskConical, Play, RefreshCw, RotateCcw, Server, Sparkles, Upload, XCircle, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, ErrorAlert, PageHeader, Segmented, Skeleton, StatCard, cx, formatDateTime, timeAgo, type Tone } from '../components/ui';
import { get, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle, useSession } from '../lib/session';

const STATUS_META: Record<string, { tone: Tone; label: string; Icon: typeof CheckCircle2 }> = {
  pass: { tone: 'good', label: 'Passing', Icon: CheckCircle2 },
  warn: { tone: 'warn', label: 'Warning', Icon: AlertTriangle },
  fail: { tone: 'bad', label: 'Failing', Icon: XCircle },
  not_configured: { tone: 'neutral', label: 'Not configured', Icon: CircleDashed },
  not_implemented: { tone: 'neutral', label: 'Not built yet', Icon: CircleDashed },
};
const EVIDENCE: Record<string, string> = { live: 'Live check', config: 'Config only', verified: 'Verified end-to-end', none: 'No evidence' };
const GROUPS: { id: string; label: string; Icon: typeof Database }[] = [
  { id: 'database', label: 'Database', Icon: Database },
  { id: 'jobs', label: 'Background jobs', Icon: Activity },
  { id: 'meta', label: 'Meta', Icon: Server },
  { id: 'storage', label: 'Storage (R2)', Icon: Upload },
  { id: 'ai', label: 'AI', Icon: Sparkles },
  { id: 'publishing', label: 'Publishing', Icon: Play },
];

export function HealthPage() {
  const { t } = useI18n();
  const { can } = useSession();
  usePageTitle(t('health'));
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: () => get('/health'), refetchInterval: 30_000 });
  const sched = useQuery({ queryKey: ['scheduler'], queryFn: () => get('/jobs/scheduler'), refetchInterval: 15_000 });
  const [filter, setFilter] = useState<'active' | 'problems' | 'all'>('active');
  const jobs = useQuery({
    queryKey: ['jobs', filter],
    queryFn: () => get(`/jobs${filter === 'problems' ? '?status=needs_review' : filter === 'active' ? '?status=queued' : ''}`),
    refetchInterval: 15_000,
  });
  const invalidate = () => ['health', 'scheduler', 'jobs', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const runNow = useMutation({ mutationFn: () => post('/jobs/run-now'), onSuccess: invalidate });
  const probe = useMutation({ mutationFn: () => post('/jobs/probe'), onSuccess: invalidate });
  const retry = useMutation({ mutationFn: (id: number) => post(`/jobs/${id}/retry`), onSuccess: invalidate });

  const s = sched.data;
  const checks: any[] = health.data?.checks ?? [];

  return (
    <>
      <PageHeader
        title={t('health')}
        description="Each check says what it actually proved. “Config only” means the settings look right, not that the integration has been tested live."
        actions={
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={invalidate} loading={health.isFetching}>
            {t('refresh')}
          </Button>
        }
      />

      {health.error && <ErrorAlert error={health.error} />}

      {/* Scheduler: the most important operational signal (bugs 4 and 5). */}
      <Card className="mb-6">
        <CardHeader
          title="Scheduler and job queue"
          description="An external cron job calls the app every minute. Jobs should never sit past their due time."
          icon={<Clock className="size-4" />}
          actions={
            can('jobs.manage') && (
              <>
                <Button size="sm" variant="secondary" icon={<FlaskConical className="size-3.5" />} loading={probe.isPending} onClick={() => probe.mutate()} title="Queues a test job. If it completes without you pressing Run now, the cron job works.">
                  Test the cron
                </Button>
                <Button size="sm" icon={<Play className="size-3.5" />} loading={runNow.isPending} onClick={() => runNow.mutate()}>
                  Run now
                </Button>
              </>
            )
          }
        />
        <div className="p-5">
          {sched.isLoading ? (
            <Skeleton className="h-24" />
          ) : s ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Scheduler"
                  value={s.state === 'running' ? 'Running' : s.state === 'stale' ? 'Stopped' : 'Never started'}
                  tone={s.state === 'running' ? 'good' : 'bad'}
                  icon={<Activity className="size-4" />}
                  sub={s.lastSuccessAt ? `Last success ${timeAgo(s.lastSuccessAt)} via ${s.lastSource}` : 'No successful tick recorded'}
                />
                <StatCard label="Waiting" value={s.queue.waiting} icon={<Clock className="size-4" />} sub={s.queue.oldestPending ? `Oldest due ${timeAgo(s.queue.oldestPending.run_after)}` : 'Nothing due'} />
                <StatCard label="Overdue" value={s.queue.overdue} tone={s.queue.overdue ? 'bad' : 'good'} icon={<AlertTriangle className="size-4" />} sub={`More than ${Math.round(s.overdueAfterSeconds / 60)} min past due`} />
                <StatCard label="Failed / needs review" value={s.queue.failed} tone={s.queue.failed ? 'warn' : 'good'} icon={<XCircle className="size-4" />} sub={`${s.queue.running} running now`} />
              </div>
              {s.warnings.length > 0 && (
                <div className="mt-4 space-y-2">
                  {s.warnings.map((w: string) => (
                    <Alert key={w} tone={s.state === 'running' ? 'warn' : 'bad'} title={w} />
                  ))}
                </div>
              )}
              {s.lastError && (
                <div className="mt-4">
                  <Alert tone="bad" title="Last scheduler error">
                    {s.lastError} <span className="text-ink-3">({formatDateTime(s.lastErrorAt)})</span>
                  </Alert>
                </div>
              )}
              {runNow.data && (
                <div className="mt-4">
                  <Alert tone={runNow.data.ran ? 'good' : 'info'} title={runNow.data.ran ? `Tick finished in ${runNow.data.durationMs} ms` : 'Another tick was already running'}>
                    {runNow.data.ran && `${runNow.data.claimed} claimed, ${runNow.data.succeeded} succeeded, ${runNow.data.failed} failed, ${runNow.data.rescheduled} rescheduled, ${runNow.data.reclaimed} reclaimed.`}
                  </Alert>
                </div>
              )}
              {probe.data && <div className="mt-4"><Alert tone="info" title={`Test job #${probe.data.jobId} queued`}>Wait one to two minutes without pressing Run now. If it shows as succeeded below, the cron job is working.</Alert></div>}
              {(runNow.error || probe.error) && <div className="mt-4"><ErrorAlert error={runNow.error || probe.error} /></div>}

              <div className="mt-6">
                <div className="mb-2 text-sm font-medium text-ink">Recent ticks</div>
                <div className="overflow-x-auto rounded-xl border border-line">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-surface-2 text-left text-xs text-ink-3">
                      <tr>
                        <th className="px-3 py-2 font-medium">When</th>
                        <th className="px-3 py-2 font-medium">Source</th>
                        <th className="px-3 py-2 font-medium">Jobs</th>
                        <th className="px-3 py-2 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {s.recentHeartbeats.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-4 text-center text-ink-3">
                            No ticks yet. Set up the cron job from docs/SCHEDULER.md.
                          </td>
                        </tr>
                      )}
                      {s.recentHeartbeats.map((h: any, i: number) => (
                        <tr key={i}>
                          <td className="px-3 py-2 text-ink-2">{formatDateTime(h.started_at)}</td>
                          <td className="px-3 py-2"><Badge tone="neutral">{h.source}</Badge></td>
                          <td className="px-3 py-2 text-ink-2 tabular-nums">
                            {h.jobs_claimed} claimed · {h.jobs_succeeded} ok · {h.jobs_failed} failed
                          </td>
                          <td className="px-3 py-2">
                            {h.skipped_reason === 'unauthorized' ? <span title={h.error}><Badge tone="bad">Refused: wrong secret</Badge></span> : h.skipped_reason === 'schema_pending' ? <span title={h.error}><Badge tone="warn">Waiting: database upgrade</Badge></span> : h.error ? <Badge tone="bad">Error</Badge> : h.skipped_reason ? <Badge tone="neutral">Skipped: another tick running</Badge> : h.finished_at ? <Badge tone="good">OK</Badge> : <Badge tone="warn">Running</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {GROUPS.map((g) => {
          const list = checks.filter((c) => c.group === g.id);
          if (!list.length && !health.isLoading) return null;
          return (
            <Card key={g.id}>
              <CardHeader title={g.label} icon={<g.Icon className="size-4" />} />
              {health.isLoading ? (
                <div className="p-5">
                  <Skeleton className="h-10" />
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {list.map((c) => {
                    const m = STATUS_META[c.status];
                    return (
                      <li key={c.id} className="flex gap-3 px-5 py-4">
                        <m.Icon className={cx('mt-0.5 size-[18px] shrink-0', { good: 'text-good', warn: 'text-warn', bad: 'text-bad', neutral: 'text-ink-3', info: 'text-info', brand: 'text-brand' }[m.tone])} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink">{c.label}</span>
                            <Badge tone={m.tone}>{m.label}</Badge>
                            <Badge tone="neutral">{EVIDENCE[c.evidence]}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-ink-2">{c.message}</p>
                          {c.hint && <p className="mt-1 text-sm text-ink-3">{c.hint}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Jobs"
          description="Background work, newest first. Failed jobs show the real error and can be retried."
          actions={<Segmented label="Job filter" value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Waiting' }, { value: 'problems', label: 'Needs review' }, { value: 'all', label: 'All' }]} />}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
              <tr className="border-b border-line">
                <th className="px-5 py-3">Job</th>
                <th className="px-2 py-3">Status</th>
                <th className="px-2 py-3">Attempts</th>
                <th className="px-2 py-3">Due</th>
                <th className="px-2 py-3">Last error</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(jobs.data?.items ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-ink-3">
                    {jobs.isLoading ? 'Loading…' : 'No jobs in this view.'}
                  </td>
                </tr>
              )}
              {(jobs.data?.items ?? []).map((j: any) => (
                <tr key={j.id} className="hover:bg-surface-2">
                  <td className="px-5 py-3">
                    <div className="font-medium text-ink">{j.type}</div>
                    <div className="text-xs text-ink-3">
                      #{j.id} · {j.queue}
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <Badge tone={j.status === 'succeeded' ? 'good' : ['failed', 'dead', 'needs_review'].includes(j.status) ? 'bad' : j.overdue ? 'warn' : 'neutral'}>
                      {j.overdue ? 'overdue' : j.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="px-2 py-3 text-ink-2 tabular-nums">
                    {j.attempts}/{j.max_attempts}
                  </td>
                  <td className="px-2 py-3 text-ink-3">{formatDateTime(j.run_after)}</td>
                  <td className="max-w-xs px-2 py-3 text-ink-2">
                    {j.last_error ? (
                      <span title={j.last_error.hint ?? ''}>
                        <span className="font-mono text-xs text-bad">{j.last_error.code}</span> {j.last_error.message}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {can('jobs.manage') && ['failed', 'dead', 'needs_review'].includes(j.status) && (
                      <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} loading={retry.isPending && retry.variables === j.id} onClick={() => retry.mutate(j.id)}>
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

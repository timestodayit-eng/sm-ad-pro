import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radar, RefreshCw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, PageHeader, Select, Skeleton, cx, formatDateTime, timeAgo, type Tone } from '../components/ui';
import { get, post, put } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';

const TONE: Record<string, Tone> = { critical: 'bad', warning: 'warn', info: 'info', good: 'good' };
const LABEL: Record<string, string> = { critical: 'Act now', warning: 'Look into', info: 'Note', good: 'Working well' };

export function MonitoringPage() {
  usePageTitle('Monitoring');
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['monitoring'], queryFn: () => get('/monitoring'), refetchInterval: 60_000 });
  const [s, setS] = useState<any | null>(null);
  useEffect(() => { if (q.data?.settings && !s) setS(q.data.settings); }, [q.data, s]);
  const save = useMutation({ mutationFn: () => put('/monitoring/settings', s), onSuccess: () => qc.invalidateQueries({ queryKey: ['monitoring'] }) });
  const scan = useMutation({ mutationFn: () => post('/monitoring/scan'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['monitoring'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); } });
  const d = q.data;
  const findings: any[] = d?.findings ?? [];
  const groups = ['critical', 'warning', 'info', 'good'].map((sv) => ({ sv, rows: findings.filter((f) => f.severity === sv) })).filter((g) => g.rows.length);
  const lastRun = d?.runs?.[0];
  return (
    <>
      <PageHeader title="Monitoring" description="Every 30 minutes the panel checks your synced data for spend spikes, stalled delivery, spend with no results, expensive results, low balances, rejected ads, failed launches, stale syncs and Meta logins about to expire, and writes one notification per finding per day. Nothing here is guessed by a model." actions={<Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={scan.isPending} onClick={() => scan.mutate()}>Scan now</Button>} />
      {q.error && <ErrorAlert error={q.error} />}
      {scan.error && <ErrorAlert error={scan.error} />}
      {scan.data && <div className="mb-4"><Alert tone="good" title={`Scan done: ${scan.data.findings} finding${scan.data.findings === 1 ? '' : 's'} across ${scan.data.accounts} account${scan.data.accounts === 1 ? '' : 's'}, ${scan.data.alerts} new notification${scan.data.alerts === 1 ? '' : 's'}.`} /></div>}
      {q.isLoading || !d ? <Skeleton className="h-64 rounded-2xl" /> : (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <div className="text-xs font-semibold tracking-wide text-ink-3 uppercase">Schedule</div>
              <div className="mt-1 text-lg font-semibold text-ink">{d.schedule ? (d.schedule.enabled ? `Every ${d.schedule.intervalMinutes} minutes` : 'Switched off') : 'Not installed'}</div>
              <div className="text-sm text-ink-3">{lastRun ? <>Last scan {timeAgo(lastRun.startedAt)}{lastRun.error ? <span className="text-bad"> · failed: {lastRun.error}</span> : ` · ${lastRun.findings} findings, ${lastRun.alerts} alerts`}</> : 'No scan has run yet. The scheduler runs it, or press Scan now.'}</div>
              <Link to="/health" className="mt-2 inline-block text-sm font-medium text-brand hover:underline">System Health →</Link>
            </Card>
            <Card className="p-5">
              <div className="text-xs font-semibold tracking-wide text-ink-3 uppercase">Right now</div>
              <div className="mt-1 flex flex-wrap gap-2">{['critical', 'warning', 'info', 'good'].map((sv) => <Badge key={sv} tone={TONE[sv]}>{LABEL[sv]} {findings.filter((f) => f.severity === sv).length}</Badge>)}</div>
              <div className="mt-2 text-sm text-ink-3">{d.accounts} working account{d.accounts === 1 ? '' : 's'} checked over the last 7 days.</div>
            </Card>
            <Card className="p-5">
              <div className="text-xs font-semibold tracking-wide text-ink-3 uppercase">Meta logins</div>
              <ul className="mt-1 space-y-1 text-sm">
                {d.connections.length === 0 ? <li className="text-ink-3">None connected.</li> : d.connections.map((c: any) => <li key={c.id} className="flex items-center justify-between gap-2"><span className="text-ink">{c.name}</span><span className={cx('text-xs', c.status === 'active' ? 'text-ink-3' : 'text-bad')}>{c.status}{c.expiresAt ? ` · expires ${formatDateTime(c.expiresAt).slice(0, 11)}` : ' · no expiry given'}</span></li>)}
              </ul>
            </Card>
          </div>
          {groups.length === 0 ? <Card className="mb-4"><EmptyState icon={<Radar className="size-6" />} title="Nothing stands out">No spikes, stalls, low balances, rejected ads, stale syncs or expiring logins right now.</EmptyState></Card> : groups.map((g) => (
            <Card key={g.sv} className="mb-4">
              <CardHeader title={<span className="flex items-center gap-2"><Badge tone={TONE[g.sv]}>{LABEL[g.sv]}</Badge><span>{g.rows.length}</span></span>} />
              <ul className="divide-y divide-line">
                {g.rows.map((f) => (
                  <li key={f.key} className="px-5 py-3">
                    <div className="font-medium text-ink">{f.title}</div>
                    <p className="text-sm text-ink-2">{f.detail}</p>
                    {f.suggestion && <p className="mt-0.5 text-sm text-ink">→ {f.suggestion}</p>}
                    {f.link && <Link to={f.link} className="text-xs font-medium text-brand hover:underline">Open →</Link>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Alert settings" description="Which findings become notifications." actions={can('settings.manage') && s ? <Button size="sm" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>Save</Button> : undefined} />
              {s && (
                <div className="space-y-4 p-5">
                  <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" disabled={!can('settings.manage')} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Write notifications from scheduled scans</label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="At least"><Select value={s.minSeverity} disabled={!can('settings.manage')} onChange={(e) => setS({ ...s, minSeverity: e.target.value })}><option value="info">Note</option><option value="warning">Look into</option><option value="critical">Act now</option></Select></Field>
                    <Field label="Sync is stale after (minutes)"><Input inputMode="numeric" disabled={!can('settings.manage')} value={s.staleSyncMinutes} onChange={(e) => setS({ ...s, staleSyncMinutes: Number(e.target.value) || 120 })} /></Field>
                    <Field label="Warn about logins expiring within (days)"><Input inputMode="numeric" disabled={!can('settings.manage')} value={s.tokenDaysWarning} onChange={(e) => setS({ ...s, tokenDaysWarning: Number(e.target.value) || 7 })} /></Field>
                  </div>
                  <div>
                    <div className="mb-1 text-sm font-medium text-ink">Checks</div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">{d.kinds.map((k: any) => <label key={k.key} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4" disabled={!can('settings.manage')} checked={s.kinds.includes(k.key)} onChange={() => setS({ ...s, kinds: s.kinds.includes(k.key) ? s.kinds.filter((x: string) => x !== k.key) : [...s.kinds, k.key] })} /> {k.label}</label>)}</div>
                  </div>
                  {save.error && <ErrorAlert error={save.error} />}
                  {!can('settings.manage') && <p className="text-xs text-ink-3">Only admins change these.</p>}
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="Recent scans" />
              {d.runs.length === 0 ? <p className="p-5 text-sm text-ink-3">No scans yet.</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase"><th className="px-5 py-2">When</th><th className="px-2 py-2 text-right">Accounts</th><th className="px-2 py-2 text-right">Findings</th><th className="px-2 py-2 text-right">New alerts</th><th className="px-5 py-2">Result</th></tr></thead>
                  <tbody className="divide-y divide-line">{d.runs.map((r: any) => <tr key={r.id}><td className="px-5 py-2 text-ink">{formatDateTime(r.startedAt)}</td><td className="px-2 py-2 text-right tabular-nums">{r.accounts}</td><td className="px-2 py-2 text-right tabular-nums">{r.findings}</td><td className="px-2 py-2 text-right tabular-nums">{r.alerts}</td><td className="px-5 py-2 text-xs">{r.error ? <span className="text-bad">{r.error}</span> : r.finishedAt ? <Badge tone="good">ok</Badge> : <span className="text-ink-3">running</span>}</td></tr>)}</tbody>
                </table>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

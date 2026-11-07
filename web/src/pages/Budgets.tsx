import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, History, Wallet, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, Input, Modal, PageHeader, Segmented, Select, Skeleton, cx, formatDateTime } from '../components/ui';
import { get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { GroupPicker, money, useGroup } from './Live';

type Mode = 'stepped' | 'same' | 'add';

const STATUS_NOTE: Record<string, string> = {
  choose: 'Pick the ad set to change',
  cbo: 'Uses a campaign budget (CBO), so its ad sets have no budget of their own',
  lifetime: 'Only lifetime budgets, which this page does not change',
  none: 'No ad set with a budget',
  skipped: 'Left out',
};

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

const ResultIcon = ({ s }: { s: string }) =>
  s === 'done' ? <CheckCircle2 className="size-4 text-good" /> : s === 'failed' || s === 'mismatch' ? <XCircle className="size-4 text-bad" /> : <AlertTriangle className="size-4 text-warn" />;
const RESULT_LABEL: Record<string, string> = { done: 'Changed and confirmed on Meta', failed: 'Not changed', mismatch: 'Meta shows a different amount', not_attempted: 'Not tried' };

export function BudgetsPage() {
  usePageTitle('Budgets');
  const { can } = useSession();
  const qc = useQueryClient();
  const { group, set: setGroup } = useGroup();
  const [mode, setMode] = useState<Mode>('stepped');
  const [start, setStart] = useState('20');
  const [step, setStep] = useState('2');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  const startN = Number(start), stepN = Number(step);
  const inputsOk = (mode === 'add' || (start.trim() !== '' && startN > 0)) && (mode === 'same' || (step.trim() !== '' && Number.isFinite(stepN)));
  const body = useDebounced({ group: group ?? undefined, mode, start: mode === 'add' ? 0 : startN || 0, step: mode === 'same' ? 0 : stepN || 0, choices, skip });
  const plan = useQuery({
    queryKey: ['budgets', 'plan', body],
    queryFn: () => post('/budgets/plan', body),
    placeholderData: keepPreviousData,
    enabled: inputsOk,
  });
  const history = useQuery({ queryKey: ['budgets', 'history'], queryFn: () => get('/budgets/history') });
  const rows: any[] = plan.data?.rows ?? [];
  const ready = rows.filter((r) => r.status === 'ready');
  const blocked = ready.some((r) => r.problem);
  const big = (r: any) => r.current != null && r.current > 0 && r.next != null && (r.next < r.current * 0.5 || r.next > r.current * 3);
  const bigCount = ready.filter(big).length;
  const apply = useMutation({
    mutationFn: () => post('/budgets/apply', { confirm: true, items: ready.map((r) => ({ accountRowId: r.accountRowId, adsetId: r.adsetId, dailyBudget: r.next })) }),
    onSuccess: (r) => {
      setResult(r);
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ['budgets'] });
      qc.invalidateQueries({ queryKey: ['live'] });
    },
  });
  const toggleSkip = (id: number) => setSkip((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const example = useMemo(() => {
    if (mode !== 'stepped' || !(startN > 0)) return null;
    return [0, 1, 2].map((i) => Math.round((startN + stepN * i) * 100) / 100).join(', ') + ' …';
  }, [mode, startN, stepN]);

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Change ad set daily budgets across your working accounts, in your account order. You see every new amount before anything changes on Meta."
      />
      {!can('campaigns.manage') && <div className="mb-4"><Alert tone="info" title="You can preview, but not change budgets">Your role cannot change budgets on Meta. Ask an Admin.</Alert></div>}

      <Card>
        <CardHeader title="1. Choose the change" />
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4 px-5 pb-5">
          <div>
            <div className="mb-1 text-xs font-medium text-ink-3">How</div>
            <Segmented label="How to set budgets" value={mode} onChange={setMode} options={[{ value: 'stepped', label: 'Step up down the order' }, { value: 'same', label: 'Same for all' }, { value: 'add', label: 'Add to current' }]} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {mode !== 'add' && (
              <label className="text-xs font-medium text-ink-3">
                {mode === 'stepped' ? 'First account' : 'Daily budget'}
                <Input inputMode="decimal" className="mt-1 h-9 w-32 tabular-nums" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
            )}
            {mode !== 'same' && (
              <label className="text-xs font-medium text-ink-3">
                {mode === 'stepped' ? 'Then add each time' : 'Add (use − to lower)'}
                <Input inputMode="decimal" className="mt-1 h-9 w-32 tabular-nums" value={step} onChange={(e) => setStep(e.target.value)} />
              </label>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <GroupPicker group={group} onChange={setGroup} />
          </div>
        </div>
        <div className="border-t border-line px-5 py-3 text-xs text-ink-3">
          {mode === 'stepped' ? <>Amounts go down your account order{example ? <>: <span className="tabular-nums text-ink-2">{example}</span></> : ''}. Accounts you leave out are skipped, and the next one takes the next amount. </> : mode === 'same' ? 'Every chosen ad set gets the same daily budget. ' : 'Each chosen ad set’s current budget plus this amount. '}
          Amounts are in each account’s own currency. Change the order in <Link to="/settings#working-accounts" className="text-brand hover:underline">Settings → Working accounts</Link>.
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="2. Check the preview"
          description="Based on the last sync. Each ad set is checked again on Meta just before it is changed."
          actions={plan.isFetching && <span className="text-xs text-ink-3">Updating…</span>}
        />
        {plan.error && <div className="px-5 pb-4"><ErrorAlert error={plan.error} /></div>}
        {!inputsOk ? (
          <div className="px-5 pb-5 text-sm text-ink-3">Enter the amounts above to see the preview.</div>
        ) : plan.isLoading ? (
          <div className="p-5"><Skeleton className="h-56" /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Wallet className="size-6" />} title="No working accounts" action={<Link to="/settings#working-accounts"><Button>Choose working accounts</Button></Link>}>Budgets work on your working accounts.</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                    <th className="w-10 py-3 pl-5"><span className="sr-only">Include</span></th>
                    <th className="w-10 px-2 py-3 text-right">#</th>
                    <th className="px-2 py-3">Account</th>
                    <th className="px-2 py-3">Ad set</th>
                    <th className="px-2 py-3 text-right">Now</th>
                    <th className="px-2 py-3 text-right">New</th>
                    <th className="px-5 py-3 text-right">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => {
                    const off = r.status === 'skipped';
                    const can = r.status === 'ready' || r.status === 'choose' || off;
                    const diff = r.next != null && r.current != null ? Math.round((r.next - r.current) * 100) / 100 : null;
                    return (
                      <tr key={r.accountRowId} className={cx(off && 'opacity-50', !can && 'bg-surface-2/50')}>
                        <td className="py-3 pl-5">
                          {can && <input type="checkbox" className="size-4" aria-label={`Include ${r.name}`} checked={!off} onChange={() => toggleSkip(r.accountRowId)} />}
                        </td>
                        <td className="px-2 py-3 text-right text-xs text-ink-3 tabular-nums">{r.position ?? ''}</td>
                        <td className="px-2 py-3">
                          <div className="font-medium text-ink">{r.name}</div>
                          <div className="text-xs text-ink-3">act_{r.accountId} · {r.currency}</div>
                        </td>
                        <td className="max-w-[360px] px-2 py-3">
                          {r.options.length > 1 || r.status === 'choose' ? (
                            <Select
                              className={cx('h-9 w-full', r.status === 'choose' && 'border-warn')}
                              aria-label={`Ad set for ${r.name}`}
                              value={r.adsetId ?? ''}
                              disabled={off}
                              onChange={(e) => setChoices((c) => ({ ...c, [r.accountRowId]: e.target.value }))}
                            >
                              {!r.adsetId && <option value="">Choose an ad set…</option>}
                              {r.options.map((o: any) => (
                                <option key={o.adsetId} value={o.adsetId}>{o.name} · {o.effectiveStatus === 'ACTIVE' ? 'running' : (o.effectiveStatus ?? '').toLowerCase().replace(/_/g, ' ')} · {money(o.dailyBudget, r.currency)}</option>
                              ))}
                            </Select>
                          ) : r.adsetName ? (
                            <>
                              <div className="truncate text-ink" title={r.adsetName}>{r.adsetName}</div>
                              <div className="truncate text-xs text-ink-3" title={r.campaignName}>{r.campaignName}</div>
                            </>
                          ) : (
                            <span className="text-xs text-ink-3">{STATUS_NOTE[r.status]}</span>
                          )}
                          {r.status === 'choose' && <div className="mt-1 text-xs text-warn">{STATUS_NOTE.choose}</div>}
                        </td>
                        <td className="px-2 py-3 text-right tabular-nums">{r.current != null ? money(r.current, r.currency) : '—'}</td>
                        <td className="px-2 py-3 text-right font-semibold text-ink tabular-nums">
                          {r.next != null ? money(r.next, r.currency) : '—'}
                          {r.problem && <div className="text-xs font-normal text-bad">{r.problem}</div>}
                          {r.status === 'ready' && big(r) && <div className="text-xs font-normal text-warn">{r.next < r.current ? 'Less than half of now' : 'More than 3× now'}</div>}
                        </td>
                        <td className={cx('px-5 py-3 text-right tabular-nums', diff != null && diff > 0 ? 'text-good' : diff != null && diff < 0 ? 'text-bad' : 'text-ink-3')}>
                          {diff == null ? '' : diff === 0 ? 'no change' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff), r.currency)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
              <div className="text-sm text-ink-2">
                <strong className="text-ink">{ready.length}</strong> ad set{ready.length === 1 ? '' : 's'} will change
                {plan.data.summary.totals.map((t: any) => <span key={t.currency}> · total {money(t.current, t.currency)} → <strong className="text-ink">{money(t.next, t.currency)}</strong> a day</span>)}
                {plan.data.summary.needChoice > 0 && <span className="text-warn"> · {plan.data.summary.needChoice} need an ad set chosen</span>}
              </div>
              <Button disabled={!can('campaigns.manage') || ready.length === 0 || blocked} onClick={() => setConfirming(true)}>Review and confirm</Button>
            </div>
          </>
        )}
      </Card>

      {result && (
        <Card className="mt-6">
          <CardHeader
            title="Result"
            description={`${result.summary.done} changed and confirmed on Meta${result.summary.failed ? `, ${result.summary.failed} not changed` : ''}${result.summary.mismatch ? `, ${result.summary.mismatch} with a different amount on Meta` : ''}${result.summary.notAttempted ? `, ${result.summary.notAttempted} not tried` : ''}.`}
            actions={<Button size="sm" variant="secondary" onClick={() => setResult(null)}>Close</Button>}
          />
          <ul className="divide-y divide-line border-t border-line">
            {result.results.map((x: any) => (
              <li key={x.adsetId} className="flex items-start gap-3 px-5 py-3 text-sm">
                <ResultIcon s={x.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-ink"><span className="text-ink-3 tabular-nums">{x.position}.</span> {x.accountName} · <span className="text-ink-2">{x.adsetName}</span></div>
                  <div className="text-xs text-ink-3">
                    {RESULT_LABEL[x.status]}
                    {x.status === 'done' && <> · {money(x.before, x.currency)} → <strong className="text-ink">{money(x.confirmed, x.currency)}</strong></>}
                    {x.status === 'mismatch' && <> · asked {money(x.requested, x.currency)}, Meta shows {money(x.confirmed, x.currency)}</>}
                    {x.error && <span className="text-bad"> · {x.error}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader title="Recent budget changes" icon={<History className="size-4" />} description="Every change made from this panel, with the amount Meta confirmed." />
        {history.error && <div className="px-5 pb-4"><ErrorAlert error={history.error} /></div>}
        {history.isLoading ? <div className="p-5"><Skeleton className="h-20" /></div> : !history.data?.batches?.length ? (
          <div className="px-5 pb-5 text-sm text-ink-3">No budget changes yet.</div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {history.data.batches.slice(0, 10).map((b: any) => {
              const done = b.items.filter((i: any) => i.status === 'done').length;
              return (
                <li key={b.batchId} className="px-5 py-3">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm text-ink">
                      {formatDateTime(b.at)} · {b.by ?? 'Someone'} · {done} of {b.items.length} changed
                      {done < b.items.length && <Badge tone="warn">{b.items.length - done} not changed</Badge>}
                    </summary>
                    <ul className="mt-2 space-y-1 pl-4 text-xs text-ink-2">
                      {b.items.map((i: any) => (
                        <li key={i.adsetId + i.position} className="flex items-center gap-2">
                          <ResultIcon s={i.status} /> {i.position}. {i.accountName} · {i.adsetName}: {money(i.before, i.currency)} → {money(i.confirmed ?? i.requested, i.currency)}
                          {i.error && <span className="text-bad">({i.error})</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Modal
        open={confirming}
        onClose={() => !apply.isPending && setConfirming(false)}
        wide
        title={`Change ${ready.length} ad set budget${ready.length === 1 ? '' : 's'} on Meta?`}
        footer={
          <>
            <Button variant="secondary" disabled={apply.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button loading={apply.isPending} onClick={() => apply.mutate()}>Change budgets now</Button>
          </>
        }
      >
        <div className="space-y-3">
          {apply.error && <ErrorAlert error={apply.error} />}
          {bigCount > 0 && <Alert tone="warn" title={`${bigCount} budget${bigCount === 1 ? '' : 's'} change a lot`}>Marked below. Check the amounts and the currency before you confirm.</Alert>}
          <p className="text-sm text-ink-2">These daily budgets change on Meta right away, one by one in this order. Each is read back from Meta to confirm. Running ads keep running.</p>
          <ol className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm">
            {ready.map((r) => (
              <li key={r.accountRowId} className="flex items-center gap-3 px-4 py-2">
                <span className="w-6 text-right text-xs text-ink-3 tabular-nums">{r.position}</span>
                <span className="min-w-0 flex-1 truncate"><span className="text-ink">{r.name}</span> <span className="text-ink-3">· {r.adsetName}</span></span>
                <span className="whitespace-nowrap tabular-nums text-ink-3">{money(r.current, r.currency)} →</span>
                <strong className={cx('w-24 text-right tabular-nums', big(r) ? 'text-warn' : 'text-ink')}>{money(r.next, r.currency)}</strong>
              </li>
            ))}
          </ol>
          {apply.isPending && <p className="text-xs text-ink-3">Changing budgets on Meta… keep this window open.</p>}
        </div>
      </Modal>
    </>
  );
}

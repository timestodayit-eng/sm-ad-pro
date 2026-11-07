import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BarChart3, Download, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, CardHeader, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Segmented, Select, Skeleton, cx } from '../components/ui';
import { api, get, post } from '../lib/api';
import { usePageTitle, useSession } from '../lib/session';
import { useDebounced } from './EasyAds';
import { money, num, pct } from './Live';
import { DateFilter, usePeriod } from './liveControls';

type Level = 'account' | 'campaign' | 'ad' | 'day' | 'month';
const LEVELS: { value: Level; label: string }[] = [{ value: 'account', label: 'Accounts' }, { value: 'campaign', label: 'Campaigns' }, { value: 'ad', label: 'Ads' }, { value: 'day', label: 'Days' }, { value: 'month', label: 'Months' }];

function cell(kind: string, v: any, currency: string) {
  if (v == null) return '—';
  if (kind === 'money') return money(v, currency);
  if (kind === 'pct') return pct(v);
  return num(v);
}

export function ReportsPage() {
  usePageTitle('Custom Reports');
  const { can } = useSession();
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ['reports', 'options'], queryFn: () => get('/reports/options') });
  const { period, set: setPeriod } = usePeriod('7d');
  const [level, setLevel] = useState<Level>('account');
  const [metrics, setMetrics] = useState<string[]>(['spend', 'results', 'costPerResult', 'ctr']);
  const [accountIds, setAccountIds] = useState<number[]>([]);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | undefined>();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const config = { period: period.preset, since: period.since, until: period.until, level, metrics, accountIds, sort };
  const debounced = useDebounced(config, 250);
  const run = useQuery({ queryKey: ['reports', 'run', debounced], queryFn: () => post('/reports/run', debounced), enabled: metrics.length > 0, placeholderData: keepPreviousData });
  const save = useMutation({ mutationFn: () => post('/reports/templates', { name: name.trim(), config }), onSuccess: () => { setSaving(false); setName(''); qc.invalidateQueries({ queryKey: ['reports', 'options'] }); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/reports/templates/${id}`, { method: 'DELETE' }), onSuccess: () => { setTemplate(''); qc.invalidateQueries({ queryKey: ['reports', 'options'] }); } });
  const templates: any[] = options.data?.templates ?? [];
  const allMetrics: any[] = options.data?.metrics ?? [];
  const accounts: any[] = options.data?.accounts ?? [];
  useEffect(() => {
    const t = templates.find((x) => String(x.id) === template);
    if (!t) return;
    const c = t.config;
    setLevel(c.level ?? 'account'); setMetrics(c.metrics ?? []); setAccountIds(c.accountIds ?? []); setSort(c.sort);
    setPeriod(c.period === 'custom' ? { preset: 'custom', since: c.since, until: c.until } : { preset: c.period ?? '7d' });
  }, [template]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = run.data;
  const csvHref = `/api/reports/export.csv?c=${btoa(unescape(encodeURIComponent(JSON.stringify(config)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const headSort = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  const SortIcon = ({ k }: { k: string }) => (sort?.key === k ? (sort.dir === 'asc' ? <ArrowUp className="inline size-3" /> : <ArrowDown className="inline size-3" />) : null);
  const nameCol = level === 'day' ? 'Day' : level === 'month' ? 'Month' : level === 'account' ? 'Account' : level === 'campaign' ? 'Campaign' : 'Ad';

  return (
    <>
      <PageHeader title="Custom Reports" description="Any working accounts, any period, rows by account, campaign, ad, day or month, with the metrics you pick. Every number comes from the data the panel synced from Meta. Save a report to run it again; export as CSV for Excel or Google Sheets." actions={<a href={csvHref} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-surface-2"><Download className="size-4" /> Export CSV</a>} />
      {options.error && <ErrorAlert error={options.error} />}
      <Card className="mb-4">
        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-4">
            <Field label="Saved reports">
              <div className="flex items-center gap-2">
                <Select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Saved report"><option value="">Start from scratch…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
                {can('reports.manage') && <Button variant="secondary" icon={<Save className="size-4" />} onClick={() => setSaving(true)}>Save as…</Button>}
                {can('reports.manage') && template && <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={del.isPending} onClick={() => del.mutate(Number(template))}>Delete</Button>}
              </div>
            </Field>
            <Field label="Period"><DateFilter period={period} onChange={setPeriod} /></Field>
            <Field label="Rows"><Segmented label="Rows" value={level} onChange={setLevel} options={LEVELS} /></Field>
            <Field label="Accounts" hint="None ticked means all working accounts.">
              <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">{accounts.map((a) => <label key={a.id} className="flex items-center gap-1.5 text-sm text-ink"><input type="checkbox" className="size-4" checked={accountIds.includes(a.id)} onChange={() => setAccountIds((xs) => (xs.includes(a.id) ? xs.filter((x) => x !== a.id) : [...xs, a.id]))} /> {a.name}</label>)}</div>
            </Field>
          </div>
          <Field label="Metrics">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">{allMetrics.map((m) => <label key={m.key} className="flex items-center gap-1.5 text-sm text-ink"><input type="checkbox" className="size-4" checked={metrics.includes(m.key)} onChange={() => setMetrics((xs) => (xs.includes(m.key) ? xs.filter((x) => x !== m.key) : [...xs, m.key]))} /> {m.label}</label>)}</div>
          </Field>
        </div>
      </Card>
      {run.error && <ErrorAlert error={run.error} />}
      <Card>
        <CardHeader title={`${LEVELS.find((l) => l.value === level)?.label} · ${r ? `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}` : ''}`} description={r?.ranges?.length ? `${r.accounts} account${r.accounts === 1 ? '' : 's'} · ${r.ranges[0].since} to ${r.ranges[0].until} in each account’s time zone` : undefined} />
        {run.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : !r || r.rows.length === 0 ? (
          <EmptyState icon={<BarChart3 className="size-6" />} title="Nothing to show">{metrics.length ? 'No synced data for this choice. Check the period and the working accounts.' : 'Tick at least one metric.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                  {(level === 'account' || level === 'campaign' || level === 'ad') && <th className="w-8 py-2 pl-5 text-right"><button onClick={() => headSort('position')}># <SortIcon k="position" /></button></th>}
                  <th className="px-3 py-2"><button onClick={() => headSort('name')}>{nameCol} <SortIcon k="name" /></button></th>
                  {(level === 'campaign' || level === 'ad') && <th className="px-2 py-2">Account</th>}
                  {level === 'ad' && <th className="px-2 py-2">Campaign</th>}
                  {(level === 'campaign' || level === 'ad') && <th className="px-2 py-2">Status</th>}
                  {r.columns.map((c: string) => <th key={c} className="px-2 py-2 text-right"><button onClick={() => headSort(c)}>{allMetrics.find((m) => m.key === c)?.label ?? c} <SortIcon k={c} /></button></th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.rows.map((row: any) => (
                  <tr key={row.key} className="hover:bg-surface-2">
                    {(level === 'account' || level === 'campaign' || level === 'ad') && <td className="py-2 pl-5 text-right text-xs text-ink-3 tabular-nums">{row.position}</td>}
                    <td className="max-w-[320px] truncate px-3 py-2 font-medium text-ink" title={row.name}>{row.name}</td>
                    {(level === 'campaign' || level === 'ad') && <td className="px-2 py-2 text-ink-2">{row.account}</td>}
                    {level === 'ad' && <td className="max-w-[200px] truncate px-2 py-2 text-ink-2" title={row.parent ?? ''}>{row.parent ?? '—'}</td>}
                    {(level === 'campaign' || level === 'ad') && <td className="px-2 py-2 text-xs text-ink-3">{row.status ?? '—'}</td>}
                    {r.columns.map((c: string) => <td key={c} className={cx('px-2 py-2 text-right tabular-nums', c === 'spend' && 'font-medium text-ink')}>{cell(allMetrics.find((m) => m.key === c)?.kind ?? 'int', row[c], row.currency)}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {r.totals.map((t: any) => (
                  <tr key={t.currency} className="border-t border-line bg-surface-2 font-medium">
                    <td className="px-3 py-2 text-ink" colSpan={1 + (level === 'account' || level === 'campaign' || level === 'ad' ? 1 : 0) + (level === 'campaign' || level === 'ad' ? 2 : 0) + (level === 'ad' ? 1 : 0)}>Total {t.currency}</td>
                    {r.columns.map((c: string) => <td key={c} className="px-2 py-2 text-right tabular-nums">{cell(allMetrics.find((m) => m.key === c)?.kind ?? 'int', t[c], t.currency)}</td>)}
                  </tr>
                ))}
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      <Modal open={saving} onClose={() => setSaving(false)} title="Save this report" footer={<><Button variant="ghost" onClick={() => setSaving(false)}>Cancel</Button><Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>Save</Button></>}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Weekly calls by account" /></Field>
        <p className="mt-2 text-xs text-ink-3">Saves the period, rows, accounts and metrics. The numbers are read fresh each time you open it.</p>
        {save.error && <div className="mt-3"><ErrorAlert error={save.error} /></div>}
      </Modal>
    </>
  );
}

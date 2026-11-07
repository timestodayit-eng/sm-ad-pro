import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { BrainCircuit, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorAlert, PageHeader, Segmented, Skeleton, cx, type Tone } from '../components/ui';
import { get, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { usePageTitle } from '../lib/session';
import { GroupPicker, useGroup } from './Live';

const PERIODS = [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: '7 days' }, { value: '14d', label: '14 days' }, { value: '30d', label: '30 days' }, { value: 'this_month', label: 'This month' }] as const;
type Period = (typeof PERIODS)[number]['value'];
const TONE: Record<string, Tone> = { critical: 'bad', warning: 'warn', info: 'info', good: 'good' };
const LABEL: Record<string, string> = { critical: 'Act now', warning: 'Look into', info: 'Note', good: 'Working well' };

export function AiAnalyticsPage() {
  usePageTitle('AI Analytics');
  const { lang } = useI18n();
  const { group, set: setGroup } = useGroup();
  const [period, setPeriod] = useState<Period>('7d');
  const q = useQuery({ queryKey: ['ai', 'findings', period, group], queryFn: () => get(`/ai/findings?period=${period}${group ? `&group=${group}` : ''}`), placeholderData: keepPreviousData, refetchInterval: 120_000 });
  const explain = useMutation({ mutationFn: () => post('/ai/findings/explain', { period, group: group ?? undefined, lang }) });
  const items: any[] = q.data?.findings ?? [];
  const bySeverity = ['critical', 'warning', 'info', 'good'].map((s) => ({ s, rows: items.filter((f) => f.severity === s) })).filter((g) => g.rows.length);

  return (
    <>
      <PageHeader title="AI Analytics" description="Findings computed from your synced Meta data, each with the numbers behind it, the likely causes and what to do. Nothing here is guessed by the model; the model only explains." />
      {q.error && <ErrorAlert error={q.error} />}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <GroupPicker group={group} onChange={setGroup} />
          <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS as any} />
        </div>
        <Button variant="secondary" icon={<Sparkles className="size-4" />} loading={explain.isPending} disabled={!items.length || q.data?.configured === false} title={q.data?.configured === false ? 'Set OPENAI_API_KEY to enable' : undefined} onClick={() => explain.mutate()}>Explain in {lang === 'bn' ? 'বাংলা' : 'English'}</Button>
      </div>
      {explain.error && <div className="mb-4"><ErrorAlert error={explain.error} /></div>}
      {explain.data?.text && <div className="mb-4"><Alert tone="info" title="What matters most"><span className="whitespace-pre-wrap">{explain.data.text}</span></Alert></div>}
      {q.isLoading ? <Skeleton className="h-64 rounded-2xl" /> : items.length === 0 ? (
        <Card><EmptyState icon={<BrainCircuit className="size-6" />} title={q.data?.accounts ? 'Nothing stands out' : 'No working accounts'}>{q.data?.accounts ? 'No spikes, stalls, expensive results, low balances or failed launches in this period.' : <Link to="/settings#working-accounts" className="text-brand hover:underline">Choose working accounts</Link>}</EmptyState></Card>
      ) : bySeverity.map((g) => (
        <Card key={g.s} className="mb-4">
          <CardHeader title={<span className="flex items-center gap-2"><Badge tone={TONE[g.s]}>{LABEL[g.s]}</Badge><span>{g.rows.length}</span></span>} />
          <ul className="divide-y divide-line">
            {g.rows.map((f) => (
              <li key={f.key} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_280px]">
                <div>
                  <div className="font-medium text-ink">{f.title}</div>
                  <p className="mt-1 text-sm text-ink-2">{f.detail}</p>
                  {f.causes?.length > 0 && <p className="mt-1 text-xs text-ink-3">Likely causes: {f.causes.join(' · ')}</p>}
                  {f.suggestion && <p className="mt-1 text-sm text-ink">→ {f.suggestion}</p>}
                  <div className="mt-2 flex items-center gap-3 text-xs">
                    <span className={cx('rounded px-1.5 py-0.5', f.confidence === 'high' ? 'bg-good-bg text-good' : f.confidence === 'medium' ? 'bg-warn-bg text-warn' : 'bg-surface-2 text-ink-3')}>confidence {f.confidence}</span>
                    {f.link && <Link to={f.link} className="font-medium text-brand hover:underline">Open →</Link>}
                  </div>
                </div>
                {Object.keys(f.evidence ?? {}).length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-surface-2 p-3 text-xs">
                    {Object.entries(f.evidence).map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-3">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd className="truncate text-right font-medium text-ink tabular-nums" title={String(v)}>{typeof v === 'number' ? v.toLocaleString('en', { maximumFractionDigits: 2 }) : String(v ?? '—')}</dd></div>)}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

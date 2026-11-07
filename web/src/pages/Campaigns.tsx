import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, Megaphone, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, CardHeader, EmptyState, ErrorAlert, Input, PageHeader, Segmented, Skeleton, cx } from '../components/ui';
import { get } from '../lib/api';
import { usePageTitle } from '../lib/session';
import { DateFilter, fmtRange, HISTORY_DAYS, periodLabel, usePeriod } from './liveControls';
import { DeliveryBadge, GroupPicker, money, num, pct, useGroup } from './Live';

const RUNNING = new Set(['ACTIVE', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']);

function Contact({ c, currency }: { c: { count: number; costPer: number | null }; currency: string }) {
  return (
    <div className="whitespace-nowrap text-right">
      <div className={cx('font-medium tabular-nums', c.count ? 'text-ink' : 'text-ink-3')}>{num(c.count)}</div>
      <div className="text-xs text-ink-3 tabular-nums">{c.costPer != null ? `${money(c.costPer, currency)} each` : '—'}</div>
    </div>
  );
}

export function CampaignsPage() {
  usePageTitle('Campaigns');
  const { period, qs, set: setPeriod } = usePeriod('today');
  const { group, set: setGroup, qs: groupQs } = useGroup();
  const [show, setShow] = useState<'running' | 'spent' | 'all'>('running');
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['live', 'campaigns', qs, group], queryFn: () => get(`/live/campaigns?${qs}${groupQs}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const d = q.data;
  const items: any[] = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (d?.items ?? []).filter(
      (c: any) =>
        (show === 'all' || (show === 'running' ? RUNNING.has(c.effectiveStatus) || c.metrics.spend > 0 : c.metrics.spend > 0)) &&
        (!f || c.name.toLowerCase().includes(f) || c.accountName.toLowerCase().includes(f)),
    );
  }, [d, show, filter]);
  const range = d?.accounts?.[0]?.range;
  const byAccount = useMemo(() => {
    const out: { id: number; name: string; accountId: string; rows: any[] }[] = [];
    for (const c of items) {
      let g = out.at(-1);
      if (!g || g.id !== c.accountRowId) out.push((g = { id: c.accountRowId, name: c.accountName, accountId: c.accountId, rows: [] }));
      g.rows.push(c);
    }
    return out;
  }, [items]);

  return (
    <>
      <PageHeader title="Campaigns" description="Every campaign in your working accounts, in your account order, with live spend and results from Meta." />
      {q.error && <ErrorAlert error={q.error} />}
      <div className="mb-4 flex flex-col gap-3">
        <DateFilter period={period} onChange={setPeriod} range={range} />
        <div className="flex flex-wrap items-center gap-3">
          <GroupPicker group={group} onChange={setGroup} />
          {range && <span className="text-sm text-ink-2">{periodLabel(period)} · <span className="tabular-nums">{fmtRange(range)}</span></span>}
          {q.isFetching && !q.isLoading && <span className="text-xs text-ink-3">Updating…</span>}
        </div>
      </div>
      {d?.accounts?.some((a: any) => a.incomplete) && (
        <div className="mb-4"><Alert tone="warn" title="Part of this range is older than the panel keeps">The panel stores the last {HISTORY_DAYS} days. Days before that are not in these numbers.</Alert></div>
      )}
      <Card>
        <CardHeader
          title={d ? `${num(items.length)} campaign${items.length === 1 ? '' : 's'}` : 'Campaigns'}
          description="Pausing, resuming and budget changes come in the next release, each with a confirm step."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                <Input className="h-9 w-56 pl-9" placeholder="Search campaigns or accounts" aria-label="Search campaigns" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <Segmented label="Which campaigns" value={show} onChange={setShow} options={[{ value: 'running', label: 'Running or spent' }, { value: 'spent', label: 'Spent' }, { value: 'all', label: 'All' }]} />
            </div>
          }
        />
        {q.isLoading ? (
          <div className="p-5"><Skeleton className="h-64" /></div>
        ) : !d?.accounts?.length ? (
          <EmptyState icon={<Megaphone className="size-6" />} title={d?.group ? `No working accounts in “${d.group.name}”` : 'No working accounts yet'} action={<Link to="/settings#working-accounts" className="text-sm font-medium text-brand hover:underline">Choose working accounts in Settings</Link>}>
            Campaigns appear here for the accounts you work with.
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-6" />} title="No campaigns match">{show !== 'all' ? 'Choose “All” to include paused campaigns with no spend.' : 'Try another search.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-5 py-3">Campaign</th>
                  <th className="px-2 py-3">Delivery</th>
                  <th className="px-2 py-3 text-right">Budget</th>
                  <th className="px-2 py-3 text-right">Spend</th>
                  <th className="px-2 py-3 text-right">Leads</th>
                  <th className="px-2 py-3 text-right">Calls</th>
                  <th className="px-2 py-3 text-right">Messages</th>
                  <th className="px-2 py-3">Results</th>
                  <th className="px-2 py-3 text-right">CTR</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              {byAccount.map((g, gi) => (
                <tbody key={g.id} className="divide-y divide-line">
                  <tr className={cx('bg-surface-2', gi > 0 && 'border-t border-line')}>
                    <td colSpan={10} className="px-5 py-2 text-xs font-semibold text-ink-2">
                      <Link to={`/live/${g.id}?${qs}${groupQs}`} className="hover:text-brand hover:underline">{g.name}</Link>
                      <span className="font-normal text-ink-3"> · act_{g.accountId} · {g.rows.length} campaign{g.rows.length === 1 ? '' : 's'}</span>
                    </td>
                  </tr>
                  {g.rows.map((c: any) => {
                    const top = c.metrics.results[0];
                    return (
                      <tr key={c.campaignId} className="hover:bg-surface-2">
                        <td className="max-w-[360px] px-5 py-3">
                          <div className="truncate font-medium text-ink" title={c.name}>{c.name}</div>
                          <div className="text-xs text-ink-3">
                            {(c.objective ?? '').replace('OUTCOME_', '').toLowerCase()} · {c.ads.active} ad{c.ads.active === 1 ? '' : 's'} running
                            {c.ads.rejected > 0 && <span className="text-bad"> · {c.ads.rejected} rejected</span>}
                          </div>
                        </td>
                        <td className="px-2 py-3"><DeliveryBadge status={c.effectiveStatus} /></td>
                        <td className="px-2 py-3 text-right tabular-nums">
                          {c.budget ? <>{money(c.budget.amount, c.currency)}<div className="text-xs text-ink-3">{c.budget.kind}{c.budget.level === 'adset' ? ', ad sets' : ''}</div></> : '—'}
                        </td>
                        <td className="px-2 py-3 text-right font-medium text-ink tabular-nums">{money(c.metrics.spend, c.currency)}</td>
                        <td className="px-2 py-3"><Contact c={c.metrics.contacts.leads} currency={c.currency} /></td>
                        <td className="px-2 py-3"><Contact c={c.metrics.contacts.calls} currency={c.currency} /></td>
                        <td className="px-2 py-3"><Contact c={c.metrics.contacts.messages} currency={c.currency} /></td>
                        <td className="px-2 py-3 whitespace-nowrap">
                          {top ? <><div className="font-medium text-ink tabular-nums">{num(top.count)} <span className="text-xs font-normal text-ink-3">{top.label.toLowerCase()}</span></div><div className="text-xs text-ink-3 tabular-nums">{top.costPer != null ? `${money(top.costPer, c.currency)} each` : 'no results yet'}</div></> : <span className="text-ink-3">—</span>}
                        </td>
                        <td className="px-2 py-3 text-right tabular-nums">{pct(c.metrics.ctr)}</td>
                        <td className="px-5 py-3 text-right">
                          <a
                            href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${c.accountId}&selected_campaign_ids=${c.campaignId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-brand hover:underline"
                          >
                            Ads Manager <ExternalLink className="size-3" />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

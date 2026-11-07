import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Landmark, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, CardHeader, EmptyState, ErrorAlert, PageHeader, Segmented, Skeleton, StatCard, cx, timeAgo } from '../components/ui';
import { get } from '../lib/api';
import { usePageTitle } from '../lib/session';
import { GroupPicker, money, plural, useGroup } from './Live';

function DaysLeft({ b }: { b: any }) {
  if (b.daysLeft == null) {
    const why = b.remaining == null ? (b.kind === 'postpaid' ? 'Billed later, no limit set' : 'Balance not shown by Meta') : 'No spend in the last 7 days';
    return <span className="text-xs text-ink-3">{why}</span>;
  }
  const tone = b.low || b.daysLeft < 1 ? 'bad' : b.daysLeft < 3 ? 'warn' : 'good';
  return (
    <div className="text-right">
      <Badge tone={tone}>{b.daysLeft < 1 ? 'Under a day' : `${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'}`}</Badge>
      <div className="mt-0.5 text-xs text-ink-3">{b.limitedBy === 'spend_cap' ? 'until the spending limit' : 'of funds'}</div>
    </div>
  );
}

export function BalancePage() {
  usePageTitle('Balance');
  const { group, set: setGroup, qs } = useGroup();
  const [order, setOrder] = useState<'mine' | 'low'>('mine');
  const q = useQuery({ queryKey: ['live', 'balances', group], queryFn: () => get(`/live/balances?${qs.slice(1)}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const items: any[] = q.data?.items ?? [];
  const rows = order === 'mine' ? items : [...items].sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
  const currencies = [...new Set(items.map((i) => i.currency))];
  const low = items.filter((i) => i.low || (i.daysLeft != null && i.daysLeft < 1));
  const unknown = items.filter((i) => i.remaining == null && i.kind !== 'postpaid');

  return (
    <>
      <PageHeader title="Balance" description="How much money is left in each working account, in your account order, and how long it lasts at the current spend. Read from Meta on every sync." />
      {q.error && <ErrorAlert error={q.error} />}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <GroupPicker group={group} onChange={setGroup} />
        <Segmented label="Order" value={order} onChange={setOrder} options={[{ value: 'mine', label: 'My order' }, { value: 'low', label: 'Fewest days first' }]} />
      </div>

      {q.isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : items.length === 0 ? (
        <Card><EmptyState icon={<Wallet className="size-6" />} title="No working accounts" action={<Link to="/settings#working-accounts" className="text-sm font-medium text-brand hover:underline">Choose working accounts</Link>}>The balance of your working accounts shows here.</EmptyState></Card>
      ) : (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {currencies.map((c) => {
              const mine = items.filter((i) => i.currency === c);
              const total = mine.reduce((n, i) => n + (i.remaining ?? 0), 0);
              const daily = mine.reduce((n, i) => n + (i.avgDailySpend ?? 0), 0);
              return <StatCard key={c} label={`Money left · ${c}`} value={money(total, c)} icon={<Wallet className="size-4" />} sub={`${plural(mine.filter((i) => i.remaining != null).length, 'account')} with a balance or limit · ${money(daily, c)} a day`} />;
            })}
            <StatCard label="Running low" value={plural(low.length, 'account')} icon={<AlertTriangle className="size-4" />} tone={low.length ? 'warn' : undefined} sub={low.length ? low.slice(0, 3).map((i) => i.name).join(', ') + (low.length > 3 ? '…' : '') : 'Set the alert in Settings → Cost alerts'} />
          </div>
          {unknown.length > 0 && (
            <div className="mb-4">
              <Alert tone="info" title={`${plural(unknown.length, 'account')} without a readable balance`}>
                Meta did not include the available balance in its payment details for these accounts. The amount is shown as Meta writes it; check the billing page if it looks wrong.
              </Alert>
            </div>
          )}
          <Card>
            <CardHeader title={q.data?.group ? `Accounts in “${q.data.group.name}”` : 'Your accounts'} description="Days left = money left ÷ the average daily spend of the last 7 full days." />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                    <th className="w-10 py-3 pl-5 text-right">#</th>
                    <th className="px-3 py-3">Account</th>
                    <th className="px-2 py-3">Payment</th>
                    <th className="px-2 py-3 text-right">Available funds</th>
                    <th className="px-2 py-3 text-right">Spending limit left</th>
                    <th className="px-2 py-3 text-right">Owed</th>
                    <th className="px-2 py-3 text-right">Spend a day (7d)</th>
                    <th className="px-2 py-3 text-right">Spent today</th>
                    <th className="px-2 py-3 text-right">Days left</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((b) => (
                    <tr key={b.id} className={cx('hover:bg-surface-2', (b.low || (b.daysLeft != null && b.daysLeft < 1)) && 'bg-bad-bg/40')}>
                      <td className="py-3 pl-5 text-right text-xs text-ink-3 tabular-nums">{items.indexOf(b) + 1}</td>
                      <td className="min-w-[200px] px-3 py-3">
                        <Link to={`/live/${b.id}`} className="font-medium text-ink hover:text-brand hover:underline">{b.name}</Link>
                        <div className="text-xs text-ink-3">act_{b.accountId} · {b.currency}{b.accountStatus !== 1 && <span className="text-bad"> · account not active</span>}</div>
                      </td>
                      <td className="max-w-[220px] px-2 py-3">
                        <div className="text-ink">{b.kind === 'prepaid' ? 'Prepaid' : b.kind === 'postpaid' ? 'Pay later (card or invoice)' : '—'}</div>
                        {b.paymentMethod && <div className="truncate text-xs text-ink-3" title={b.paymentMethod}>{b.paymentMethod}</div>}
                        {b.error && <div className="truncate text-xs text-bad" title={b.error}>Could not read: {b.error}</div>}
                      </td>
                      <td className="px-2 py-3 text-right font-medium text-ink tabular-nums">{b.available != null ? money(b.available, b.currency) : '—'}</td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {b.capLeft != null ? <>{money(b.capLeft, b.currency)}<div className="text-xs text-ink-3">of {money(b.spendCap, b.currency)}</div></> : <span className="text-ink-3">No limit</span>}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">{b.owed != null ? money(b.owed, b.currency) : '—'}</td>
                      <td className="px-2 py-3 text-right tabular-nums">{money(b.avgDailySpend, b.currency)}</td>
                      <td className="px-2 py-3 text-right tabular-nums">{money(b.spentToday, b.currency)}</td>
                      <td className="px-2 py-3"><DaysLeft b={b} /></td>
                      <td className="px-5 py-3 text-right">
                        <a href={`https://business.facebook.com/billing_hub/accounts/details?asset_id=${b.accountId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-brand hover:underline">
                          Billing <ExternalLink className="size-3" />
                        </a>
                        <div className="mt-0.5 whitespace-nowrap text-[11px] text-ink-3">{b.checkedAt ? `checked ${timeAgo(b.checkedAt)}` : 'not checked yet'}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-start gap-2 border-t border-line px-5 py-3 text-xs text-ink-3">
              <Landmark className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Prepaid funds come from the payment details Meta shows for the account. “Owed” is what a pay-later account will be billed next. The spending limit is the account limit you set in Meta.
                Get a notification before money runs out under <Link to="/settings" className="text-brand hover:underline">Settings → Cost alerts → Low balance (days)</Link>. Add funds on Meta’s billing page.
              </span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Briefcase, ListOrdered, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Card, CardHeader, EmptyState, ErrorAlert, Skeleton } from '../components/ui';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import { AccountOrderEditor, type OrderAccount } from './AccountOrder';

/** Settings → Working accounts: the accounts the whole panel works with, in the team's order. */
export function WorkingAccountsCard() {
  const { can } = useSession();
  const loc = useLocation();
  const q = useQuery({ queryKey: ['account-order'], queryFn: () => get<{ items: OrderAccount[] }>('/accounts/order') });
  const [arranging, setArranging] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (loc.hash === '#working-accounts') document.getElementById('working-accounts')?.scrollIntoView({ block: 'start' });
  }, [loc.hash, q.isSuccess]);
  const items = q.data?.items ?? [];
  const shown = all ? items : items.slice(0, 15);
  const manage = can('accounts.manage');
  return (
    <div id="working-accounts" className="scroll-mt-20">
      <Card>
        <CardHeader
          title="Working accounts"
          icon={<Briefcase className="size-4" />}
          description="The ad accounts this panel works with. The dashboard, Campaigns, groups and alerts only show these, in this order. Later, publishing and budget changes follow the same order."
          actions={
            manage && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<ListOrdered className="size-3.5" />} disabled={items.length < 2} onClick={() => setArranging(true)}>Arrange order</Button>
                <Link to="/accounts?pick=1"><Button size="sm" icon={<Plus className="size-3.5" />}>Add or remove accounts</Button></Link>
              </div>
            )
          }
        />
        {q.error && <div className="px-5 pb-4"><ErrorAlert error={q.error} /></div>}
        {q.isLoading ? <div className="p-5"><Skeleton className="h-24" /></div> : items.length === 0 ? (
          <EmptyState icon={<Briefcase className="size-6" />} title="No working accounts yet" action={manage ? <Link to="/accounts?pick=1"><Button>Choose accounts</Button></Link> : undefined}>
            Choose the ad accounts you work with. You only do this once; add more here whenever you need.
          </EmptyState>
        ) : (
          <>
            <ol className="grid gap-x-6 px-5 pb-4 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((a, i) => (
                <li key={a.id} className="flex min-w-0 items-baseline gap-2 border-b border-line py-2 text-sm">
                  <span className="w-6 shrink-0 text-right text-xs text-ink-3 tabular-nums">{i + 1}</span>
                  <span className="truncate text-ink" title={`${a.name} · act_${a.accountId}`}>{a.name}</span>
                </li>
              ))}
            </ol>
            {items.length > 15 && (
              <div className="px-5 pb-4">
                <button className="text-sm font-medium text-brand hover:underline" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>
              </div>
            )}
          </>
        )}
      </Card>
      <AccountOrderEditor open={arranging} onClose={() => setArranging(false)} />
    </div>
  );
}

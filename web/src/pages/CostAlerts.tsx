import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, CardHeader, EmptyState, ErrorAlert, Input, Skeleton } from '../components/ui';
import { get, put } from '../lib/api';
import { useSession } from '../lib/session';

const COLS: { key: string; label: string; hint: string }[] = [
  { key: 'daily_spend_limit', label: 'Daily spend', hint: 'Alert when the account spends more than this today' },
  { key: 'max_cost_per_lead', label: 'Cost per lead', hint: 'For campaigns getting leads' },
  { key: 'max_cost_per_call', label: 'Cost per call', hint: 'For call campaigns' },
  { key: 'max_cost_per_message', label: 'Cost per message', hint: 'For messaging campaigns' },
  { key: 'max_cost_per_result', label: 'Cost per result', hint: 'Any campaign, using its objective result' },
  { key: 'min_spend', label: 'Check after spend of', hint: 'Do not judge cost per result until a campaign has spent this much today' },
];

type Limits = Record<string, number | null>;

function LimitRow({ title, sub, currency, limits, inherit, onSave }: { title: string; sub?: string; currency: string; limits: Limits; inherit?: Limits; onSave: (l: Limits) => Promise<unknown> }) {
  const { can } = useSession();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => setVals(Object.fromEntries(COLS.map((c) => [c.key, limits[c.key] != null ? String(limits[c.key]) : '']))), [limits]);
  const save = useMutation({
    mutationFn: () => onSave(Object.fromEntries(COLS.map((c) => [c.key, vals[c.key]?.trim() === '' ? null : Number(vals[c.key])]))),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });
  const invalid = COLS.some((c) => vals[c.key]?.trim() && !(Number(vals[c.key]) >= 0));
  const dirty = COLS.some((c) => (vals[c.key] ?? '') !== (limits[c.key] != null ? String(limits[c.key]) : ''));
  return (
    <tr className="align-top">
      <td className="px-5 py-3">
        <div className="font-medium text-ink">{title}</div>
        {sub && <div className="text-xs text-ink-3">{sub}</div>}
      </td>
      {COLS.map((c) => {
        const inherited = inherit?.[c.key];
        return (
          <td key={c.key} className="px-2 py-3">
            <Input
              inputMode="decimal"
              aria-label={`${title}: ${c.label} (${currency})`}
              className="h-9 w-[8.5rem] tabular-nums"
              disabled={!can('accounts.manage')}
              placeholder={inherit ? (inherited ? `${inherited} default` : 'default off') : 'off'}
              value={vals[c.key] ?? ''}
              onChange={(e) => setVals((v) => ({ ...v, [c.key]: e.target.value }))}
            />
          </td>
        );
      })}
      <td className="px-5 py-3 text-right">
        {can('accounts.manage') && (
          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || invalid} loading={save.isPending} icon={saved ? <Check className="size-3.5" /> : undefined} onClick={() => save.mutate()}>
            {saved ? 'Saved' : 'Save'}
          </Button>
        )}
        {save.error && <div className="mt-1 text-xs text-bad">{(save.error as Error).message}</div>}
      </td>
    </tr>
  );
}

export function CostAlertsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cost-settings'], queryFn: () => get('/alerts/cost-settings') });
  const saveDefault = (currency: string) => (limits: Limits) => put('/alerts/cost-settings', { scope: 'default', currency, limits }).then(() => qc.invalidateQueries({ queryKey: ['cost-settings'] }));
  const saveAccount = (accountId: number) => (limits: Limits) => put('/alerts/cost-settings', { scope: 'account', accountId, limits }).then(() => qc.invalidateQueries({ queryKey: ['cost-settings'] }));
  const d = q.data;
  return (
    <Card>
      <CardHeader
        title="Cost alerts"
        icon={<BellRing className="size-4" />}
        description="Get a notification when an account spends too much today, or a campaign’s cost per lead, call, message or result goes above your limit. Checked after every sync, about every 15 minutes, once per campaign per day."
      />
      {q.error && <div className="p-4"><ErrorAlert error={q.error} /></div>}
      {q.isLoading ? (
        <div className="p-5"><Skeleton className="h-24" /></div>
      ) : !d?.accounts.length ? (
        <EmptyState icon={<BellRing className="size-6" />} title="No accounts on the dashboard yet" action={<Link to="/accounts?pick=1"><Button>Choose accounts</Button></Link>}>
          Alerts work on the accounts you manage. Turn some on first.
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="px-5 py-3">Applies to</th>
                  {COLS.map((c) => <th key={c.key} className="px-2 py-3" title={c.hint}>{c.label}</th>)}
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.defaults.map((df: any) => (
                  <LimitRow key={`d-${df.currency}`} title={`Default for ${df.currency} accounts`} sub="Used by every account below unless it sets its own" currency={df.currency} limits={df.limits} onSave={saveDefault(df.currency)} />
                ))}
                {d.accounts.map((a: any) => (
                  <LimitRow
                    key={a.id}
                    title={a.name}
                    sub={`act_${a.accountId} · ${a.currency}`}
                    currency={a.currency}
                    limits={a.limits}
                    inherit={d.defaults.find((x: any) => x.currency === a.currency)?.limits}
                    onSave={saveAccount(a.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
            Amounts are in each account’s currency. Leave a box empty to use the default (or no alert on the default row). Enter 0 on an account to switch that alert off for it. Alerts appear under Notifications; Telegram and WhatsApp delivery comes next.
          </p>
        </>
      )}
    </Card>
  );
}
